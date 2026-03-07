import * as vscode from "vscode";
import {
    ALL_EVENT_NAMES,
    ALL_PROPERTY_NAMES,
    CONTROL_DEFINITIONS,
    CONTROL_NAMES_BY_LENGTH,
    SECTION_NAMES,
    AslControlDefinition,
    AslSymbolKindName,
    findControlDefinition,
    normalizeAslName
} from "./aslData";

export interface AslSymbol {
    name: string;
    kind: AslSymbolKindName;
    detail?: string;
    scopeKey: string;
    anonymous?: boolean;
    range: vscode.Range;
    selectionRange: vscode.Range;
    children: AslSymbol[];
}

export interface AslReference {
    name: string;
    kind: "node" | "variable" | "cursor" | "namespace" | "type";
    range: vscode.Range;
}

export interface AslIssue {
    message: string;
    severity: vscode.DiagnosticSeverity;
    range: vscode.Range;
}

export interface AslContextFrame {
    kind: string;
    name?: string;
    control?: string;
}

export interface AslControlUsage {
    control: string;
    name?: string;
    targetName?: string;
    targetKind?: "variable" | "cursor";
    range: vscode.Range;
    properties: Set<string>;
}

export interface AslAnalysis {
    symbols: AslSymbol[];
    topLevelSymbols: AslSymbol[];
    symbolIndex: Map<string, AslSymbol[]>;
    references: AslReference[];
    issues: AslIssue[];
    lineContexts: AslContextFrame[][];
    controlUsages: AslControlUsage[];
}

interface MutableFrame {
    kind: string;
    name?: string;
    control?: string;
    symbol?: AslSymbol;
    usage?: AslControlUsage;
}

export interface AslSymbolReference {
    text: string;
    parts: string[];
    activePartIndex: number;
    range: vscode.Range;
    fullText: string;
    fullRange: vscode.Range;
}

interface PendingSymbolFrame {
    kind: string;
    name: string;
    symbol: AslSymbol;
}

const RECORD_SECTION_VARIABLES = new Map<string, string>([
    ["campaign", "campaign record"],
    ["contact", "contact record"],
    ["workflow", "workflow record"],
    ["transferred", "transferred record"],
    ["outcome", "outcome record"],
    ["outcomes", "outcome record"],
    ["contact_profile", "contact profile extensions"]
]);

const RECORD_SECTION_NAMES = new Set(RECORD_SECTION_VARIABLES.values());

export class AslAnalysisService {
    private readonly cache = new Map<string, { version: number; analysis: AslAnalysis }>();

    public getAnalysis(document: vscode.TextDocument): AslAnalysis {
        const cached = this.cache.get(document.uri.toString());
        if (cached && cached.version === document.version) {
            return cached.analysis;
        }

        const analysis = analyzeDocument(document);
        this.cache.set(document.uri.toString(), { version: document.version, analysis });
        return analysis;
    }

    public clear(document: vscode.TextDocument): void {
        this.cache.delete(document.uri.toString());
    }
}

