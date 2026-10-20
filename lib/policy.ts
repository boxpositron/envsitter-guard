import { isEnvSitterPepperFile, isSensitiveEnvFile } from "envsitter";

export type BlockedAccess = {
    readonly kind: "read" | "edit" | "shell" | "access";
    readonly tool: string;
    readonly paths: readonly string[];
};

const PATH_ARG_KEYS = ["filePath", "file_path", "filepath", "path", "paths", "filePaths"] as const;
const READ_TOOLS = new Set(["read", "grep", "glob", "list", "view"]);
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

const PATCH_FILE_HEADER = /^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;
const UNIFIED_DIFF_HEADER = /^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)\s*$/gm;

const SHELL_SEGMENT_OPERATORS = new Set([";", "&", "|", "\n", "(", ")", "`"]);
const SHELL_WORD_BREAKS = new Set(["<", ">"]);
const SHELL_SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g;
const SHELL_PREFIX_COMMANDS = new Set(["sudo", "env", "command", "exec", "time", "nohup", "nice"]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx"]);

export function normalizePath(input: string): string {
    return input.replace(/\\/g, "/");
}

export function stripAtPrefix(input: string): string {
    return input.trim().replace(/^@+/, "");
}

export function isProtectedPath(input: string): boolean {
    const candidate = normalizePath(stripAtPrefix(input));
    return isSensitiveEnvFile(candidate) || isEnvSitterPepperFile(candidate);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
}

function collectPathArgs(args: Record<string, unknown>): string[] {
    const paths: string[] = [];
    for (const key of PATH_ARG_KEYS) {
        const value = args[key];
        if (typeof value === "string") paths.push(value);
        if (Array.isArray(value)) paths.push(...value.filter((item): item is string => typeof item === "string"));
    }
    return paths;
}

export function extractPatchPaths(patchText: string): string[] {
    const paths: string[] = [];
    for (const match of patchText.matchAll(PATCH_FILE_HEADER)) paths.push(match[1] ?? "");
    for (const match of patchText.matchAll(UNIFIED_DIFF_HEADER)) paths.push(match[1] ?? "");
    return paths.filter((p) => p.length > 0 && p !== "/dev/null");
}

function splitShellSegments(command: string): string[][] {
    const segments: string[][] = [];
    let words: string[] = [];
    let word = "";
    let inWord = false;
    let quote: "'" | '"' | undefined;

    const endWord = () => {
        if (inWord) words.push(word);
        word = "";
        inWord = false;
    };
    const endSegment = () => {
        endWord();
        if (words.length > 0) segments.push(words);
        words = [];
    };

    for (let i = 0; i < command.length; i += 1) {
        const char = command[i] ?? "";

        if (quote) {
            if (char === quote) {
                quote = undefined;
            } else if (char === "\\" && quote === '"' && i + 1 < command.length) {
                word += command[i + 1];
                i += 1;
            } else {
                word += char;
            }
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            inWord = true;
        } else if (char === "\\" && i + 1 < command.length) {
            word += command[i + 1];
            inWord = true;
            i += 1;
        } else if (SHELL_SEGMENT_OPERATORS.has(char)) {
            endSegment();
        } else if (SHELL_WORD_BREAKS.has(char) || /\s/.test(char)) {
            endWord();
        } else {
            word += char;
            inWord = true;
        }
    }

    endSegment();
    return segments;
}

function isEnvSitterPackage(word: string | undefined): boolean {
    return word === "envsitter" || (word?.startsWith("envsitter@") ?? false);
}

function isEnvSitterInvocation(words: readonly string[]): boolean {
    let index = 0;
    while (index < words.length) {
        const word = words[index] ?? "";
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && !SHELL_PREFIX_COMMANDS.has(word)) break;
        index += 1;
    }

    const program = (words[index] ?? "").split("/").pop() ?? "";
    if (program === "envsitter") return true;

    const rest = words.slice(index + 1).filter((word) => !word.startsWith("-"));
    if (PACKAGE_RUNNERS.has(program)) return isEnvSitterPackage(rest[0]);
    if (program === "pnpm" || program === "yarn") return rest[0] === "dlx" && isEnvSitterPackage(rest[1]);
    return false;
}

