import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EnvSitter, isSensitiveEnvFile, type EnvSitterRedactor } from "envsitter";

const SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    "target",
    "vendor",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".Trash",
    ".npm",
    ".pnpm-store",
    ".yarn",
    ".gradle",
    ".terraform",
    "Pods",
    "DerivedData",
]);
const MAX_DEPTH = 3;
const MAX_ENV_FILES = 50;
const MAX_DIRECTORIES = 1000;
const LIST_TTL_MS = 2000;

export type Scrub = (text: string) => string;

export type ScrubLoaderOptions = {
    // How long the list of env files is reused before rescanning; file contents are re-checked on every call.
    readonly listTtlMs?: number;
};

type CachedRedactor = {
    readonly mtimeMs: number;
    readonly size: number;
    readonly redactor: EnvSitterRedactor | undefined;
};

const keepText: Scrub = (text) => text;

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

// A home directory or filesystem root is not a project: only its own env files are checked, not the tree below it.
function scanDepthFor(root: string): number {
    const resolved = path.resolve(root);
    const isWideRoot = path.parse(resolved).root === resolved || resolved === path.resolve(os.homedir());
    return isWideRoot ? 0 : MAX_DEPTH;
}

export async function findSensitiveEnvFiles(root: string, maxDepth = scanDepthFor(root)): Promise<string[]> {
    const found: string[] = [];
    let level = [root];
    let visited = 0;

    for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
        const next: string[] = [];
        for (const dir of level) {
            visited += 1;
            if (visited > MAX_DIRECTORIES) return found.sort();

            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (error) {
                // Unreadable directories are normal (macOS reports EPERM for protected ones such as ~/.Trash): skip them.
                if (errorCode(error) !== undefined) continue;
                throw error;
            }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!SKIP_DIRS.has(entry.name)) next.push(fullPath);
                } else if ((entry.isFile() || entry.isSymbolicLink()) && isSensitiveEnvFile(fullPath)) {
                    found.push(fullPath);
                    if (found.length >= MAX_ENV_FILES) return found.sort();
                }
            }
        }
        level = next;
    }

    return found.sort();
}

async function redactorFor(file: string, cache: Map<string, CachedRedactor>): Promise<EnvSitterRedactor | undefined> {
    let info;
    try {
        info = await fs.stat(file);
    } catch (error) {
        if (errorCode(error) === undefined) throw error;
        cache.delete(file);
        return undefined;
    }
    if (!info.isFile()) return undefined;

    const cached = cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.redactor;

    let redactor: EnvSitterRedactor | undefined;
    try {
        redactor = await EnvSitter.fromDotenvFile(file).redactor();
    } catch (error) {
        // A file that cannot be read or parsed (React Native's ios/.xcode.env is a shell script, for example) adds no
        // redactions. Remember that until the file changes instead of failing every tool call.
        if (!(error instanceof Error)) throw error;
        redactor = undefined;
    }
    cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, redactor });
    return redactor;
}

// Redactors are cached per env file and rebuilt when the file's mtime or size changes.
export function createScrubLoader(root: string, options: ScrubLoaderOptions = {}): () => Promise<Scrub> {
    const listTtlMs = options.listTtlMs ?? LIST_TTL_MS;
    const cache = new Map<string, CachedRedactor>();
    let files: string[] | undefined;
    let listedAt = 0;
    let lastScrub: Scrub = keepText;

    return async () => {
        try {
            const now = Date.now();
            if (files === undefined || now - listedAt >= listTtlMs) {
                files = await findSensitiveEnvFiles(root);
                listedAt = now;
            }

            const redactors: EnvSitterRedactor[] = [];
            for (const file of files) {
                const redactor = await redactorFor(file, cache);
                if (redactor && redactor.keys.length > 0) redactors.push(redactor);
            }
            lastScrub = redactors.length === 0 ? keepText : (text) => redactors.reduce((current, redactor) => redactor.redact(current).text, text);
        } catch (error) {
            // Scrubbing decorates a result whose tool has already run, so it must never turn that result into a failure:
            // keep the last scrub that worked (values seen before stay redacted) and retry on the next call.
            if (!(error instanceof Error)) throw error;
            files = undefined;
        }
        return lastScrub;
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function scrubContent(content: unknown, scrub: Scrub): unknown {
    if (typeof content === "string") return scrub(content);
    if (!Array.isArray(content)) return content;

    let changed = false;
    const parts = content.map((part: unknown) => {
        const record = asRecord(part);
        if (record?.type !== "text" || typeof record.text !== "string") return part;
        const text = scrub(record.text);
        if (text === record.text) return part;
        changed = true;
        return { ...record, text };
    });
    return changed ? parts : content;
}

function scrubStrings(value: unknown, scrub: Scrub): unknown {
    if (typeof value === "string") return scrub(value);

    if (Array.isArray(value)) {
        let changed = false;
        const items = value.map((item: unknown) => {
            const scrubbed = scrubStrings(item, scrub);
            if (scrubbed !== item) changed = true;
            return scrubbed;
        });
        return changed ? items : value;
    }

    const record = asRecord(value);
    if (!record || (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null)) return value;

    let changed = false;
    const entries = Object.entries(record).map(([key, item]) => {
        const scrubbed = scrubStrings(item, scrub);
        if (scrubbed !== item) changed = true;
        return [key, scrubbed] as const;
    });
    return changed ? Object.fromEntries(entries) : value;
}

export function scrubToolResult<Result extends { readonly content?: unknown; readonly output?: unknown }>(result: Result, scrub: Scrub): Result {
    const content = scrubContent(result.content, scrub);
    const output = scrubStrings(result.output, scrub);
    if (content === result.content && output === result.output) return result;
    return { ...result, content, output };
}
