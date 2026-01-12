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
                },
                async execute(args) {
                    const resolved = resolveDotEnvPath({
                        worktree,
                        directory,
                        filePath: args.filePath ?? ".env",
                    });

                    const es = EnvSitter.fromDotenvFile(resolved.absolutePath);
                    const keys = await es.listKeys();

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
