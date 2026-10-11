import type { CommentTrivia, Token } from "./lexer";

export interface Span {
    start: number;
    end: number;
}

/** An identifier occurrence. */
export interface Name extends Span {
    text: string;
}

/** A string literal used as a name (nodes, blocks, controls, images). */
export interface StringName extends Span {
    value: string;
}

export type FileKind = "ags" | "irs" | "agm" | "irm" | "gem";

// ---------------------------------------------------------------- expressions

export type Expr =
    | (Span & { kind: "number"; text: string })
    | (Span & { kind: "string"; value: string; fib: boolean; interpolations: Expr[] })
    | (Span & { kind: "concat"; parts: Expr[] })
    | (Span & { kind: "literal"; value: "true" | "false" | "null" })
    | (Span & { kind: "name"; qualifier: Name[]; name: Name; typeArgs?: TypeRef[] })
    | (Span & { kind: "attr"; name: Name })
    | (Span & { kind: "member"; object: Expr; name: Name })
    | (Span & { kind: "index"; object: Expr; index: Expr })
    | (Span & { kind: "call"; callee: Expr; args: Arg[]; open: number; close: number })
    | (Span & { kind: "unary"; op: string; operand: Expr })
    | (Span & { kind: "binary"; op: string; left: Expr; right: Expr })
    | (Span & { kind: "paren"; expr: Expr })
    | (Span & { kind: "new"; type: TypeRef; args: Arg[] })
    | (Span & { kind: "coerce"; expr: Expr; type: Name })
    | (Span & { kind: "skip" })
    | (Span & { kind: "error" });

export interface Arg extends Span {
    expr: Expr;
    mode?: "ref" | "out";
}

// ---------------------------------------------------------------- types

export type TypeRef =
    | (Span & { kind: "named"; qualifier: Name[]; name: Name; args?: number[]; typeArgs?: TypeRef[] })
    | (Span & { kind: "array"; size?: Expr; element: TypeRef })
    | (Span & { kind: "record"; fields: VariableDecl[] })
    | (Span & { kind: "enumeration"; members: EnumMember[]; definedIn?: Expr })
    | (Span & { kind: "error" });

export interface EnumMember extends Span {
    name: Name;
    label?: Expr;
    value?: Expr;
}

// ---------------------------------------------------------------- statements

export interface Block extends Span {
    statements: Stmt[];
}

/** One value captured by an action template slot. */
export interface SlotValue {
    placeholder: string;
    /** Keyword that precedes the slot, used to give the slot a role (cursor, event, node...). */
    after?: string;
    cls: "expr" | "var" | "id";
    expr: Expr;
}

export type Stmt =
    | (Span & { kind: "if"; cond: Expr; then: Block; else?: Block | Stmt })
    | (Span & { kind: "case"; expr: Expr; whens: { value: Expr; body: Block }[]; default?: Block })
    | (Span & { kind: "while"; cond: Expr; body: Block })
    | (Span & { kind: "repeat"; body: Block; cond: Expr })
    | (Span & { kind: "for"; variable: Expr; from: Expr; to: Expr; step?: Expr; body: Block })
    | (Span & { kind: "var"; decl: VariableDecl })
    | (Span & { kind: "const"; decl: ConstantDecl })
    | (Span & { kind: "assign"; target: Expr; value: Expr })
    | (Span & { kind: "call"; callee: Expr; args: Arg[] })
    | (Span & { kind: "goto"; mode: "goto" | "call"; target: Expr; args: Expr[] })
    | ActionStmt
    | (Span & { kind: "error" });

export interface ActionStmt extends Span {
    kind: "action";
    /** Index into the action catalogue, or -1 for built-in statements (return, back node...). */
    action: number;
    /** Normalised leading words, e.g. "open window". */
    words: string;
    keywords: Span[];
    slots: SlotValue[];
    blocks: Block[];
    /** Clauses written inside `{ }` (for example the lines of `set font { ... }`). */
    children?: ControlClause[];
}

// ---------------------------------------------------------------- declarations

export interface VariableDecl extends Span {
    kind: "variable";
    name: Name;
    type?: TypeRef;
    init?: Expr;
    isPrivate: boolean;
    isRef: boolean;
    check?: Expr;
    required?: boolean;
    comment?: string;
}

export interface ConstantDecl extends Span {
    kind: "constant";
    name: Name;
    value?: Expr;
    isPrivate: boolean;
    comment?: string;
}

export interface TypeDecl extends Span {
    kind: "type";
    name: Name;
    type: TypeRef;
    isPrivate: boolean;
    comment?: string;
}

