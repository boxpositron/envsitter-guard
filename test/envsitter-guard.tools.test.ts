import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PluginInput } from "@opencode-ai/plugin";

import EnvSitterGuard from "../index.js";

type MatchOp =
    | "exists"
    | "is_empty"
    | "is_equal"
    | "partial_match_prefix"
    | "partial_match_suffix"
    | "partial_match_regex"
    | "is_number"
    | "is_boolean"
    | "is_string";

type ScanDetection = "jwt" | "url" | "base64";

type ToolApi = {
    envsitter_keys: {
        execute: (args: { filePath?: string; filterRegex?: string }) => Promise<string>;
    };
    envsitter_fingerprint: {
        execute: (args: { filePath?: string; key: string }) => Promise<string>;
    };
    envsitter_match: {
        execute: (args: {
            filePath?: string;
            op?: MatchOp;
            key?: string;
            keys?: string[];
            allKeys?: boolean;
            candidate?: string;
            candidateEnvVar?: string;
        }) => Promise<string>;
    };
    envsitter_match_by_key: {
        execute: (args: {
            filePath?: string;
            candidatesByKey?: Record<string, string>;
            candidatesByKeyJson?: string;
            candidatesByKeyEnvVar?: string;
        }) => Promise<string>;
    };
    envsitter_scan: {
        execute: (args: { filePath?: string; detect?: ScanDetection[]; keysFilterRegex?: string }) => Promise<string>;
    };
    envsitter_validate: {
        execute: (args: { filePath?: string }) => Promise<string>;
    };
    envsitter_copy: {
        execute: (args: {
            from: string;
            to: string;
            keys?: string[];
            includeRegex?: string;
            excludeRegex?: string;
            rename?: string;
            onConflict?: "error" | "skip" | "overwrite";
            write?: boolean;
        }) => Promise<string>;
    };
    envsitter_format: {
        execute: (args: {
            filePath?: string;
            mode?: "sections" | "global";
            sort?: "alpha" | "none";
            write?: boolean;
        }) => Promise<string>;
    };
    envsitter_reorder: {
        execute: (args: {
            filePath?: string;
            mode?: "sections" | "global";
            sort?: "alpha" | "none";
            write?: boolean;
        }) => Promise<string>;
    };
    envsitter_annotate: {
        execute: (args: { filePath?: string; key: string; comment: string; line?: number; write?: boolean }) => Promise<string>;
    };
};

async function createTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envsitter-guard-"));
    return dir;
}

async function withEnvVar<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
    const previous = process.env[name];
    process.env[name] = value;

    try {
        return await fn();
    } finally {
        if (previous === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = previous;
        }
    }
}

async function withPepper<T>(fn: () => Promise<T>): Promise<T> {
    return withEnvVar("ENVSITTER_PEPPER", "test-pepper", fn);
}

function createMinimalClient(): PluginInput["client"] {
    return {
        tui: {
            async showToast() {},
            async appendPrompt() {},
        },
    } as unknown as PluginInput["client"];
}

async function getTools(params: { directory: string; worktree: string }): Promise<ToolApi> {
    const pluginInput: PluginInput = {
        client: createMinimalClient(),
        project: {} as unknown as PluginInput["project"],
        directory: params.directory,
        worktree: params.worktree,
        serverUrl: new URL("http://localhost"),
        $: (() => {
            throw new Error("not used in tests");
        }) as unknown as PluginInput["$"],
    };

    const hooks = (await EnvSitterGuard(pluginInput)) as unknown as {
        tool: ToolApi;
    };

    return hooks.tool;
}

test("envsitter_keys lists keys without values", async () => {
    await withPepper(async () => {
        const worktree = await createTmpDir();
        await fs.writeFile(path.join(worktree, ".env"), "FOO=bar\nBAZ=qux\n");

        const tools = await getTools({ directory: worktree, worktree });
        const out = await tools.envsitter_keys.execute({ filePath: ".env" });

        assert.ok(!out.includes("bar"));
        assert.ok(!out.includes("qux"));

        const parsed = JSON.parse(out) as { file: string; keys: string[] };
        assert.equal(parsed.file, ".env");
        assert.deepEqual(parsed.keys.sort(), ["BAZ", "FOO"].sort());
    });
});

test("envsitter_keys supports filterRegex", async () => {
    await withPepper(async () => {
        const worktree = await createTmpDir();
        await fs.writeFile(path.join(worktree, ".env"), "FOO=bar\nBAZ=qux\n");

        const tools = await getTools({ directory: worktree, worktree });
        const out = await tools.envsitter_keys.execute({ filePath: ".env", filterRegex: "/^FOO$/" });

        const parsed = JSON.parse(out) as { keys: string[] };
        assert.deepEqual(parsed.keys, ["FOO"]);
    });
});

