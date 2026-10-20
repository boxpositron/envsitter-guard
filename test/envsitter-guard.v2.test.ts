import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Plugin } from "@opencode/plugin";

import EnvSitterGuard from "../index.js";

type RegisteredTool = {
    name: string;
    description: string;
    input: Record<string, unknown>;
    options?: { codemode?: boolean };
    execute: (input: unknown, context: unknown) => Promise<{ content?: unknown }>;
};

type HookCallback = (event: Record<string, unknown>) => unknown;

const registration = { dispose: async () => {} };

async function setupV2(directory: string, root = directory) {
    const tools = new Map<string, RegisteredTool>();
    const toolHooks = new Map<string, HookCallback>();
    const permissionHooks = new Map<string, HookCallback>();

    const ctx = {
        location: { directory, project: { id: "project", directory: root, canonical: root } },
        options: {},
        tool: {
            async transform(callback: (editor: { add(tool: RegisteredTool): void }) => void) {
                callback({ add: (tool) => tools.set(tool.name, tool) });
                return registration;
            },
            async hook(name: string, callback: HookCallback) {
                toolHooks.set(name, callback);
                return registration;
            },
        },
        permission: {
            async hook(name: string, callback: HookCallback) {
                permissionHooks.set(name, callback);
                return registration;
            },
        },
    } as unknown as Plugin.Context;

    await EnvSitterGuard.setup(ctx);

    const hook = (map: Map<string, HookCallback>, name: string): HookCallback => {
        const callback = map.get(name);
        assert.ok(callback, `missing hook ${name}`);
        return callback;
    };

    return {
        tools,
        before: hook(toolHooks, "execute.before"),
        after: hook(toolHooks, "execute.after"),
        evaluate: hook(permissionHooks, "evaluate"),
    };
}

async function createProject(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envsitter-guard-v2-"));
    for (const [name, contents] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await fs.writeFile(path.join(dir, name), contents);
    }
    return dir;
}

