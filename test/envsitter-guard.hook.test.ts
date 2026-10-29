import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import EnvSitterGuard from "../index.js";

type ToolExecuteBeforeHook = NonNullable<Hooks["tool.execute.before"]>;
type ToolExecuteAfterHook = NonNullable<Hooks["tool.execute.after"]>;

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

async function getHooks(params: { directory: string; worktree: string }) {
    const { client, calls } = createClientSpy();

    const pluginInput: PluginInput = {
        client: client as unknown as PluginInput["client"],
        project: {} as unknown as PluginInput["project"],
        directory: params.directory,
        worktree: params.worktree,
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://localhost"),
        $: (() => {
            throw new Error("not used in tests");
        }) as unknown as PluginInput["$"],
    };

    const hooks = (await EnvSitterGuard.server(pluginInput)) as {
        "tool.execute.before": ToolExecuteBeforeHook;
        "tool.execute.after": ToolExecuteAfterHook;
    };

    return { before: hooks["tool.execute.before"], after: hooks["tool.execute.after"], calls };
}

async function getBeforeHook() {
    const worktree = await createTmpDir();
    return getHooks({ directory: worktree, worktree });
}

function call(tool: string) {
    return { tool, sessionID: "s", callID: "c" };
}

test("blocks reading .env", async () => {
    const { before } = await getBeforeHook();

    await assert.rejects(
        () => before(call("read"), { args: { filePath: ".env" } }),
        (err: unknown) => err instanceof Error && err.message.includes("Reading `.env*` is blocked"),
    );
});

test("allows reading example and template env files", async () => {
    const { before } = await getBeforeHook();

    for (const filePath of [".env.example", ".env.sample", ".env.template", "api.env.example"]) {
        await before(call("read"), { args: { filePath } });
    }
});

test("blocks reading named env files such as api.env and config.env.local", async () => {
    const { before } = await getBeforeHook();

    for (const filePath of ["api.env", "config/config.env.local", "/abs/project/.env.production"]) {
        await assert.rejects(
            () => before(call("read"), { args: { filePath } }),
            (err: unknown) => err instanceof Error && err.message.includes("Reading `.env*` is blocked"),
            filePath,
        );
    }
});

test("blocks editing .env", async () => {
    const { before } = await getBeforeHook();

    await assert.rejects(
        () => before(call("edit"), { args: { filePath: ".env" } }),
        (err: unknown) => err instanceof Error && err.message.includes("Editing `.env*"),
    );
});

test("blocks apply_patch when the patch touches .env", async () => {
    const { before } = await getBeforeHook();
    const patchText = ["*** Begin Patch", "*** Update File: src/app.ts", "@@", "*** Add File: .env.local", "+TOKEN=x", "*** End Patch"].join("\n");

    await assert.rejects(
        () => before(call("apply_patch"), { args: { patchText } }),
        (err: unknown) => err instanceof Error && err.message.includes("`.env.local`"),
    );

    await before(call("apply_patch"), { args: { patchText: "*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch" } });
});

test("blocks shell commands that name .env files but allows the envsitter CLI", async () => {
    const { before } = await getBeforeHook();

    await assert.rejects(
        () => before(call("bash"), { args: { command: "cat .env | head -5" } }),
        (err: unknown) => err instanceof Error && err.message.includes("Shell commands that reference"),
    );

    await before(call("bash"), { args: { command: "npx envsitter keys --file .env --json" } });
    await before(call("bash"), { args: { command: 'git commit -m "document .env usage"' } });
});

test("blocks .envsitter/pepper", async () => {
    const { before } = await getBeforeHook();

    await assert.rejects(
        () => before(call("read"), { args: { filePath: ".envsitter/pepper" } }),
        (err: unknown) => err instanceof Error && err.message.includes("blocked"),
    );
});

test("strips @ prefix in filePath", async () => {
    const { before } = await getBeforeHook();

    await assert.rejects(
        () => before(call("read"), { args: { filePath: "@.env" } }),
        (err: unknown) => err instanceof Error && err.message.includes("Reading `.env*` is blocked"),
    );
});

test("blocking is silent (no toasts)", async () => {
    const { before, calls } = await getBeforeHook();

    await assert.rejects(() => before(call("read"), { args: { filePath: ".env" } }));
    await assert.rejects(() => before(call("read"), { args: { filePath: ".env" } }));

    assert.equal(calls.showToast, 0, "should not show toasts, only throw errors");
});

test("hides grep matches from protected env files", async () => {
    const { after } = await getBeforeHook();
    const output = {
        title: "TOKEN",
        metadata: {},
        output: ["Found 3 matches", "/repo/.env:", "  Line 1: TOKEN=super-secret", "", "/repo/src/app.ts:", "  Line 4: process.env.TOKEN", "  Line 9: TOKEN"].join("\n"),
    };

    await after({ ...call("grep"), args: { pattern: "TOKEN" } }, output);

    assert.ok(!output.output.includes("super-secret"));
    assert.ok(output.output.startsWith("Found 2 matches"));
    assert.ok(output.output.includes("/repo/src/app.ts:"));
    assert.ok(output.output.includes("1 match in protected .env files hidden"));
});

test("a session outside a repository scans its own directory, not the filesystem root", async (t) => {
    const directory = await createTmpDir();
    await fs.writeFile(path.join(directory, ".env"), "API_TOKEN=tok_live_9f8a7b6c5d4e\n");
    const filesystemRoot = path.parse(directory).root;
    const listed: string[] = [];
    const realReaddir = fs.readdir.bind(fs) as (dir: string, options?: unknown) => Promise<unknown>;
    t.mock.method(fs, "readdir", async (dir: string, options?: unknown) => {
        listed.push(dir);
        return realReaddir(dir, options);
    });

    const { after } = await getHooks({ directory, worktree: filesystemRoot });
    const output = { title: "pwd", metadata: {}, output: "token tok_live_9f8a7b6c5d4e\n" };
    await after({ ...call("bash"), args: { command: "pwd" } }, output);

    assert.equal(output.output, "token [envsitter: API_TOKEN redacted]\n");
    assert.ok(!listed.includes(filesystemRoot), "must not list the filesystem root");
});

test("scrubs secret values from any tool output, such as shell commands that never name .env", async () => {
    const worktree = await createTmpDir();
    await fs.writeFile(path.join(worktree, ".env"), "API_TOKEN=tok_live_9f8a7b6c5d4e\nNODE_ENV=development\n");
    const { after } = await getHooks({ directory: worktree, worktree });

    const output = { title: "cat logs/app.log", metadata: {}, output: "env=development\ncalling api with tok_live_9f8a7b6c5d4e\n" };
    await after({ ...call("bash"), args: { command: "cat logs/app.log" } }, output);

    assert.equal(output.output, "env=development\ncalling api with [envsitter: API_TOKEN redacted]\n");
});