test("envsitter_fingerprint is deterministic and does not leak values", async () => {
    await withPepper(async () => {
        const worktree = await createTmpDir();
        await fs.writeFile(path.join(worktree, ".env"), "DATABASE_URL=postgres://user:pass@host/db\n");

        const tools = await getTools({ directory: worktree, worktree });
        const out1 = await tools.envsitter_fingerprint.execute({ filePath: ".env", key: "DATABASE_URL" });
        const out2 = await tools.envsitter_fingerprint.execute({ filePath: ".env", key: "DATABASE_URL" });

        assert.ok(!out1.includes("postgres://"));
        assert.equal(out1, out2);

        const parsed = JSON.parse(out1) as { file: string; key: string; result: unknown };
        assert.equal(parsed.file, ".env");
        assert.equal(parsed.key, "DATABASE_URL");
    });
});

test("envsitter_match supports exists", async () => {
    await withPepper(async () => {
        const worktree = await createTmpDir();
        await fs.writeFile(path.join(worktree, ".env"), "FOO=bar\n");

        const tools = await getTools({ directory: worktree, worktree });
        const out = await tools.envsitter_match.execute({ filePath: ".env", key: "FOO", op: "exists" });

        const parsed = JSON.parse(out) as { key: string; match: boolean };
        assert.equal(parsed.key, "FOO");
        assert.equal(parsed.match, true);
    });
});

test("envsitter_match supports is_equal via candidateEnvVar", async () => {
    await withPepper(async () => {
        const worktree = await createTmpDir();
        await fs.writeFile(path.join(worktree, ".env"), "FOO=bar\n");

        await withEnvVar("ENVSITTER_TEST_CANDIDATE", "bar", async () => {
            const tools = await getTools({ directory: worktree, worktree });
            const out = await tools.envsitter_match.execute({
                filePath: ".env",
                key: "FOO",
                op: "is_equal",
                candidateEnvVar: "ENVSITTER_TEST_CANDIDATE",
            });

            assert.ok(!out.includes("bar"));

            const parsed = JSON.parse(out) as { match: boolean };
            assert.equal(parsed.match, true);
        });
    });
});

test("envsitter_match supports bulk keys", async () => {
    await withPepper(async () => {
        const worktree = await createTmpDir();
        await fs.writeFile(path.join(worktree, ".env"), "FOO=bar\n");

        const tools = await getTools({ directory: worktree, worktree });
        const out = await tools.envsitter_match.execute({ filePath: ".env", keys: ["FOO", "BAZ"], op: "exists" });

        const parsed = JSON.parse(out) as { matches: Array<{ key: string; match: boolean }> };
        const byKey = new Map(parsed.matches.map((entry) => [entry.key, entry.match]));
        assert.equal(byKey.get("FOO"), true);
        assert.equal(byKey.get("BAZ"), false);
    });
});

test("envsitter_match_by_key matches candidates without leaking values", async () => {
    await withPepper(async () => {
        const worktree = await createTmpDir();
        await fs.writeFile(path.join(worktree, ".env"), "FOO=bar\nBAZ=qux\n");

        const tools = await getTools({ directory: worktree, worktree });
        const out = await tools.envsitter_match_by_key.execute({
            filePath: ".env",
            candidatesByKey: {
                FOO: "bar",
                BAZ: "nope",
            },
        });

        assert.ok(!out.includes("bar"));
        assert.ok(!out.includes("qux"));

        const parsed = JSON.parse(out) as { matches: Array<{ key: string; match: boolean }> };
        const byKey = new Map(parsed.matches.map((entry) => [entry.key, entry.match]));
        assert.equal(byKey.get("FOO"), true);
        assert.equal(byKey.get("BAZ"), false);
    });
});

test("envsitter_scan detects shapes without leaking values", async () => {
    await withPepper(async () => {
        const worktree = await createTmpDir();
        const jwt =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

        await fs.writeFile(
            path.join(worktree, ".env"),
            [
                `JWT_TOKEN=${jwt}`,
                "SOME_URL=https://example.com",
                "SOME_BASE64=SGVsbG8=",
                "PLAIN=hello",
            ].join("\n") + "\n",
        );

        const tools = await getTools({ directory: worktree, worktree });
        const out = await tools.envsitter_scan.execute({ filePath: ".env", detect: ["jwt", "url", "base64"] });

        assert.ok(!out.includes(jwt));
        assert.ok(!out.includes("https://example.com"));

        const parsed = JSON.parse(out) as { findings: Array<{ key: string; detections: string[] }> };
        const byKey = new Map(parsed.findings.map((finding) => [finding.key, finding.detections]));

        assert.ok(byKey.get("JWT_TOKEN")?.includes("jwt"));
        assert.ok(byKey.get("SOME_URL")?.includes("url"));
        assert.ok(byKey.get("SOME_BASE64")?.includes("base64"));
    });
});