export function analyzeDocument(document: vscode.TextDocument): AslAnalysis {
    const topLevelSymbols: AslSymbol[] = [];
    const symbols: AslSymbol[] = [];
    const symbolIndex = new Map<string, AslSymbol[]>();
    const references: AslReference[] = [];
    const issues: AslIssue[] = [];
    const lineContexts: AslContextFrame[][] = [];
    const controlUsages: AslControlUsage[] = [];
    const frames: MutableFrame[] = [];
    let pendingSymbolFrame: PendingSymbolFrame | undefined;

    const pushSymbol = (symbol: AslSymbol): void => {
        const parent = [...frames].reverse().find((frame) => frame.symbol)?.symbol;
        symbol.scopeKey = parent ? createSymbolIdentity(parent) : "<root>";
        if (parent) {
            parent.children.push(symbol);
        } else {
            topLevelSymbols.push(symbol);
        }

        symbols.push(symbol);
        const key = normalizeAslName(symbol.name);
        const existing = symbolIndex.get(key) ?? [];
        existing.push(symbol);
        symbolIndex.set(key, existing);
    };

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
        const line = document.lineAt(lineNumber);
        const text = line.text;
        const trimmed = text.trim();
        lineContexts[lineNumber] = frames.map((frame) => ({ kind: frame.kind, name: frame.name, control: frame.control }));

        const inComment = frames.some((frame) => frame.kind === "comment");
        if (!inComment && trimmed.length > 0) {
            parseDeclarations(document, lineNumber, trimmed, frames, pushSymbol, references, issues, controlUsages, (frame) => {
                pendingSymbolFrame = frame;
            });
            parseReferences(document, lineNumber, text, references);
            parseControlProperties(document, lineNumber, trimmed, frames, issues);
        }

        const structural = maskCommentContent(maskQuotedContent(text), inComment);
        const opens = countCharacters(structural, "{");
        const closes = countCharacters(structural, "}");
        const semanticFrame = !inComment ? createSemanticFrame(lineNumber, trimmed, symbols, controlUsages, pendingSymbolFrame) : undefined;

        if (semanticFrame && pendingSymbolFrame?.symbol === semanticFrame.symbol) {
            pendingSymbolFrame = undefined;
        }

        let remainingOpens = opens;
        if (semanticFrame) {
            frames.push(semanticFrame);
            remainingOpens -= 1;
        }

        for (let openIndex = 0; openIndex < Math.max(remainingOpens, 0); openIndex += 1) {
            frames.push({ kind: "scope" });
        }

        for (let closeIndex = 0; closeIndex < closes; closeIndex += 1) {
            const frame = frames.pop();
            if (!frame) {
                issues.push({
                    message: "Unmatched closing brace.",
                    severity: vscode.DiagnosticSeverity.Error,
                    range: new vscode.Range(lineNumber, Math.max(line.text.lastIndexOf("}"), 0), lineNumber, Math.max(line.text.lastIndexOf("}"), 0) + 1)
                });
                continue;
            }

            if (frame.symbol) {
                frame.symbol.range = new vscode.Range(frame.symbol.range.start, line.range.end);
            }

            if (frame.usage) {
                frame.usage.range = new vscode.Range(frame.usage.range.start, line.range.end);
                validateControlUsage(frame.usage, issues);
            }
        }
    }

    for (const frame of frames) {
        if (frame.symbol) {
            issues.push({
                message: `Unclosed ${frame.kind} block${frame.name ? ` '${frame.name}'` : ""}.`,
                severity: vscode.DiagnosticSeverity.Error,
                range: frame.symbol.selectionRange
            });
        }
    }

    validateDuplicates(symbolIndex, issues);
    validateReferences(symbolIndex, references, issues);

    return { symbols, topLevelSymbols, symbolIndex, references, issues, lineContexts, controlUsages };
}