function toolEvent(tool: string, input: Record<string, unknown>) {
    return { tool, sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", input };
}

test("V2 default export carries a stable id plus both entrypoints", () => {
    assert.equal(EnvSitterGuard.id, "envsitter-guard");
    assert.equal(typeof EnvSitterGuard.setup, "function");
    assert.equal(typeof EnvSitterGuard.server, "function");
});

test("V2 registers every envsitter tool directly (not behind Code Mode) with JSON Schema inputs", async () => {
    const { tools } = await setupV2(await createProject({}));

    assert.equal(tools.size, 15);
    for (const tool of tools.values()) {
        assert.ok(tool.name.startsWith("envsitter_"), tool.name);
        assert.equal(tool.options?.codemode, false, tool.name);
        assert.equal(tool.input.type, "object", tool.name);
        assert.equal("$schema" in tool.input, false, tool.name);
    }

    const fingerprint = tools.get("envsitter_fingerprint");
    assert.deepEqual(fingerprint?.input.required, ["key"]);
});

test("V2 tools return structured content without values and validate input", async () => {
    const dir = await createProject({ ".env": "API_TOKEN=very-secret\nPORT=3000\n" });
    const { tools } = await setupV2(dir);

    const keys = tools.get("envsitter_keys");
    assert.ok(keys);
    const result = await keys.execute({ filePath: ".env" }, {});
    assert.equal(typeof result.content, "string");
    assert.ok(!String(result.content).includes("very-secret"));
    assert.deepEqual((JSON.parse(String(result.content)) as { keys: string[] }).keys, ["API_TOKEN", "PORT"]);

    const fingerprint = tools.get("envsitter_fingerprint");
    assert.ok(fingerprint);
    await assert.rejects(() => fingerprint.execute({ filePath: ".env" }, {}));
});

test("V2 tools resolve paths from the plugin location and stay inside the project", async () => {
    const root = await createProject({ "apps/api/.env": "A=1\n" });
    const { tools } = await setupV2(path.join(root, "apps", "api"), root);

    const keys = tools.get("envsitter_keys");
    assert.ok(keys);
    const result = await keys.execute({}, {});
    assert.equal((JSON.parse(String(result.content)) as { file: string }).file, path.join("apps", "api", ".env"));

    await assert.rejects(
        () => keys.execute({ filePath: "../../../outside/.env" }, {}),
        (err: unknown) => err instanceof Error && err.message.includes("inside the current project"),
    );
});

test("V2 execute.before blocks built-in tools on protected files, including nested Code Mode calls", async () => {
    const { before } = await setupV2(await createProject({}));

    assert.throws(() => before(toolEvent("read", { path: ".env" })), /Reading `\.env\*` is blocked/);
    assert.throws(() => before(toolEvent("write", { path: "api.env", content: "X=1" })), /Editing `\.env\*`/);
    assert.throws(
        () => before(toolEvent("patch", { patchText: "*** Begin Patch\n*** Delete File: .env.production\n*** End Patch" })),
        /Editing `\.env\*`/,
    );
    assert.throws(() => before(toolEvent("shell", { command: "source .env && env" })), /Shell commands that reference/);
    assert.throws(() => before(toolEvent("grep", { pattern: "TOKEN", path: ".env.local" })), /Reading `\.env\*` is blocked/);
    assert.throws(() => before(toolEvent("filesystem_read_file", { path: "/abs/.env" })), /through `filesystem_read_file`/);

    before(toolEvent("read", { path: ".env.example" }));
    before(toolEvent("read", { path: "src/index.ts" }));
    before(toolEvent("shell", { command: "npm test" }));
    before(toolEvent("envsitter_keys", { filePath: ".env" }));
});

test("V2 execute.after hides grep matches from protected files in content and structured output", async () => {
    const { after } = await setupV2(await createProject({}));

    const event = {
        ...toolEvent("grep", { pattern: "TOKEN" }),
        status: "completed",
        result: {
            content: ["Found 2 matches", "/repo/.env:", "  Line 1: TOKEN=super-secret", "", "/repo/src/app.ts:", "  Line 3: TOKEN"].join("\n"),
            output: [
                { entry: { path: ".env" }, line: 1, text: "TOKEN=super-secret" },
                { entry: { path: "src/app.ts" }, line: 3, text: "TOKEN" },
            ],
        },
    };

    await after(event);

    const result = event.result as { content: string; output: Array<{ entry: { path: string } }> };
    assert.ok(!result.content.includes("super-secret"));
    assert.ok(result.content.startsWith("Found 1 matches"));
    assert.deepEqual(
        result.output.map((match) => match.entry.path),
        ["src/app.ts"],
    );
});

test("V2 execute.after scrubs secret values from shell results that never name .env", async () => {
    const { after } = await setupV2(await createProject({ ".env": "API_TOKEN=tok_live_9f8a7b6c5d4e\n" }));

    const event = {
        ...toolEvent("shell", { command: "grep -r api ." }),
        status: "completed",
        result: { content: [{ type: "text", text: "./logs/app.log: api key tok_live_9f8a7b6c5d4e" }] },
    };
    await after(event);

    const result = event.result as { content: Array<{ text: string }> };
    assert.equal(result.content[0]?.text, "./logs/app.log: api key [envsitter: API_TOKEN redacted]");
});

test("V2 permission evaluate denies protected read, edit, and shell resources only", async () => {
    const { evaluate } = await setupV2(await createProject({}));

    const deniedRead = { sessionID: "ses_1", action: "read", resources: ["/repo/.env"], effect: "allow" as string, message: undefined as string | undefined };
    await evaluate(deniedRead);
    assert.equal(deniedRead.effect, "deny");
    assert.match(deniedRead.message ?? "", /Reading `\.env\*` is blocked/);

    const deniedShell = { sessionID: "ses_1", action: "shell", resources: ["cat .env.local"], effect: "ask" as string };
    await evaluate(deniedShell);
    assert.equal(deniedShell.effect, "deny");

    const allowed = { sessionID: "ses_1", action: "edit", resources: ["/repo/src/app.ts", "/repo/.env.example"], effect: "allow" as string };
    await evaluate(allowed);
    assert.equal(allowed.effect, "allow");
});