export interface CursorDecl extends Span {
    kind: "cursor";
    name: Name;
    cursorKind: string;
    source?: Expr;
    slots: SlotValue[];
    isPrivate: boolean;
    comment?: string;
}

export interface ExtensionRecordDecl extends Span {
    kind: "extensionRecord";
    name: Name;
    directory?: Expr;
    fields: VariableDecl[];
}

export type SectionKind =
    | "constants"
    | "variables"
    | "parameters"
    | "types"
    | "cursors"
    | "campaign record"
    | "contact record"
    | "workflow record"
    | "transferred record"
    | "outcome record"
    | "contact profile extensions"
    | "audio";

export interface Section extends Span {
    kind: "section";
    section: SectionKind;
    keyword: Span;
    items: (VariableDecl | ConstantDecl | TypeDecl | CursorDecl | ExtensionRecordDecl)[];
}

export interface ImportDecl extends Span {
    kind: "import";
    path: StringName;
    namespace?: Name;
    isPrivate: boolean;
    defaultMaster?: StringName;
}

export interface Dependency extends Span {
    kind: "dependency";
    dependencyKind: "image" | "dll" | "file" | "web service";
    dllKind?: "native" | "managed";
    name?: StringName;
    file?: Expr;
    isPrivate: boolean;
}

export interface UsingNamespace extends Span {
    path: Name[];
    alias?: Name;
}

export interface Param extends Span {
    name: Name;
    type?: TypeRef;
    isRef: boolean;
    cType?: string;
}

export interface RoutineDecl extends Span {
    kind: "routine";
    routine: "subroutine" | "function";
    name: Name;
    params: Param[];
    hasParens: boolean;
    returnType?: TypeRef;
    body?: Block;
    isPrivate: boolean;
    external?: { library?: Expr; session: boolean; convention?: string };
    comment?: string;
}

export interface HandlerDecl extends Span {
    kind: "handler";
    /** Normalised event words after `on`, e.g. "enter", "event phone connected", "click". */
    event: string;
    eventSpan: Span;
    /** event | error | progress for node event handlers. */
    eventKind?: "event" | "error" | "progress";
    /** User-defined event name for `on event Name(...)`. */
    userEvent?: Name;
    params: Param[];
    modifier?: "commit" | "rollback" | "ignore";
    body: Block;
}

export interface NodeDecl extends Span {
    kind: "node" | "block";
    name: StringName;
    keyword: Span;
    isPrivate: boolean;
    id?: Expr;
    master?: { name: Expr; args: Expr[]; span: Span };
    withoutMaster: boolean;
    members: Decl[];
    comment?: string;
}

export interface ControlClause extends Span {
    words: string;
    keywords: Span[];
    slots: SlotValue[];
    children: ControlClause[];
}

export interface ControlDecl extends Span {
    kind: "control";
    control: string;
    keyword: Span;
    name?: StringName;
    target?: Expr;
    clauses: ControlClause[];
    handlers: HandlerDecl[];
    /** Geometry from `size W,H at X,Y`, used by layout rules. */
    size?: { width: number; height: number; x?: number; y?: number };
}

export interface ExitPointDecl extends Span {
    kind: "exitPoint";
    name: Name;
    body: Block;
}

export interface ClauseDecl extends Span {
    kind: "clause";
    words: string;
    keyword: Span;
    args: Expr[];
    /** Nested clauses inside `{ }` (for example the lines of `default font { ... }`). */
    children?: ControlClause[];
}

export interface ModulesDecl extends Span {
    kind: "modules";
    imports: ImportDecl[];
}

export interface DependenciesDecl extends Span {
    kind: "dependencies";
    items: Dependency[];
}

export interface UsingDecl extends Span {
    kind: "using";
    items: UsingNamespace[];
}

export interface FunctionKeyDecl extends Span {
    kind: "functionKey";
    key?: Expr;
    body: Block;
}

export interface NodeLoopDecl extends Span {
    kind: "nodeLoop";
    body: Block;
}

export type Decl =
    | Section
    | ModulesDecl
    | DependenciesDecl
    | UsingDecl
    | RoutineDecl
    | HandlerDecl
    | NodeDecl
    | ControlDecl
    | ExitPointDecl
    | ClauseDecl
    | FunctionKeyDecl
    | NodeLoopDecl;

export interface ParseDiagnostic extends Span {
    message: string;
    severity: "error" | "warning";
    code: string;
}

export interface SourceFile {
    fileKind: FileKind;
    text: string;
    decls: Decl[];
    tokens: Token[];
    comments: CommentTrivia[];
    diagnostics: ParseDiagnostic[];
    trailerStart?: number;
}