test("tool execution rejects paths outside worktree", async () => {
    const worktree = await createTmpDir();
    const directory = path.join(worktree, "a", "b");
    await fs.mkdir(directory, { recursive: true });

    const tools = await getTools({ directory, worktree });

    await assert.rejects(
        () => tools.envsitter_keys.execute({ filePath: "../../../.env" }),
        (err: unknown) => err instanceof Error && err.message.includes("inside the current project"),
    );
});

test("tool execution blocks .envsitter/pepper", async () => {
    const worktree = await createTmpDir();
    const tools = await getTools({ directory: worktree, worktree });

    await assert.rejects(
        () => tools.envsitter_keys.execute({ filePath: ".envsitter/pepper" }),
        (err: unknown) => err instanceof Error && err.message.includes("blocked"),
    );
});

test("envsitter_validate returns issues without leaking values", async () => {
    const worktree = await createTmpDir();
    await fs.writeFile(path.join(worktree, ".env"), "GOOD=supersecret\nBAD\n");

    const tools = await getTools({ directory: worktree, worktree });
    const out = await tools.envsitter_validate.execute({ filePath: ".env" });

    assert.ok(!out.includes("supersecret"));

    const parsed = JSON.parse(out) as { file: string; ok: boolean; issues: Array<{ line: number; column: number; message: string }> };
    assert.equal(parsed.file, ".env");
    assert.equal(parsed.ok, false);
    assert.ok(parsed.issues.length > 0);
});

test("envsitter_copy dry-runs unless write=true", async () => {
    const worktree = await createTmpDir();
    await fs.writeFile(path.join(worktree, ".env.production"), "FOO=bar\nBAZ=qux\n");
    await fs.writeFile(path.join(worktree, ".env.staging"), "FOO=old\n");

    const tools = await getTools({ directory: worktree, worktree });

    const outDryRun = await tools.envsitter_copy.execute({
        from: ".env.production",
        to: ".env.staging",
        keys: ["BAZ"],
        onConflict: "overwrite",
    });

    assert.ok(!outDryRun.includes("bar"));
    assert.ok(!outDryRun.includes("qux"));

    const stagingAfterDryRun = await fs.readFile(path.join(worktree, ".env.staging"), "utf8");
    assert.ok(!stagingAfterDryRun.includes("BAZ=qux"));

    const outWrite = await tools.envsitter_copy.execute({
        from: ".env.production",
        to: ".env.staging",
        keys: ["BAZ"],
        onConflict: "overwrite",
        write: true,
    });

    assert.ok(!outWrite.includes("bar"));
    assert.ok(!outWrite.includes("qux"));

    const stagingAfterWrite = await fs.readFile(path.join(worktree, ".env.staging"), "utf8");
    assert.ok(stagingAfterWrite.includes("BAZ=qux"));
});

test("envsitter_format sorts keys without leaking values", async () => {
    const worktree = await createTmpDir();
    await fs.writeFile(path.join(worktree, ".env"), "B=2\nA=1\n");

    const tools = await getTools({ directory: worktree, worktree });
    const out = await tools.envsitter_format.execute({ filePath: ".env", mode: "global", sort: "alpha", write: true });

    assert.ok(!out.includes("=1"));
    assert.ok(!out.includes("=2"));

    const content = await fs.readFile(path.join(worktree, ".env"), "utf8");
    assert.ok(content.indexOf("A=1") < content.indexOf("B=2"));
});

test("envsitter_annotate adds comments without leaking values", async () => {
    const worktree = await createTmpDir();
    await fs.writeFile(path.join(worktree, ".env"), "FOO=bar\n");

    const tools = await getTools({ directory: worktree, worktree });
    const out = await tools.envsitter_annotate.execute({ filePath: ".env", key: "FOO", comment: "prod only", write: true });

    assert.ok(!out.includes("bar"));

    const content = await fs.readFile(path.join(worktree, ".env"), "utf8");
    assert.ok(content.includes("prod only"));
    assert.ok(content.includes("FOO=bar"));
});
