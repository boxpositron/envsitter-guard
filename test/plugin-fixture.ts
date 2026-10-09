import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import { z } from "zod";

import EnvSitterGuard from "../index.js";

type BeforeHook = (event: Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0]) => Promise<void> | void;

export async function loadPlugin(params: { directory: string; worktree: string }) {
    const definitions = new Map<string, Info>();
    let beforeHook: BeforeHook | undefined;
    const editor: ToolEditor = {
        add(definition) { definitions.set(definition.name, definition); },
        list() { return [...definitions.values()].map((definition) => ({ ...definition, id: definition.name })); },
        get(id) {
            const definition = definitions.get(id);
            return definition === undefined ? undefined : { ...definition, id };
        },
        namespace() { assert.fail("Unexpected namespace registration"); },
        update() { assert.fail("Unexpected tool update"); },
        remove() { assert.fail("Unexpected tool removal"); },
    };
    const context = {
        location: { directory: params.directory, project: { directory: params.worktree } },
        tool: {
            async transform(callback: (editor: ToolEditor) => void) {
                callback(editor);
                return { async dispose() {} };
            },
            async hook(name: string, callback: BeforeHook) {
                assert.equal(name, "execute.before");
                beforeHook = callback;
                return { async dispose() {} };
            },
        },
    };
    // Only the context domains used by this plugin are supplied.
    await EnvSitterGuard.setup(context as unknown as Plugin.Context);
    assert(beforeHook !== undefined);
    const hook = beforeHook;
    return {
        async before(tool: string, input: unknown) {
            await hook({
                tool, input,
                sessionID: "session" as ToolContext["sessionID"],
                agent: "build" as ToolContext["agent"],
                messageID: "message" as ToolContext["messageID"],
                id: "call" as ToolContext["id"],
            });
        },
        tools: Object.fromEntries([...definitions].map(([name, definition]) => [name, {
            async execute(input: unknown): Promise<string> {
                assert(definition.input instanceof z.ZodType);
                const args: unknown = definition.input.parse(input);
                const result = await definition.execute(args, {
                    sessionID: "session" as ToolContext["sessionID"],
                    agent: "build" as ToolContext["agent"],
                    messageID: "message" as ToolContext["messageID"],
                    id: "call" as ToolContext["id"],
                    signal: new AbortController().signal,
                    async progress() {},
                });
                assert.equal(typeof result.content, "string");
                assert(typeof result.content === "string");
                return result.content;
            },
        }])),
    };
}
