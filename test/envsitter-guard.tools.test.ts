import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PluginInput } from "@opencode-ai/plugin";

import EnvSitterGuard from "../index.js";

type ToolApi = {
    envsitter_keys: {
        execute: (args: { filePath?: string }) => Promise<string>;
    };
    envsitter_fingerprint: {
        execute: (args: { filePath?: string; key: string }) => Promise<string>;
    };
};

async function createTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envsitter-guard-"));
    return dir;
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

test("envsitter_fingerprint is deterministic and does not leak values", async () => {
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
