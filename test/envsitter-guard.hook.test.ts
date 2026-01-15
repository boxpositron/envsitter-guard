import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import EnvSitterGuard from "../index.js";

type ToolExecuteBeforeHook = NonNullable<Hooks["tool.execute.before"]>;

async function createTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envsitter-guard-"));
    return dir;
}

function createClientSpy(): {
    client: {
        tui: {
            showToast: (input: { body: { title: string; variant: string; message: string } }) => Promise<void>;
        };
    };
    calls: { showToast: number };
} {
    const calls = { showToast: 0 };

    return {
        calls,
        client: {
            tui: {
                async showToast() {
                    calls.showToast += 1;
                },
            },
        },
    };
}

async function getBeforeHook(params: { directory: string; worktree: string }) {
    const { client, calls } = createClientSpy();

    const pluginInput: PluginInput = {
        client: client as unknown as PluginInput["client"],
        project: {} as unknown as PluginInput["project"],
        directory: params.directory,
        worktree: params.worktree,
        serverUrl: new URL("http://localhost"),
        $: (() => {
            throw new Error("not used in tests");
        }) as unknown as PluginInput["$"],
    };

    const hooks = (await EnvSitterGuard(pluginInput)) as {
        "tool.execute.before": ToolExecuteBeforeHook;
    };

    return { hook: hooks["tool.execute.before"], calls };
}

test("blocks reading .env", async () => {
    const worktree = await createTmpDir();
    const { hook } = await getBeforeHook({ directory: worktree, worktree });

    await assert.rejects(
        () => hook({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: ".env" } }),
        (err: unknown) => err instanceof Error && err.message.includes("Reading `.env*` is blocked"),
    );
});

test("allows reading .env.example", async () => {
    const worktree = await createTmpDir();
    const { hook } = await getBeforeHook({ directory: worktree, worktree });

    await hook({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: ".env.example" } });
});

test("blocks editing .env", async () => {
    const worktree = await createTmpDir();
    const { hook } = await getBeforeHook({ directory: worktree, worktree });

    await assert.rejects(
        () => hook({ tool: "edit", sessionID: "s", callID: "c" }, { args: { filePath: ".env" } }),
        (err: unknown) => err instanceof Error && err.message.includes("Editing `.env*"),
    );
});

test("blocks .envsitter/pepper", async () => {
    const worktree = await createTmpDir();
    const { hook } = await getBeforeHook({ directory: worktree, worktree });

    await assert.rejects(
        () => hook({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: ".envsitter/pepper" } }),
        (err: unknown) => err instanceof Error && err.message.includes("blocked"),
    );
});

test("strips @ prefix in filePath", async () => {
    const worktree = await createTmpDir();
    const { hook } = await getBeforeHook({ directory: worktree, worktree });

    await assert.rejects(
        () => hook({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: "@.env" } }),
        (err: unknown) => err instanceof Error && err.message.includes("Reading `.env*` is blocked"),
    );
});

test("blocking is silent (no toasts)", async () => {
    const worktree = await createTmpDir();
    const { hook, calls } = await getBeforeHook({ directory: worktree, worktree });

    await assert.rejects(() => hook({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: ".env" } }));
    await assert.rejects(() => hook({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: ".env" } }));

    assert.equal(calls.showToast, 0, "should not show toasts, only throw errors");
});
