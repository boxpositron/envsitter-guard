import path from "node:path";

import { tool } from "@opencode-ai/plugin/tool";
import {
    EnvSitter,
    addEnvFileKey,
    annotateEnvFile,
    copyEnvFileKeys,
    deleteEnvFileKeys,
    formatEnvFile,
    isEnvFile,
    isEnvSitterPepperFile,
    setEnvFileKey,
    unsetEnvFileKey,
    validateEnvFile,
    type EnvSitterMatcher,
} from "envsitter";
import type { z } from "zod";

import { HELP_TOPICS, helpText } from "./help.js";
import { normalizePath, stripAtPrefix } from "./policy.js";

const schema = tool.schema;

const MATCH_OPS = [
    "exists",
    "is_empty",
    "is_equal",
    "partial_match_prefix",
    "partial_match_suffix",
    "partial_match_regex",
    "is_number",
    "is_boolean",
    "is_string",
] as const;

const SCAN_DETECTIONS = ["jwt", "url", "base64"] as const;

export type ToolEnvironment = {
    readonly directory: string;
    readonly root: string;
};

// For sessions outside a repository OpenCode reports the filesystem root as the project root. Use the session
// directory there instead, so the tools and the output scan stay inside it rather than covering the whole disk.
export function projectRoot(root: string, directory: string): string {
    const resolved = path.resolve(root);
    return path.parse(resolved).root === resolved ? path.resolve(directory) : root;
}

export type GuardTool = {
    readonly name: string;
    readonly description: string;
    readonly args: z.ZodRawShape;
    readonly inputSchema: Record<string, unknown>;
    readonly run: (input: unknown, env: ToolEnvironment) => Promise<string>;
};

function defineTool<Shape extends z.ZodRawShape>(definition: {
    name: string;
    description: string;
    args: Shape;
    run: (args: z.infer<z.ZodObject<Shape>>, env: ToolEnvironment) => Promise<unknown>;
}): GuardTool {
    const parser = schema.object(definition.args);
    const { $schema: _dialect, ...inputSchema } = schema.toJSONSchema(parser);

    return {
        name: definition.name,
        description: definition.description,
        args: definition.args,
        inputSchema,
        async run(input, env) {
            const output = await definition.run(parser.parse(input ?? {}), env);
            return typeof output === "string" ? output : JSON.stringify(output, null, 2);
        },
    };
}

function resolveEnvFilePath(env: ToolEnvironment, filePath: string | undefined): { absolutePath: string; displayPath: string } {
    const normalized = normalizePath(stripAtPrefix(filePath ?? ".env"));

    if (isEnvSitterPepperFile(normalized)) {
        throw new Error("Access to `.envsitter/pepper` is blocked.");
    }

    if (!isEnvFile(normalized)) {
        throw new Error("Only dotenv files are allowed (e.g. `.env`, `.env.local`, `api.env`, `.env.example`).");
    }

    const absolutePath = path.resolve(env.directory, normalized);
    const relativeToRoot = path.relative(env.root, absolutePath);
    if (relativeToRoot.split(path.sep)[0] === ".." || path.isAbsolute(relativeToRoot)) {
        throw new Error("EnvSitter tools only operate on files inside the current project.");
    }

    return { absolutePath, displayPath: relativeToRoot };
}

function parseUserRegExp(input: string): RegExp {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return new RegExp(trimmed);

    let lastSlashIndex = -1;
    for (let i = trimmed.length - 1; i >= 1; i -= 1) {
        if (trimmed[i] !== "/") continue;

        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && trimmed[j] === "\\"; j -= 1) {
            backslashCount += 1;
        }

        if (backslashCount % 2 === 0) {
            lastSlashIndex = i;
            break;
        }
    }

    if (lastSlashIndex === -1) {
        throw new Error("Invalid regex literal; expected a closing `/`.");
    }

    const body = trimmed.slice(1, lastSlashIndex);
    const flags = trimmed.slice(lastSlashIndex + 1);
    if (!/^[a-z]*$/.test(flags)) {
        throw new Error("Invalid regex literal flags; expected only letters (e.g. `/abc/i`).");
    }

    return new RegExp(body, flags);
}

