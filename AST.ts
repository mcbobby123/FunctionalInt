import { CompileData, CompilationContext, FintScope, FintMeta, HangingLabel, locs } from './typesConstansts.ts';
import { ops, ptr, abs, stack, addLabel, resolvePtr, writeToRam, addArgs, absToPtr, resolveRef, stackToPtr } from './macros.ts';

type CompileReturn = {
  immediate: CompileData[], 
  memory: CompileData[]
};

export abstract class FintASTConstruct {
  constructor(public scope: FintScope, public meta: FintMeta){}

  abstract compile(context: CompilationContext): CompileReturn
}

export abstract class FintValue extends FintASTConstruct {}

export class FintNumberLiteral extends FintValue {
  constructor(scope: FintScope, meta: FintMeta, public value: bigint){
    super(scope, meta);
  }

  compile(context: CompilationContext): CompileReturn {
    const memLoc = Symbol('intMemoryLocation')
    return {
      immediate: [
        ...ops.copy(abs(this.value), stack(0)),
      ],
      memory: [],
    }
  }
}

export class FintVariableReference extends FintValue {
  static instances: FintVariableReference[] = [];

  constructor(scope: FintScope, meta: FintMeta, public name: string){
    super(scope, meta);
    FintVariableReference.instances.push(this);
  }

  compile(context: CompilationContext): CompileReturn {
    return {
      immediate: [
        ...ops.copy(resolvePtr(resolveRef(this.name)), stack(0), context)
      ],
      memory: [],
    }
  }
}

export class FintTuple extends FintValue {
  constructor(scope: FintScope, meta: FintMeta, public values: FintValue[]){
    super(scope, meta);
  }

  compile(context: CompilationContext): CompileReturn {
    const compiled = this.values.map(v => v.compile(context));
    return {
      immediate: [
        ...ops.copy(stack(-2), stack(0)), // copy stack pointer
        ...ops.moveStack(2),
        ...ops.copy(ptr(locs.ramPointer), stack(-1)), // save tuple location
        ...ops.addTo(abs(this.values.length + 1), ptr(locs.ramPointer)), // allocate space for values
        ...ops.copy(abs(this.values.length), stackToPtr(stack(-1))), // write length
        ...compiled.flatMap((c, i) => {
          return [
            ...c.immediate,
            ...ops.copy(stack(0), addArgs(abs(i + 1), stackToPtr(stack(-1)))), // write into the tuple
          ];
        }),
        ...ops.moveStack(-2),
        ...ops.copy(stack(1), stack(0)),
      ],
      memory: compiled.flatMap(c => c.memory),
    }
  }
}

export class FintCall extends FintValue {
  constructor(scope: FintScope, public fn: FintValue, public arg: FintValue){
    super(scope, fn.meta);
  }

  compile(context: CompilationContext): CompileReturn {

    const forwardMemory = [];

    const resumeLoc = Symbol('funcCall');

    return {
      immediate: [
        ...ops.copy(stack(-2), stack(1)),
        ...ops.moveStack(3),
        // fn instance ptr will go in stack-3
        // scope is in stack-2
        // arg ptr will do in stack-1

        // evaluate function (returns func instance pointer)
        ...(()=>{
          const subContext: CompilationContext = {
            meta: this.fn.meta,
            scope: this.fn.scope,
          }
          const {immediate, memory} = this.fn.compile(subContext);
          forwardMemory.push(...memory);
          return immediate;
        })(),
        ...ops.copy(stack(0), stack(-3)),

        // evaluate argument (returns func arg pointer)
        ...(()=>{
          const subContext: CompilationContext = {
            meta: this.arg.meta,
            scope: this.arg.scope,
          }
          const {immediate, memory} = this.arg.compile(subContext);
          forwardMemory.push(...memory);
          return immediate;
        })(),
        ...ops.copy(stack(0), stack(-1)),

        // create scope in stack+0
        ...ops.copy(ptr(locs.ramPointer), stack(0)),
        ...writeToRam(addArgs(stack(-3), ptr(1))), // parent scope
        ...writeToRam(stack(-1)), // arg pointer

        // copy return location to stack+1
        ...ops.copy(abs(resumeLoc), stack(1)),

        ...ops.jump(resolvePtr(stackToPtr(stack(-3)))),

        new HangingLabel(resumeLoc),
        // restore stack location
        ...ops.moveStack(-3),
        // copy return value to stack+0
        ...ops.copy(stack(3), stack(0)),
      ],
      memory: forwardMemory,
    }
  }
}

