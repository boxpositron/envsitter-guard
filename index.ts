import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { EnvSitter } from "envsitter";
import path from "node:path";

function normalizePath(input: string): string {
    return input.replace(/\\/g, "/");
}

function isDotEnvExamplePath(input: string): boolean {
    return /(^|\/)\.env\.example$/.test(normalizePath(input));
}

function isSensitiveDotEnvPath(input: string): boolean {
    const normalized = normalizePath(input);
    if (isDotEnvExamplePath(normalized)) return false;
    return /(^|\/)\.env($|\.)/.test(normalized);
}

function isDotEnvishPath(input: string): boolean {
    const normalized = normalizePath(input);
    return isDotEnvExamplePath(normalized) || isSensitiveDotEnvPath(normalized);
}

function isEnvSitterPepperPath(input: string): boolean {
    const normalized = normalizePath(input);
    return /(^|\/)\.envsitter\/pepper$/.test(normalized);
}

function stripAtPrefix(input: string): string {
    return input.trim().replace(/^@+/, "");
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

        const isEscaped = backslashCount % 2 === 1;
        if (!isEscaped) {
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

function resolveCandidate(params: { candidate?: string; candidateEnvVar?: string }): string {
    if (typeof params.candidate === "string" && params.candidate.length > 0) return params.candidate;

    if (typeof params.candidateEnvVar === "string" && params.candidateEnvVar.length > 0) {
        const value = process.env[params.candidateEnvVar];
        if (typeof value === "string" && value.length > 0) return value;
        throw new Error(`Env var \`${params.candidateEnvVar}\` was not set.`);
    }

    throw new Error("Candidate is required for this operation. Provide `candidate` or `candidateEnvVar`.");
}

function getFilePathFromArgs(args: unknown): string | undefined {
    if (!args || typeof args !== "object") return;
    const record = args as Record<string, unknown>;

    const candidates: Array<unknown> = [record.filePath, record.path, record.file_path];

    const found = candidates.find((value) => typeof value === "string") as string | undefined;
    return found ? stripAtPrefix(found) : undefined;
}

function resolveDotEnvPath(params: {
    worktree: string;
    directory: string;
    filePath: string;
}): { absolutePath: string; displayPath: string } {
    const normalized = normalizePath(params.filePath);

    if (isEnvSitterPepperPath(normalized)) {
        throw new Error("Access to `.envsitter/pepper` is blocked.");
    }

    if (!isDotEnvishPath(normalized)) {
        throw new Error("Only `.env`-style paths are allowed (e.g. `.env`, `.env.local`, `.env.example`).");
    }

    const absolutePath = path.resolve(params.directory, normalized);
    const relativeToWorktree = path.relative(params.worktree, absolutePath);
    if (relativeToWorktree.startsWith("..") || path.isAbsolute(relativeToWorktree)) {
        throw new Error("EnvSitter tools only operate on files inside the current project.");
    }

    return { absolutePath, displayPath: relativeToWorktree };
}

export const EnvSitterGuard: Plugin = async ({ client, directory, worktree }) => {
    let lastToastAt = 0;

    const matchOps = [
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

    const scanDetections = ["jwt", "url", "base64"] as const;

    async function notifyBlocked(action: string): Promise<void> {
        const now = Date.now();
        if (now - lastToastAt < 5000) return;
        lastToastAt = now;

        await client.tui.showToast({
            body: {
                title: "Blocked sensitive file access",
                variant: "warning",
                message:
                    `${action} of sensitive env files is blocked. Use EnvSitter instead (never prints values):\n` +
                    "- envsitter_keys { filePath: '.env' }\n" +
                    "- envsitter_fingerprint { filePath: '.env', key: 'SOME_KEY' }\n" +
                    "- envsitter_match { filePath: '.env', key: 'SOME_KEY', op: 'exists' }\n" +
                    "- envsitter_scan { filePath: '.env', detect: ['jwt','url'] }\n" +
                    "(CLI: `npx envsitter keys --file .env`) ",
            },
        });

        await client.tui.appendPrompt({
            body: {
                text: "\nTip: use EnvSitter for `.env*` inspection (keys/fingerprints) instead of reading the file.\n",
            },
        });
    }

    return {
        tool: {
            envsitter_keys: tool({
                description: "List keys in a .env file (never returns values).",
                args: {
                    filePath: tool.schema.string().optional(),
                    filterRegex: tool.schema.string().optional(),
                },
                async execute(args) {
                    const resolved = resolveDotEnvPath({
                        worktree,
                        directory,
                        filePath: args.filePath ?? ".env",
                    });

                    const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
                    const keys = await es.listKeys(
                        args.filterRegex
                            ? {
                                  filter: parseUserRegExp(args.filterRegex),
                              }
                            : undefined,
                    );

                    return JSON.stringify({ file: resolved.displayPath, keys }, null, 2);
                },
            }),
            envsitter_fingerprint: tool({
                description: "Compute a deterministic fingerprint for a single key (never returns the value).",
                args: {
                    filePath: tool.schema.string().optional(),
                    key: tool.schema.string(),
                },
                async execute(args) {
                    const resolved = resolveDotEnvPath({
                        worktree,
                        directory,
                        filePath: args.filePath ?? ".env",
                    });

                    const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
                    const result = await es.fingerprintKey(args.key);

                    return JSON.stringify({ file: resolved.displayPath, key: args.key, result }, null, 2);
                },
            }),
            envsitter_match: tool({
                description:
                    "Match key values without printing them. Supports existence/shape checks and outside-in candidate matching.",
                args: {
                    filePath: tool.schema.string().optional(),
                    op: tool.schema.enum(matchOps).optional(),
                    key: tool.schema.string().optional(),
                    keys: tool.schema.array(tool.schema.string()).optional(),
                    allKeys: tool.schema.boolean().optional(),
                    candidate: tool.schema.string().optional(),
                    candidateEnvVar: tool.schema.string().optional(),
                },
                async execute(args) {
                    const resolved = resolveDotEnvPath({
                        worktree,
                        directory,
                        filePath: args.filePath ?? ".env",
                    });

                    const op = args.op ?? "is_equal";
                    const es = EnvSitter.fromDotenvFile(resolved.absolutePath);

                    const matcher = (() => {
                        if (op === "exists") return { op } as const;
                        if (op === "is_empty") return { op } as const;
                        if (op === "is_number") return { op } as const;
                        if (op === "is_boolean") return { op } as const;
                        if (op === "is_string") return { op } as const;

                        const candidate = resolveCandidate({
                            candidate: args.candidate,
                            candidateEnvVar: args.candidateEnvVar,
                        });

                        if (op === "is_equal") {
                            return { op, candidate } as const;
                        }

                        if (op === "partial_match_prefix") {
                            return { op, prefix: candidate } as const;
                        }

                        if (op === "partial_match_suffix") {
                            return { op, suffix: candidate } as const;
                        }

                        if (op === "partial_match_regex") {
                            return { op, regex: parseUserRegExp(candidate) } as const;
                        }

                        throw new Error(`Unsupported op: ${op}`);
                    })();

                    const key = args.key;
                    const keys = args.keys;
                    const allKeys = args.allKeys === true;

                    const selectorCount =
                        Number(typeof key === "string") + Number(Array.isArray(keys) && keys.length > 0) + Number(allKeys);
                    if (selectorCount !== 1) {
                        throw new Error("Provide exactly one of: `key`, `keys`, or `allKeys: true`. ");
                    }

                    if (typeof key === "string") {
                        const match = await es.matchKey(key, matcher);
                        return JSON.stringify({ file: resolved.displayPath, key, op: matcher.op, match }, null, 2);
                    }

                    if (Array.isArray(keys) && keys.length > 0) {
                        const matches = await es.matchKeyBulk(keys, matcher);
                        return JSON.stringify({ file: resolved.displayPath, op: matcher.op, matches }, null, 2);
                    }

                    const matches = await es.matchKeyAll(matcher);
                    return JSON.stringify({ file: resolved.displayPath, op: matcher.op, matches }, null, 2);
                },
            }),
            envsitter_match_by_key: tool({
                description: "Bulk match candidates-by-key without printing values (returns booleans only).",
                args: {
                    filePath: tool.schema.string().optional(),
                    candidatesByKey: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
                    candidatesByKeyJson: tool.schema.string().optional(),
                    candidatesByKeyEnvVar: tool.schema.string().optional(),
                },
                async execute(args) {
                    const resolved = resolveDotEnvPath({
                        worktree,
                        directory,
                        filePath: args.filePath ?? ".env",
                    });

                    const fromRecord = args.candidatesByKey;
                    const fromJson = args.candidatesByKeyJson;
                    const fromEnvVar = args.candidatesByKeyEnvVar;

                    const selectorCount = Number(!!fromRecord) + Number(!!fromJson) + Number(!!fromEnvVar);
                    if (selectorCount !== 1) {
                        throw new Error(
                            "Provide exactly one of: `candidatesByKey`, `candidatesByKeyJson`, or `candidatesByKeyEnvVar`.",
                        );
                    }

                    let candidatesByKey: Record<string, string>;

                    if (fromRecord) {
                        candidatesByKey = fromRecord;
                    } else {
                        const json =
                            typeof fromJson === "string"
                                ? fromJson
                                : (() => {
                                      const envVarName = fromEnvVar as string;
                                      const value = process.env[envVarName];
                                      if (typeof value !== "string") throw new Error(`Env var \`${envVarName}\` was not set.`);
                                      return value;
                                  })();

                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(json);
                        } catch {
                            throw new Error("Invalid candidates JSON; expected an object mapping key -> candidate string.");
                        }

                        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                            throw new Error("Invalid candidates JSON; expected an object mapping key -> candidate string.");
                        }

                        const record = parsed as Record<string, unknown>;
                        const normalized: Record<string, string> = {};
                        for (const [key, value] of Object.entries(record)) {
                            if (typeof value !== "string") {
                                throw new Error("Invalid candidates JSON; expected every value to be a string.");
                            }
                            normalized[key] = value;
                        }
                        candidatesByKey = normalized;
                    }

                    const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
                    const matches = await es.matchCandidatesByKey(candidatesByKey);

                    return JSON.stringify({ file: resolved.displayPath, matches }, null, 2);
                },
            }),
            envsitter_scan: tool({
                description: "Scan value shapes (jwt/url/base64) without printing values.",
                args: {
                    filePath: tool.schema.string().optional(),
                    detect: tool.schema.array(tool.schema.enum(scanDetections)).optional(),
                    keysFilterRegex: tool.schema.string().optional(),
                },
                async execute(args) {
                    const resolved = resolveDotEnvPath({
                        worktree,
                        directory,
                        filePath: args.filePath ?? ".env",
                    });

                    const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
                    const findings = await es.scan({
                        detect: args.detect,
                        keysFilter: args.keysFilterRegex ? parseUserRegExp(args.keysFilterRegex) : undefined,
                    });

                    return JSON.stringify({ file: resolved.displayPath, findings }, null, 2);
                },
            }),
        },
        "tool.execute.before": async (input, output) => {
            const filePath = getFilePathFromArgs(output.args);
            if (!filePath) return;

            if (!isSensitiveDotEnvPath(filePath) && !isEnvSitterPepperPath(filePath)) return;

            if (input.tool === "read") {
                await notifyBlocked("Reading");
                throw new Error(
                    "Reading `.env*` is blocked. Use EnvSitter tools instead: envsitter_keys / envsitter_fingerprint (never prints values)."
                );
            }

            if (input.tool === "edit" || input.tool === "write" || input.tool === "patch" || input.tool === "multiedit") {
                await notifyBlocked("Editing");
                throw new Error("Editing `.env*` and `.envsitter/pepper` via tools is blocked.");
            }
        },
    };
};

export default EnvSitterGuard;