function resolveCandidate(params: { candidate?: string | undefined; candidateEnvVar?: string | undefined }): string {
    if (typeof params.candidate === "string" && params.candidate.length > 0) return params.candidate;

    if (typeof params.candidateEnvVar === "string" && params.candidateEnvVar.length > 0) {
        const value = process.env[params.candidateEnvVar];
        if (typeof value === "string" && value.length > 0) return value;
        throw new Error(`Env var \`${params.candidateEnvVar}\` was not set.`);
    }

    throw new Error("Candidate is required for this operation. Provide `candidate` or `candidateEnvVar`.");
}

function buildMatcher(op: (typeof MATCH_OPS)[number], candidateSource: { candidate?: string | undefined; candidateEnvVar?: string | undefined }): EnvSitterMatcher {
    if (op === "exists" || op === "is_empty" || op === "is_number" || op === "is_boolean" || op === "is_string") {
        return { op };
    }

    const candidate = resolveCandidate(candidateSource);
    if (op === "is_equal") return { op, candidate };
    if (op === "partial_match_prefix") return { op, prefix: candidate };
    if (op === "partial_match_suffix") return { op, suffix: candidate };
    return { op, regex: parseUserRegExp(candidate) };
}

function parseCandidatesJson(json: string): Record<string, string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error("Invalid candidates JSON; expected an object mapping key -> candidate string.");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid candidates JSON; expected an object mapping key -> candidate string.");
    }

    const candidates: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "string") {
            throw new Error("Invalid candidates JSON; expected every value to be a string.");
        }
        candidates[key] = value;
    }
    return candidates;
}

const formatArgs = {
    filePath: schema.string().optional(),
    mode: schema.enum(["sections", "global"] as const).optional(),
    sort: schema.enum(["alpha", "none"] as const).optional(),
    write: schema.boolean().optional(),
};

async function runFormat(args: z.infer<z.ZodObject<typeof formatArgs>>, env: ToolEnvironment) {
    const resolved = resolveEnvFilePath(env, args.filePath);
    const result = await formatEnvFile({
        file: resolved.absolutePath,
        mode: args.mode,
        sort: args.sort,
        write: args.write === true,
    });

    return {
        file: resolved.displayPath,
        mode: result.mode,
        sort: result.sort,
        willWrite: result.willWrite,
        wrote: result.wrote,
        hasChanges: result.hasChanges,
        issues: result.issues,
    };
}

