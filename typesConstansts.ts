export const locs = {
  stackBegin: Symbol('stackBegin'),
  ramPointer: Symbol('ramPointer'),
  builtinScopeSym: Symbol('builtInScope'),
  globalScopeSym: Symbol('globalScope'),
  allocateScopeSym: Symbol('allocateScope'),
  ramBegin: 1000000n,
}

export type CompilationContext = {
  scope: FintScope,
  meta: FintMeta,
}

// used to represent operations that can be precalculated at compile time
export class Reducible {
  constructor(
    public dependents: CompileData[],
    public reducer: (val: bigint[]) => bigint,
    public labels: symbol[],
  ){
    if(dependents.some(dep => typeof dep === 'object' && dep.labels.length))
      throw new Error('A reducible argument cannot be pointed to');
  }
}
export class HangingLabel {
  public labels: symbol[];
  constructor(label: symbol){
    this.labels = [label]; // easier to polymorphic with other options
  }
}
export type CompileData = number | bigint | symbol | { value: number | bigint | symbol, labels: symbol[] } | Reducible | HangingLabel;

export enum FintTypes {
  Int = 0,
  FunctionDef = 1,
  FunctionInstance = 2,
  Scope = 3,
  Tuple = 4,
  None = 99,
}

export class FintMeta {
  constructor(
    public line: number,
    public column: number,
    public indent: number,
    public startOfLine: boolean,
  ){}
}

export class FintScope {
  private readonly values: string[];
  constructor(public readonly parent?: FintScope, private location?: symbol){
    this.values = [];
  }
  
  get(key: string): {up: number, forward: number} | { location: symbol, forward: number } | undefined {
    const index = this.values.indexOf(key);
    if(index !== -1) {
      if(this.location) return {location: this.location, forward: index};
      return {up: 0, forward: index};
    }
    if(!this.parent) return undefined;
    const parentReponse = this.parent.get(key);
    if(!parentReponse) return undefined;
    if('location' in parentReponse) return parentReponse;
    return {up: parentReponse.up + 1, forward: parentReponse.forward};
  }

  add(key: string){
    this.values.push(key);
  }
}

export const builtinScope = new FintScope(undefined, locs.builtinScopeSym);

