import fs from "node:fs/promises";
import path from "node:path";

import { EnvSitter, isSensitiveEnvFile, type EnvSitterRedactor } from "envsitter";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", "target", "vendor", ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv"]);
const MAX_DEPTH = 3;
const MAX_ENV_FILES = 50;

export type Scrub = (text: string) => string;

type CachedRedactor = {
    readonly mtimeMs: number;
    readonly size: number;
    readonly redactor: EnvSitterRedactor;
};

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

export async function findSensitiveEnvFiles(root: string): Promise<string[]> {
    const found: string[] = [];
    let level = [root];

    for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
        const next: string[] = [];
        for (const dir of level) {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (error) {
                const code = errorCode(error);
                if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") continue;
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
        if (errorCode(error) !== "ENOENT") throw error;
        cache.delete(file);
        return undefined;
    }
    if (!info.isFile()) return undefined;

    const cached = cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.redactor;

    const redactor = await EnvSitter.fromDotenvFile(file).redactor();
    cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, redactor });
    return redactor;
}

// Redactors are cached per env file and rebuilt when the file's mtime or size changes.
export function createScrubLoader(root: string): () => Promise<Scrub> {
    const cache = new Map<string, CachedRedactor>();

    return async () => {
        const redactors: EnvSitterRedactor[] = [];
        for (const file of await findSensitiveEnvFiles(root)) {
            const redactor = await redactorFor(file, cache);
            if (redactor && redactor.keys.length > 0) redactors.push(redactor);
        }
        return (text) => redactors.reduce((current, redactor) => redactor.redact(current).text, text);
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