function parseDeclarations(
    document: vscode.TextDocument,
    lineNumber: number,
    trimmed: string,
    frames: MutableFrame[],
    pushSymbol: (symbol: AslSymbol) => void,
    references: AslReference[],
    issues: AslIssue[],
    controlUsages: AslControlUsage[],
    setPendingSymbolFrame: (frame: PendingSymbolFrame | undefined) => void
): void {
    const nodeMatch = trimmed.match(/^(?:private\s+)?node\s+["']([^"']+)["']\s*\{/i);
    if (nodeMatch) {
        pushSymbol(createBlockSymbol(document, lineNumber, nodeMatch[1], "node"));
        return;
    }

    const blockMatch = trimmed.match(/^block\s+["']([^"']+)["']\s*\{/i);
    if (blockMatch) {
        pushSymbol(createBlockSymbol(document, lineNumber, blockMatch[1], "block"));
        return;
    }

    const sectionMatch = trimmed.match(/^(modules|dependencies|declarations|constants|types|variables|parameters|globals?|cursors|using namespaces|campaign record|contact record|workflow record|transferred record|outcome record|contact profile extensions|flow view)\b/i);
    if (sectionMatch && trimmed.includes("{")) {
        pushSymbol(createBlockSymbol(document, lineNumber, sectionMatch[1], "section"));
        return;
    }

    const eventMatch = trimmed.match(/^(on\s+.+?)\s*\{/i);
    if (eventMatch) {
        pushSymbol(createBlockSymbol(document, lineNumber, eventMatch[1], "event"));
        return;
    }

    const subroutineMatch = trimmed.match(/^subroutine\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (subroutineMatch) {
        const routine = parseRoutineDeclaration(document, lineNumber, "subroutine");
        const symbol = createBlockSymbol(document, lineNumber, routine.name, "subroutine", routine.detail);
        pushSymbol(symbol);
        setPendingSymbolFrame(trimmed.includes("{") ? undefined : { kind: "subroutine", name: routine.name, symbol });
        return;
    }

    const functionMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (functionMatch) {
        const routine = parseRoutineDeclaration(document, lineNumber, "function");
        const symbol = createBlockSymbol(document, lineNumber, routine.name, "function", routine.detail);
        pushSymbol(symbol);
        setPendingSymbolFrame(trimmed.includes("{") ? undefined : { kind: "function", name: routine.name, symbol });
        return;
    }

    const recordOwner = getRecordOwner(frames);
    if (recordOwner) {
        const fieldMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)(?:\s*,)?$/);
        if (fieldMatch) {
            pushSymbol(createLineSymbol(document, lineNumber, fieldMatch[1], "field", fieldMatch[2].trim()));
            return;
        }
    }

    const activeSection = [...frames].reverse().find((frame) => frame.kind === "section")?.name;
    if (activeSection) {
        const sectionName = normalizeAslName(activeSection);
        if (sectionName === "types") {
            const typeMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(record|enumeration)\s*\{/);
            if (typeMatch) {
                pushSymbol(createBlockSymbol(document, lineNumber, typeMatch[1], "type", typeMatch[2]));
                return;
            }
        }

        if (sectionName === "cursors") {
            const cursorMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
            if (cursorMatch) {
                pushSymbol(createLineSymbol(document, lineNumber, cursorMatch[1], "cursor", cursorMatch[2].trim()));
                return;
            }
        }

        if (sectionName === "variables" || sectionName === "parameters") {
            const recordDeclarationMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*record\s*\{$/i);
            if (recordDeclarationMatch) {
                const kind: AslSymbolKindName = sectionName === "variables" ? "variable" : "parameter";
                pushSymbol(createBlockSymbol(document, lineNumber, recordDeclarationMatch[1], kind, "record"));
                return;
            }

            const typedMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^:=]+?)(?:\s*:=.*)?$/);
            if (typedMatch) {
                const kind: AslSymbolKindName = sectionName === "variables" ? "variable" : "parameter";
                pushSymbol(createLineSymbol(document, lineNumber, typedMatch[1], kind, typedMatch[2].trim()));
                return;
            }
        }

        if (sectionName === "constants") {
            const constantMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=/);
            if (constantMatch) {
                pushSymbol(createLineSymbol(document, lineNumber, constantMatch[1], "constant"));
                return;
            }
        }

        if (sectionName === "modules") {
            const namespaceMatch = trimmed.match(/\binto namespace\s+([A-Za-z_][A-Za-z0-9_]*)/i);
            if (namespaceMatch) {
                pushSymbol(createLineSymbol(document, lineNumber, namespaceMatch[1], "namespace"));
                return;
            }
        }

        if (sectionName === "using namespaces") {
            const aliasMatch = trimmed.match(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
            if (aliasMatch) {
                pushSymbol(createLineSymbol(document, lineNumber, aliasMatch[1], "namespace"));
                return;
            }
        }
    }

    const nearestNode = [...frames].reverse().find((frame) => frame.kind === "node");
    if (nearestNode) {
        const controlMatch = matchControlStart(trimmed);
        if (controlMatch) {
            const definition = findControlDefinition(controlMatch.control);
            if (definition) {
                const symbolName = controlMatch.name ?? controlMatch.control;
                pushSymbol(createBlockSymbol(document, lineNumber, symbolName, "control", controlMatch.control, !controlMatch.name));
                if (controlMatch.targetName) {
                    references.push(createReference(document, lineNumber, controlMatch.targetName, definition.requiresTarget ?? "variable"));
                }
                const usage: AslControlUsage = {
                    control: controlMatch.control,
                    name: controlMatch.name,
                    targetName: controlMatch.targetName,
                    targetKind: definition.requiresTarget,
                    range: document.lineAt(lineNumber).range,
                    properties: new Set<string>()
                };
                controlUsages.push(usage);
                return;
            }
        }
    }
}

