// Minimal stand-in for the "vscode" module so the ASL parser can run under
// plain Node (test harness). Only the surface aslParser.ts touches.

export class Position {
    public constructor(public readonly line: number, public readonly character: number) {}

    public isBefore(other: Position): boolean {
        return this.line < other.line || (this.line === other.line && this.character < other.character);
    }

    public isAfter(other: Position): boolean {
        return other.isBefore(this);
    }

    public isEqual(other: Position): boolean {
        return this.line === other.line && this.character === other.character;
    }
}

export class Range {
    public readonly start: Position;
    public readonly end: Position;

    public constructor(startLine: number | Position, startCharacter: number | Position, endLine?: number, endCharacter?: number) {
        if (typeof startLine === "number") {
            this.start = new Position(startLine, startCharacter as number);
            this.end = new Position(endLine as number, endCharacter as number);
        } else {
            this.start = startLine;
            this.end = startCharacter as Position;
        }
    }

    public contains(position: Position): boolean {
        return !position.isBefore(this.start) && !this.end.isBefore(position);
    }
}

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3
}

export interface TextLine {
    text: string;
    lineNumber: number;
    range: Range;
}

export interface TextDocument {
    uri: { toString(): string };
    version: number;
    lineCount: number;
    lineAt(line: number): TextLine;
}

export function createTextDocument(filePath: string, content: string): TextDocument {
    const lines = content.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
    return {
        uri: { toString: () => `file:///${filePath.replace(/\\/g, "/")}` },
        version: 1,
        lineCount: lines.length,
        lineAt: (line: number) => {
            const text = lines[line] ?? "";
            return { text, lineNumber: line, range: new Range(line, 0, line, text.length) };
        }
    };
}