function isProtectedGlob(word: string): boolean {
    return /[*?[]/.test(word) && word.toLowerCase().includes(".env");
}

/**
 * Best-effort scan for `.env*` / pepper paths named in a shell command. It is a guardrail against
 * accidental reads (`cat .env`, `source .env`, `echo x >> .env`), not a sandbox: variables,
 * eval, and generic commands such as `grep -r` without a path can still reach file contents.
 * Segments that invoke the envsitter CLI are allowed because it never prints values.
 */
export function findProtectedPathsInCommand(command: string): string[] {
    const found = new Set<string>();
    const sources = [command, ...[...command.matchAll(SHELL_SUBSTITUTION)].map((m) => m[1] ?? m[2] ?? "")];

    for (const source of sources) {
        for (const words of splitShellSegments(source)) {
            if (isEnvSitterInvocation(words)) continue;
            for (const word of words) {
                for (const candidate of [word, ...word.split("=").slice(1)]) {
                    if (candidate && (isProtectedPath(candidate) || isProtectedGlob(candidate))) found.add(candidate);
                }
            }
        }
    }

    return [...found];
}

function kindForTool(tool: string): BlockedAccess["kind"] {
    if (READ_TOOLS.has(tool)) return "read";
    if (EDIT_TOOLS.has(tool)) return "edit";
    return "access";
}

export function findBlockedAccess(tool: string, args: unknown): BlockedAccess | undefined {
    if (tool.startsWith("envsitter_")) return undefined;

    const record = asRecord(args);
    if (!record) return undefined;

    const paths = collectPathArgs(record);
    if (typeof record.patchText === "string") paths.push(...extractPatchPaths(record.patchText));

    const protectedPaths = paths.filter(isProtectedPath);
    if (protectedPaths.length > 0) return { kind: kindForTool(tool), tool, paths: protectedPaths };

    if (typeof record.command === "string") {
        const shellPaths = findProtectedPathsInCommand(record.command);
        if (shellPaths.length > 0) return { kind: "shell", tool, paths: shellPaths };
    }

    return undefined;
}

export function blockedAccessMessage(blocked: BlockedAccess): string {
    const targets = blocked.paths.map((p) => `\`${p}\``).join(", ");
    const help = "Call envsitter_help for a usage guide.";

    if (blocked.kind === "read") {
        return `Reading \`.env*\` is blocked to prevent secret leaks (${targets}). Use EnvSitter tools instead (never prints values). ${help}`;
    }
    if (blocked.kind === "edit") {
        return `Editing \`.env*\` and \`.envsitter/pepper\` via standard tools is blocked (${targets}). Use EnvSitter mutation tools: envsitter_add, envsitter_set, envsitter_unset, envsitter_delete. ${help}`;
    }
    if (blocked.kind === "shell") {
        return `Shell commands that reference \`.env*\` files or \`.envsitter/pepper\` are blocked (${targets}). Use EnvSitter tools or the envsitter CLI, which never print values. ${help}`;
    }
    return `Access to \`.env*\` files and \`.envsitter/pepper\` through \`${blocked.tool}\` is blocked (${targets}). Use EnvSitter tools instead. ${help}`;
}

export function permissionDenial(action: string, resources: readonly string[]): string | undefined {
    if (action === "read" || action === "edit") {
        const paths = resources.filter(isProtectedPath);
        if (paths.length > 0) return blockedAccessMessage({ kind: action, tool: action, paths });
    }

    if (action === "shell") {
        const paths = resources.flatMap(findProtectedPathsInCommand);
        if (paths.length > 0) return blockedAccessMessage({ kind: "shell", tool: action, paths });
    }

    return undefined;
}

function hiddenMatchesNote(hidden: number): string {
    return `(${hidden} match${hidden === 1 ? "" : "es"} in protected .env files hidden by envsitter-guard. Use EnvSitter tools to inspect them.)`;
}

// OpenCode grep output (V1 and V2): "Found N matches", then per file a "<path>:" header, "  Line N: text" rows, and a blank line.
export function redactGrepOutput(output: string): { output: string; hidden: number } {
    const kept: string[] = [];
    let hidden = 0;
    let skipping = false;

    for (const line of output.split("\n")) {
        const header = /^(\S.*):$/.exec(line);
        if (header && !line.startsWith("Found ")) {
            skipping = isProtectedPath(header[1] ?? "");
            if (skipping) continue;
        } else if (skipping && line.startsWith("  Line ")) {
            hidden += 1;
            continue;
        } else if (skipping && line === "") {
            skipping = false;
            continue;
        }
        kept.push(line);
    }

    if (hidden === 0) return { output, hidden };

    const recounted = kept.join("\n").replace(/^Found (\d+) matches/, (_match, total: string) => `Found ${Math.max(0, Number(total) - hidden)} matches`);
    return { output: `${recounted.trimEnd()}\n\n${hiddenMatchesNote(hidden)}`, hidden };
}

type GrepMatch = { readonly entry?: { readonly path?: unknown } };

export function redactGrepResult<Result extends { readonly content?: unknown; readonly output?: unknown }>(result: Result): Result {
    const content = result.content;
    let redactedContent: unknown = content;

    if (typeof content === "string") {
        redactedContent = redactGrepOutput(content).output;
    } else if (Array.isArray(content)) {
        redactedContent = content.map((part: unknown) => {
            const record = asRecord(part);
            if (record?.type !== "text" || typeof record.text !== "string") return part;
            return { ...record, text: redactGrepOutput(record.text).output };
        });
    }

    const output = Array.isArray(result.output)
        ? (result.output as GrepMatch[]).filter((match) => {
              const matchPath = match.entry?.path;
              return typeof matchPath !== "string" || !isProtectedPath(matchPath);
          })
        : result.output;

    return { ...result, content: redactedContent, output };
}