function parseReferences(document: vscode.TextDocument, lineNumber: number, text: string, references: AslReference[]): void {
    for (const match of text.matchAll(/\b(?:goto node|call node|master)\s+["']([^"']+)["']/gi)) {
        references.push(createReference(document, lineNumber, match[1], "node", match.index ?? 0, match[0].length));
    }

    for (const match of text.matchAll(/\bcursor\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        references.push(createReference(document, lineNumber, match[1], "cursor", match.index ?? 0, match[0].length));
    }
}

function parseControlProperties(
    document: vscode.TextDocument,
    lineNumber: number,
    trimmed: string,
    frames: MutableFrame[],
    issues: AslIssue[]
): void {
    const controlFrameIndex = findNearestControlFrameIndex(frames);
    if (controlFrameIndex === -1) {
        return;
    }

    if (frames.slice(controlFrameIndex + 1).length > 0) {
        return;
    }

    const controlFrame = frames[controlFrameIndex];
    if (!controlFrame?.usage) {
        return;
    }

    if (!trimmed || trimmed.startsWith("}")) {
        return;
    }

    const propertyNames = extractKnownNames(trimmed, ALL_PROPERTY_NAMES);
    const eventNames = extractKnownNames(trimmed, ALL_EVENT_NAMES);
    for (const propertyName of [...propertyNames, ...eventNames]) {
        controlFrame.usage.properties.add(propertyName);
    }

    const definition = findControlDefinition(controlFrame.usage.control);
    if (!definition) {
        return;
    }

    const isPropertyLine = propertyNames.length > 0 || eventNames.length > 0;
    if (!isPropertyLine) {
        return;
    }

    const disallowed = [
        ...propertyNames.filter((propertyName) => !definition.properties.includes(propertyName)),
        ...eventNames.filter((eventName) => !definition.events.includes(eventName) && !eventName.startsWith("on event"))
    ];

    if (disallowed.length === 0) {
        return;
    }

    issues.push({
        message: `Property or event '${disallowed[0]}' is not documented for control '${controlFrame.usage.control}'.`,
        severity: vscode.DiagnosticSeverity.Warning,
        range: document.lineAt(lineNumber).range
    });
}

function createSemanticFrame(
    lineNumber: number,
    trimmed: string,
    symbols: AslSymbol[],
    controlUsages: AslControlUsage[],
    pendingSymbolFrame?: PendingSymbolFrame
): MutableFrame | undefined {
    if (!trimmed.includes("{")) {
        return undefined;
    }

    const nodeMatch = trimmed.match(/^(?:private\s+)?node\s+["']([^"']+)["']\s*\{/i);
    if (nodeMatch) {
        return { kind: "node", name: nodeMatch[1], symbol: findNewestSymbol(symbols, lineNumber, "node") };
    }

    const blockMatch = trimmed.match(/^block\s+["']([^"']+)["']\s*\{/i);
    if (blockMatch) {
        return { kind: "block", name: blockMatch[1], symbol: findNewestSymbol(symbols, lineNumber, "block") };
    }

    const sectionMatch = trimmed.match(/^(modules|dependencies|declarations|constants|types|variables|parameters|globals?|cursors|using namespaces|campaign record|contact record|workflow record|transferred record|outcome record|contact profile extensions|flow view)\b/i);
    if (sectionMatch) {
        return { kind: "section", name: sectionMatch[1], symbol: findNewestSymbol(symbols, lineNumber, "section") };
    }

    const eventMatch = trimmed.match(/^(on\s+.+?)\s*\{/i);
    if (eventMatch) {
        return { kind: "event", name: eventMatch[1], symbol: findNewestSymbol(symbols, lineNumber, "event") };
    }

    const subroutineMatch = trimmed.match(/^subroutine\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (subroutineMatch) {
        return { kind: "subroutine", name: subroutineMatch[1], symbol: findNewestSymbol(symbols, lineNumber, "subroutine") };
    }

    const functionMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (functionMatch) {
        return { kind: "function", name: functionMatch[1], symbol: findNewestSymbol(symbols, lineNumber, "function") };
    }

    if (/^\{\s*$/.test(trimmed) && pendingSymbolFrame) {
        return { kind: pendingSymbolFrame.kind, name: pendingSymbolFrame.name, symbol: pendingSymbolFrame.symbol };
    }

    const typeLikeMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(record|enumeration)\s*\{/i);
    if (typeLikeMatch) {
        const typeSymbol = findNewestSymbol(symbols, lineNumber, "type");
        if (typeSymbol) {
            return { kind: "type", name: typeLikeMatch[1], symbol: typeSymbol };
        }

        const variableSymbol = findNewestSymbol(symbols, lineNumber, "variable");
        if (variableSymbol && normalizeAslName(variableSymbol.detail ?? "") === "record") {
            return { kind: "variable", name: typeLikeMatch[1], symbol: variableSymbol };
        }

        const parameterSymbol = findNewestSymbol(symbols, lineNumber, "parameter");
        if (parameterSymbol && normalizeAslName(parameterSymbol.detail ?? "") === "record") {
            return { kind: "parameter", name: typeLikeMatch[1], symbol: parameterSymbol };
        }
    }

    const controlMatch = matchControlStart(trimmed);
    if (controlMatch) {
        return {
            kind: "control",
            name: controlMatch.name ?? controlMatch.control,
            control: controlMatch.control,
            symbol: findNewestSymbol(symbols, lineNumber, "control"),
            usage: controlUsages[controlUsages.length - 1]
        };
    }

    if (/^comment\s*\{/i.test(trimmed)) {
        return { kind: "comment", name: "comment" };
    }

    if (/^(label|font|columns|column|item|level|image)\b/i.test(trimmed)) {
        return { kind: "property-block" };
    }

    return { kind: "scope" };
}

function findNewestSymbol(symbols: AslSymbol[], lineNumber: number, kind: AslSymbolKindName): AslSymbol | undefined {
    return [...symbols].reverse().find((symbol) => symbol.kind === kind && symbol.selectionRange.start.line === lineNumber);
}

function matchControlStart(trimmed: string): { control: string; name?: string; targetName?: string } | undefined {
    for (const controlName of CONTROL_NAMES_BY_LENGTH) {
        const pattern = new RegExp(`^${escapeRegExp(controlName)}\\b(?:\\s+["']([^"']+)["'])?(?:\\s+for\\s+([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*))?`, "i");
        const match = trimmed.match(pattern);
        if (match && trimmed.includes("{")) {
            return { control: controlName, name: match[1], targetName: match[2] };
        }
    }

    return undefined;
}

function createBlockSymbol(document: vscode.TextDocument, lineNumber: number, name: string, kind: AslSymbolKindName, detail?: string, anonymous = false): AslSymbol {
    const line = document.lineAt(lineNumber);
    return {
        name,
        kind,
        detail,
        scopeKey: "<pending>",
        anonymous,
        range: line.range,
        selectionRange: createSelectionRange(lineNumber, line.text, name),
        children: []
    };
}

function createLineSymbol(document: vscode.TextDocument, lineNumber: number, name: string, kind: AslSymbolKindName, detail?: string): AslSymbol {
    const line = document.lineAt(lineNumber);
    return {
        name,
        kind,
        detail,
        scopeKey: "<pending>",
        anonymous: false,
        range: line.range,
        selectionRange: createSelectionRange(lineNumber, line.text, name),
        children: []
    };
}

function createSelectionRange(lineNumber: number, text: string, name: string): vscode.Range {
    const start = Math.max(text.toLowerCase().indexOf(name.toLowerCase()), 0);
    return new vscode.Range(lineNumber, start, lineNumber, start + name.length);
}

function createReference(
    document: vscode.TextDocument,
    lineNumber: number,
    name: string,
    kind: AslReference["kind"],
    startHint?: number,
    lengthHint?: number
): AslReference {
    const line = document.lineAt(lineNumber).text;
    const start = startHint !== undefined ? Math.max(line.toLowerCase().indexOf(name.toLowerCase(), startHint), 0) : Math.max(line.toLowerCase().indexOf(name.toLowerCase()), 0);
    const end = start + (lengthHint ? name.length : name.length);
    return {
        name,
        kind,
        range: new vscode.Range(lineNumber, start, lineNumber, end)
    };
}

function validateDuplicates(symbolIndex: Map<string, AslSymbol[]>, issues: AslIssue[]): void {
    for (const [, symbols] of symbolIndex) {
        const byKind = new Map<string, AslSymbol[]>();
        for (const symbol of symbols) {
            if (!shouldValidateDuplicate(symbol)) {
                continue;
            }

            const key = `${symbol.scopeKey}:${symbol.kind}:${symbol.name.toLowerCase()}`;
            const bucket = byKind.get(key) ?? [];
            bucket.push(symbol);
            byKind.set(key, bucket);
        }

        for (const [, bucket] of byKind) {
            if (bucket.length > 1) {
                for (const duplicate of bucket.slice(1)) {
                    issues.push({
                        message: `Duplicate ${duplicate.kind} '${duplicate.name}'.`,
                        severity: vscode.DiagnosticSeverity.Warning,
                        range: duplicate.selectionRange
                    });
                }
            }
        }
    }
}

function validateReferences(symbolIndex: Map<string, AslSymbol[]>, references: AslReference[], issues: AslIssue[]): void {
    for (const reference of references) {
        const matches = reference.kind === "variable"
            ? resolveReferenceSymbolsFromParts({ symbolIndex } as AslAnalysis, reference.name.split("."))
            : symbolIndex.get(normalizeAslName(reference.name)) ?? [];
        const resolved = matches.some((symbol) => {
            if (reference.kind === "variable") {
                return symbol.kind === "variable" || symbol.kind === "parameter" || symbol.kind === "constant" || symbol.kind === "field";
            }
            if (reference.kind === "cursor") {
                return symbol.kind === "cursor" || symbol.kind === "variable";
            }
            return symbol.kind === reference.kind;
        });

        if (!resolved) {
            issues.push({
                message: `Unresolved ${reference.kind} reference '${reference.name}'.`,
                severity: vscode.DiagnosticSeverity.Warning,
                range: reference.range
            });
        }
    }
}

function validateControlUsage(usage: AslControlUsage, issues: AslIssue[]): void {
    const definition = findControlDefinition(usage.control);
    if (!definition) {
        return;
    }

    if (definition.requiresTarget && !usage.targetName) {
        issues.push({
            message: `Control '${usage.control}' requires a ${definition.requiresTarget} target after 'for'.`,
            severity: vscode.DiagnosticSeverity.Error,
            range: usage.range
        });
    }

    for (const requiredProperty of ["size", "at"]) {
        if (!usage.properties.has(requiredProperty)) {
            issues.push({
                message: `Control '${usage.control}' is missing documented property '${requiredProperty}'.`,
                severity: vscode.DiagnosticSeverity.Warning,
                range: usage.range
            });
        }
    }
}

function extractKnownNames(trimmed: string, knownNames: string[]): string[] {
    const normalized = normalizeAslName(trimmed);
    const matches: Array<{ name: string; start: number; end: number }> = [];

    for (const candidate of [...knownNames].sort((left, right) => right.length - left.length)) {
        const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(candidate)}(?=\\s|$)`, "g");
        for (const match of normalized.matchAll(pattern)) {
            const start = (match.index ?? 0) + match[0].length - candidate.length;
            const end = start + candidate.length;
            if (matches.some((existing) => rangesOverlap(existing.start, existing.end, start, end))) {
                continue;
            }

            matches.push({ name: candidate, start, end });
        }
    }

    return matches.sort((left, right) => left.start - right.start).map((match) => match.name);
}

function findNearestControlFrameIndex(frames: MutableFrame[]): number {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
        if (frames[index].usage) {
            return index;
        }
    }

    return -1;
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
    return startA < endB && startB < endA;
}

function maskCommentContent(text: string, inComment: boolean): string {
    return text;
}

function shouldValidateDuplicate(symbol: AslSymbol): boolean {
    if (symbol.kind === "control") {
        return !symbol.anonymous;
    }

    return true;
}

function createSymbolIdentity(symbol: AslSymbol): string {
    return `${symbol.kind}:${symbol.name.toLowerCase()}:${symbol.selectionRange.start.line}`;
}

function getRecordOwner(frames: MutableFrame[]): MutableFrame | undefined {
    return [...frames].reverse().find((frame) => {
        if (!frame.symbol) {
            return false;
        }

        if (frame.symbol.kind === "type" && normalizeAslName(frame.symbol.detail ?? "") === "record") {
            return true;
        }

        if ((frame.symbol.kind === "variable" || frame.symbol.kind === "parameter") && normalizeAslName(frame.symbol.detail ?? "") === "record") {
            return true;
        }

        return frame.symbol.kind === "section" && RECORD_SECTION_NAMES.has(normalizeAslName(frame.symbol.name));
    });
}

function maskQuotedContent(text: string): string {
    let result = "";
    let inSingle = false;
    let inDouble = false;
    let inPath = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (!inSingle && !inDouble && char === "<" && next === '"') {
            inPath = true;
            result += "  ";
            index += 1;
            continue;
        }

        if (inPath) {
            if (char === '"' && next === ">") {
                inPath = false;
                result += "  ";
                index += 1;
            } else {
                result += " ";
            }
            continue;
        }

        if (!inSingle && char === '"') {
            inDouble = !inDouble;
            result += " ";
            continue;
        }

        if (!inDouble && char === "'") {
            const previous = index > 0 ? text[index - 1] : "";
            const nextNonEmpty = text[index + 1] ?? "";

            if (inSingle && next === "'") {
                result += "  ";
                index += 1;
                continue;
            }

            if (!inSingle) {
                if (!isWordCharacter(previous)) {
                    inSingle = true;
                    result += " ";
                    continue;
                }
            } else if (!isWordCharacter(nextNonEmpty)) {
                inSingle = false;
                result += " ";
                continue;
            }
        }

        if (inSingle || inDouble) {
            result += " ";
            continue;
        }

        result += char;
    }

    return result;
}

function isWordCharacter(value: string): boolean {
    return /[A-Za-z0-9_]/.test(value);
}

function countCharacters(value: string, char: string): number {
    let count = 0;
    for (const current of value) {
        if (current === char) {
            count += 1;
        }
    }
    return count;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRoutineDeclaration(document: vscode.TextDocument, lineNumber: number, kind: "subroutine" | "function"): { name: string; detail: string } {
    const header = collectRoutineHeader(document, lineNumber);
    const collapsed = header.replace(/\s+/g, " ").trim();
    const pattern = kind === "subroutine"
        ? /^subroutine\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\((.*?)\))?/i
        : /^function\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\((.*?)\))?(?:\s*:\s*(.+?))?(?:\s*\{)?$/i;
    const match = collapsed.match(pattern);
    const name = match?.[1] ?? `${kind}_${lineNumber + 1}`;
    const parameters = normalizeRoutineParameters(match?.[2] ?? "");

    if (kind === "subroutine") {
        return { name, detail: `(${parameters})` };
    }

    const returnType = (match?.[3] ?? "").replace(/\s*\{$/, "").trim();
    return { name, detail: `(${parameters})${returnType ? `: ${returnType}` : ""}` };
}

function collectRoutineHeader(document: vscode.TextDocument, startLine: number): string {
    const lines: string[] = [];
    for (let line = startLine; line < Math.min(document.lineCount, startLine + 12); line += 1) {
        lines.push(document.lineAt(line).text.trim());
        if (document.lineAt(line).text.includes("{")) {
            break;
        }
    }

    return lines.join(" ");
}

function normalizeRoutineParameters(value: string): string {
    return value
        .split(",")
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter((part) => part.length > 0)
        .join(", ");
}

export function findSymbolReferenceAtPosition(document: vscode.TextDocument, position: vscode.Position): AslSymbolReference | undefined {
    return collectLineSymbolReferences(document.lineAt(position.line).text, position.line).find((reference) =>
        position.character >= reference.range.start.character && position.character <= reference.range.end.character
    );
}

export function findSymbolAtPosition(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    return findSymbolReferenceAtPosition(document, position)?.text;
}

export function resolveReferenceSymbols(analysis: AslAnalysis, reference: AslSymbolReference): AslSymbol[] {
    const targetParts = reference.parts.slice(0, reference.activePartIndex + 1);
    const preferNonTypeBase = reference.parts.length > 1 && reference.activePartIndex === 0;
    return resolveReferenceSymbolsFromParts(analysis, targetParts, preferNonTypeBase);
}

export function collectDocumentSymbolReferences(document: vscode.TextDocument, analysis: AslAnalysis): AslSymbolReference[] {
    const references: AslSymbolReference[] = [];
    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
        const inComment = (analysis.lineContexts[lineNumber] ?? []).some((context) => context.kind === "comment");
        if (inComment) {
            continue;
        }

        references.push(...collectLineSymbolReferences(document.lineAt(lineNumber).text, lineNumber));
    }

    return references;
}

export function getMemberSymbols(analysis: AslAnalysis, expression: string): AslSymbol[] {
    const parts = expression.split(".").filter(Boolean);
    if (parts.length === 0) {
        return [];
    }

    const bases = resolveReferenceSymbolsFromParts(analysis, parts);
    return deduplicateSymbols(bases.flatMap((symbol) => getAvailableMemberSymbols(analysis, symbol)));
}

function resolveReferenceSymbolsFromParts(
    analysis: Pick<AslAnalysis, "symbolIndex" | "symbols">,
    parts: string[],
    preferNonTypeBase = false
): AslSymbol[] {
    if (parts.length === 0) {
        return [];
    }

    let current = resolveBaseSymbols(analysis, parts[0]);
    if (parts.length > 1 || preferNonTypeBase) {
        const nonTypeBases = current.filter((symbol) => symbol.kind !== "type");
        if (nonTypeBases.length > 0) {
            current = nonTypeBases;
        }
    }

    for (const part of parts.slice(1)) {
        current = resolveMemberSymbols(analysis, current, part);
        if (current.length === 0) {
            break;
        }
    }

    return current;
}

function resolveBaseSymbols(analysis: Pick<AslAnalysis, "symbolIndex" | "symbols">, baseName: string): AslSymbol[] {
    const direct = analysis.symbolIndex.get(normalizeAslName(baseName)) ?? [];
    if (direct.length > 0) {
        return direct;
    }

    const recordSectionName = RECORD_SECTION_VARIABLES.get(normalizeAslName(baseName));
    if (!recordSectionName) {
        return [];
    }

    return (analysis.symbols ?? []).filter((symbol) => symbol.kind === "section" && normalizeAslName(symbol.name) === recordSectionName);
}

function resolveMemberSymbols(analysis: Pick<AslAnalysis, "symbolIndex" | "symbols">, bases: AslSymbol[], memberName: string): AslSymbol[] {
    return deduplicateSymbols(bases.flatMap((base) => resolveMemberSymbolsForBase(analysis, base, memberName)));
}

function resolveMemberSymbolsForBase(analysis: Pick<AslAnalysis, "symbolIndex" | "symbols">, base: AslSymbol, memberName: string): AslSymbol[] {
    const directChildren = base.children.filter((child) => child.kind === "field" && normalizeAslName(child.name) === normalizeAslName(memberName));
    if (directChildren.length > 0) {
        return directChildren;
    }

    const referencedType = normalizeAslName(base.detail ?? "");
    if (!referencedType || referencedType === "record") {
        return [];
    }

    const typeSymbols = (analysis.symbolIndex.get(referencedType) ?? []).filter((symbol) => symbol.kind === "type" || (symbol.kind === "section" && RECORD_SECTION_NAMES.has(normalizeAslName(symbol.name))));
    return deduplicateSymbols(typeSymbols.flatMap((symbol) => resolveMemberSymbolsForBase(analysis, symbol, memberName)));
}

function getAvailableMemberSymbols(analysis: Pick<AslAnalysis, "symbolIndex" | "symbols">, symbol: AslSymbol): AslSymbol[] {
    const directChildren = symbol.children.filter((child) => child.kind === "field");
    if (directChildren.length > 0) {
        return directChildren;
    }

    const referencedType = normalizeAslName(symbol.detail ?? "");
    if (!referencedType || referencedType === "record") {
        return [];
    }

    const typeSymbols = (analysis.symbolIndex.get(referencedType) ?? []).filter((candidate) => candidate.kind === "type" || (candidate.kind === "section" && RECORD_SECTION_NAMES.has(normalizeAslName(candidate.name))));
    return deduplicateSymbols(typeSymbols.flatMap((candidate) => candidate.children.filter((child) => child.kind === "field")));
}

function deduplicateSymbols(symbols: AslSymbol[]): AslSymbol[] {
    const seen = new Set<string>();
    return symbols.filter((symbol) => {
        const key = createSymbolIdentity(symbol);
        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function collectLineSymbolReferences(text: string, lineNumber: number): AslSymbolReference[] {
    const references: AslSymbolReference[] = [];
    const masked = maskCommentContent(maskQuotedContent(text), false);

    for (const match of masked.matchAll(/@?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
        const start = match.index ?? 0;
        const fullText = text.slice(start, start + match[0].length);
        const parts = fullText.split(".");
        let segmentStart = start;
        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index];
            references.push({
                text: part,
                parts,
                activePartIndex: index,
                range: new vscode.Range(lineNumber, segmentStart, lineNumber, segmentStart + part.length),
                fullText,
                fullRange: new vscode.Range(lineNumber, start, lineNumber, start + fullText.length)
            });
            segmentStart += part.length + 1;
        }
    }

    for (const match of text.matchAll(/\b(?:goto node|call node|master)\s+["']([^"']+)["']/gi)) {
        const quoteStart = (match.index ?? 0) + match[0].indexOf(match[1]);
        references.push({
            text: match[1],
            parts: [match[1]],
            activePartIndex: 0,
            range: new vscode.Range(lineNumber, quoteStart, lineNumber, quoteStart + match[1].length),
            fullText: match[1],
            fullRange: new vscode.Range(lineNumber, quoteStart, lineNumber, quoteStart + match[1].length)
        });
    }

    return references;
}

export function getContextsForLine(analysis: AslAnalysis, line: number): AslContextFrame[] {
    return analysis.lineContexts[line] ?? [];
}

export function getNearestControlDefinition(analysis: AslAnalysis, line: number): AslControlDefinition | undefined {
    const frame = [...getContextsForLine(analysis, line)].reverse().find((context) => context.kind === "control");
    return frame?.control ? findControlDefinition(frame.control) : undefined;
}

export function getNearestSection(analysis: AslAnalysis, line: number): string | undefined {
    const frame = [...getContextsForLine(analysis, line)].reverse().find((context) => context.kind === "section");
    return frame?.name;
}

export function getNearestNode(analysis: AslAnalysis, line: number): string | undefined {
    const frame = [...getContextsForLine(analysis, line)].reverse().find((context) => context.kind === "node");
    return frame?.name;
}

export function isTopLevelContext(analysis: AslAnalysis, line: number): boolean {
    const contexts = getContextsForLine(analysis, line);
    return !contexts.some((context) => context.kind !== "scope");
}

export function isKnownSectionName(value: string): boolean {
    return SECTION_NAMES.has(normalizeAslName(value));
}

export function getAllControlDefinitions(): AslControlDefinition[] {
    return CONTROL_DEFINITIONS;
}