export class FintAssignment extends FintASTConstruct {
  constructor(
    scope: FintScope, 
    public ref: FintVariableReference, 
    public value: FintValue,
    public wheres: FintAssignment[],
  ){
    super(scope, ref.meta);
  }

  compile(context: CompilationContext): CompileReturn {
    const continueLoc = Symbol(`fintAssignment-${this.ref.name}`);

    // variables from evaluations that need to be passed on
    const forwardMemory: CompileData[] = [
      addLabel(this.scope.parent!.location!, this.scope.location!),
      ...this.wheres.map(() => 0),
    ];

    const mainContext: CompilationContext = {
      meta: this.value.meta,
      scope: this.value.scope,
    }

    const main = this.value.compile(mainContext);
    forwardMemory.push(...main.memory);
    return {
      immediate: [
        // create scope
        ...ops.copy(abs(this.wheres.length), stack(0), context), // # of things to allocate
        ...ops.copy(stack(-2), stack(1), context), // parent scope
        ...ops.copy(abs(continueLoc), stack(2), context), // continue location
        ...ops.jump(abs(locs.allocateScopeSym)),

        new HangingLabel(continueLoc),
        
        ...ops.moveStack(2), // constucted scope is now at stack-2
        // define wheres
        ...this.wheres.flatMap(where => {
          const {immediate, memory} = where.compile(mainContext);
          forwardMemory.push(...memory);
          return [
            ...immediate,
            ...ops.copy(stack(0), resolveRef(where.ref.name), mainContext), // copy the return value into the scope
          ]
        }),

        // execute main
        ...main.immediate,

        // move stack back and set return value
        ...ops.moveStack(-2),
        ...ops.copy(stack(2), stack(0)),
      ],
      memory: forwardMemory,
    }
  }
}

export class FintFunct extends FintValue {
  constructor(scope: FintScope, public arg: FintVariableReference, public body: FintValue){
    super(scope, arg.meta);
  }

  compile(context: CompilationContext): CompileReturn {
    const defLoc = Symbol('funcDefLoc');

    const subContext: CompilationContext = {
      meta: this.meta,
      scope: this.body.scope,
    }
    const body = this.body.compile(subContext);

    return {
      immediate: [
        // create inner function instance to return
        ...ops.copy(ptr(locs.ramPointer), stack(0)),
        ...writeToRam(abs(defLoc)), // inner function def address
        ...writeToRam(stack(-2)), // scope
      ],
      memory: [
        new HangingLabel(defLoc),
        ...ops.moveStack(2),
  
        ...body.immediate,
  
        // end of function
        ...ops.moveStack(-2),
        ...ops.copy(stack(2), stack(0)), // pointer to var
        ...ops.jump(stack(1)),

        // any extra stuff generated
        ...body.memory,
      ],
    }
  }
}

export class FintWrappedValue extends FintValue {
  constructor(scope: FintScope, public arg: FintValue, meta?: FintMeta){
    super(scope, meta ?? arg.meta);
  }

  compile(context: CompilationContext): CompileReturn {
    return this.arg.compile(context);
  }

  unwrap(): FintValue {
    if(this.arg instanceof FintWrappedValue) return this.arg.unwrap();
    return this.arg;
  }
}