export const guardTools: readonly GuardTool[] = [
    defineTool({
        name: "envsitter_keys",
        description: "List keys in a .env file (never returns values).",
        args: {
            filePath: schema.string().optional(),
            filterRegex: schema.string().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
            const keys = await es.listKeys(args.filterRegex ? { filter: parseUserRegExp(args.filterRegex) } : {});
            return { file: resolved.displayPath, keys };
        },
    }),
    defineTool({
        name: "envsitter_fingerprint",
        description: "Compute a deterministic fingerprint for a single key (never returns the value).",
        args: {
            filePath: schema.string().optional(),
            key: schema.string(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
            const result = await es.fingerprintKey(args.key);
            return { file: resolved.displayPath, key: args.key, result };
        },
    }),
    defineTool({
        name: "envsitter_match",
        description:
            "Match key values without printing them. Supports existence/shape checks and outside-in candidate matching.",
        args: {
            filePath: schema.string().optional(),
            op: schema.enum(MATCH_OPS).optional(),
            key: schema.string().optional(),
            keys: schema.array(schema.string()).optional(),
            allKeys: schema.boolean().optional(),
            candidate: schema.string().optional(),
            candidateEnvVar: schema.string().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            const matcher = buildMatcher(args.op ?? "is_equal", args);

            const hasKey = typeof args.key === "string";
            const hasKeys = Array.isArray(args.keys) && args.keys.length > 0;
            const allKeys = args.allKeys === true;
            if (Number(hasKey) + Number(hasKeys) + Number(allKeys) !== 1) {
                throw new Error("Provide exactly one of: `key`, `keys`, or `allKeys: true`.");
            }

            const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
            if (typeof args.key === "string") {
                const match = await es.matchKey(args.key, matcher);
                return { file: resolved.displayPath, key: args.key, op: matcher.op, match };
            }

            const matches = hasKeys && args.keys ? await es.matchKeyBulk(args.keys, matcher) : await es.matchKeyAll(matcher);
            return { file: resolved.displayPath, op: matcher.op, matches };
        },
    }),
    defineTool({
        name: "envsitter_match_by_key",
        description: "Bulk match candidates-by-key without printing values (returns booleans only).",
        args: {
            filePath: schema.string().optional(),
            candidatesByKey: schema.record(schema.string(), schema.string()).optional(),
            candidatesByKeyJson: schema.string().optional(),
            candidatesByKeyEnvVar: schema.string().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);

            const selectorCount =
                Number(!!args.candidatesByKey) + Number(!!args.candidatesByKeyJson) + Number(!!args.candidatesByKeyEnvVar);
            if (selectorCount !== 1) {
                throw new Error(
                    "Provide exactly one of: `candidatesByKey`, `candidatesByKeyJson`, or `candidatesByKeyEnvVar`.",
                );
            }

            let candidatesByKey: Record<string, string>;
            if (args.candidatesByKey) {
                candidatesByKey = args.candidatesByKey;
            } else if (args.candidatesByKeyJson) {
                candidatesByKey = parseCandidatesJson(args.candidatesByKeyJson);
            } else {
                const envVarName = args.candidatesByKeyEnvVar ?? "";
                const value = process.env[envVarName];
                if (typeof value !== "string") throw new Error(`Env var \`${envVarName}\` was not set.`);
                candidatesByKey = parseCandidatesJson(value);
            }

            const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
            const matches = await es.matchCandidatesByKey(candidatesByKey);
            return { file: resolved.displayPath, matches };
        },
    }),
    defineTool({
        name: "envsitter_scan",
        description: "Scan value shapes (jwt/url/base64) without printing values.",
        args: {
            filePath: schema.string().optional(),
            detect: schema.array(schema.enum(SCAN_DETECTIONS)).optional(),
            keysFilterRegex: schema.string().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
            const findings = await es.scan({
                ...(args.detect ? { detect: args.detect } : {}),
                ...(args.keysFilterRegex ? { keysFilter: parseUserRegExp(args.keysFilterRegex) } : {}),
            });
            return { file: resolved.displayPath, findings };
        },
    }),
    defineTool({
        name: "envsitter_validate",
        description: "Validate dotenv syntax (never returns values).",
        args: {
            filePath: schema.string().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            const result = await validateEnvFile(resolved.absolutePath);
            return { file: resolved.displayPath, ok: result.ok, issues: result.issues };
        },
    }),
    defineTool({
        name: "envsitter_copy",
        description: "Copy keys between dotenv files safely (no values in output). Dry-run unless `write: true`.",
        args: {
            from: schema.string(),
            to: schema.string(),
            keys: schema.array(schema.string()).optional(),
            includeRegex: schema.string().optional(),
            excludeRegex: schema.string().optional(),
            rename: schema.string().optional(),
            onConflict: schema.enum(["error", "skip", "overwrite"] as const).optional(),
            write: schema.boolean().optional(),
        },
        async run(args, env) {
            const from = resolveEnvFilePath(env, args.from);
            const to = resolveEnvFilePath(env, args.to);

            if (typeof args.rename === "string" && args.rename.trim().length === 0) {
                throw new Error("Invalid `rename`; expected a non-empty string like `A=B,C=D`.");
            }

            const result = await copyEnvFileKeys({
                from: from.absolutePath,
                to: to.absolutePath,
                ...(args.keys && args.keys.length > 0 ? { keys: args.keys } : {}),
                ...(args.includeRegex ? { include: parseUserRegExp(args.includeRegex) } : {}),
                ...(args.excludeRegex ? { exclude: parseUserRegExp(args.excludeRegex) } : {}),
                ...(args.rename ? { rename: args.rename } : {}),
                ...(args.onConflict ? { onConflict: args.onConflict } : {}),
                write: args.write === true,
            });

            return {
                from: from.displayPath,
                to: to.displayPath,
                onConflict: result.onConflict,
                willWrite: result.willWrite,
                wrote: result.wrote,
                hasChanges: result.hasChanges,
                issues: result.issues,
                plan: result.plan,
            };
        },
    }),
    defineTool({
        name: "envsitter_format",
        description: "Format/reorder a dotenv file (no values in output). Dry-run unless `write: true`.",
        args: formatArgs,
        run: runFormat,
    }),
    defineTool({
        name: "envsitter_reorder",
        description: "Alias for envsitter_format.",
        args: formatArgs,
        run: runFormat,
    }),
    defineTool({
        name: "envsitter_annotate",
        description: "Annotate a dotenv key with a comment (no values in output). Dry-run unless `write: true`.",
        args: {
            filePath: schema.string().optional(),
            key: schema.string(),
            comment: schema.string(),
            line: schema.number().int().optional(),
            write: schema.boolean().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            if (args.comment.trim().length === 0) {
                throw new Error("Comment must be a non-empty string.");
            }

            const result = await annotateEnvFile({
                file: resolved.absolutePath,
                key: args.key,
                comment: args.comment,
                ...(args.line !== undefined ? { line: args.line } : {}),
                write: args.write === true,
            });

            return {
                file: resolved.displayPath,
                key: result.key,
                willWrite: result.willWrite,
                wrote: result.wrote,
                hasChanges: result.hasChanges,
                issues: result.issues,
                plan: result.plan,
            };
        },
    }),
    defineTool({
        name: "envsitter_add",
        description: "Add a new key to a dotenv file (fails if key already exists). Dry-run unless `write: true`.",
        args: {
            filePath: schema.string().optional(),
            key: schema.string(),
            value: schema.string(),
            write: schema.boolean().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            const result = await addEnvFileKey({
                file: resolved.absolutePath,
                key: args.key,
                value: args.value,
                write: args.write === true,
            });
            return { ...result, file: resolved.displayPath };
        },
    }),
    defineTool({
        name: "envsitter_set",
        description:
            "Set a key's value in a dotenv file (creates if missing, updates if exists). Dry-run unless `write: true`.",
        args: {
            filePath: schema.string().optional(),
            key: schema.string(),
            value: schema.string(),
            write: schema.boolean().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            const result = await setEnvFileKey({
                file: resolved.absolutePath,
                key: args.key,
                value: args.value,
                write: args.write === true,
            });
            return { ...result, file: resolved.displayPath };
        },
    }),
    defineTool({
        name: "envsitter_unset",
        description:
            "Unset a key's value in a dotenv file (sets to empty string, keeps the key). Dry-run unless `write: true`.",
        args: {
            filePath: schema.string().optional(),
            key: schema.string(),
            write: schema.boolean().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            const result = await unsetEnvFileKey({
                file: resolved.absolutePath,
                key: args.key,
                write: args.write === true,
            });
            return { ...result, file: resolved.displayPath };
        },
    }),
    defineTool({
        name: "envsitter_delete",
        description: "Delete key(s) from a dotenv file entirely (removes the line). Dry-run unless `write: true`.",
        args: {
            filePath: schema.string().optional(),
            keys: schema.array(schema.string()),
            write: schema.boolean().optional(),
        },
        async run(args, env) {
            const resolved = resolveEnvFilePath(env, args.filePath);
            const result = await deleteEnvFileKeys({
                file: resolved.absolutePath,
                keys: args.keys,
                write: args.write === true,
            });
            return { ...result, file: resolved.displayPath };
        },
    }),
    defineTool({
        name: "envsitter_help",
        description:
            "Get comprehensive help on all EnvSitter tools. Call this to understand how to safely work with .env files without exposing secrets.",
        args: {
            topic: schema.enum(HELP_TOPICS).optional(),
        },
        async run(args) {
            return helpText(args.topic ?? "all");
        },
    }),
];
