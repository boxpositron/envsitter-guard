import type { Plugin } from "@opencode/plugin";
import type { JsonSchema } from "effect";

import { blockedAccessMessage, findBlockedAccess, permissionDenial, redactGrepResult } from "./policy.js";
import { createScrubLoader, scrubToolResult } from "./scrub.js";
import { guardTools, type ToolEnvironment } from "./tools.js";

export async function setupV2(ctx: Plugin.Context): Promise<void> {
    const env: ToolEnvironment = {
        directory: ctx.location.directory,
        root: ctx.location.project.directory,
    };
    const loadScrub = createScrubLoader(env.root);

    await ctx.tool.transform((editor) => {
        for (const guardTool of guardTools) {
            editor.add({
                name: guardTool.name,
                description: guardTool.description,
                input: guardTool.inputSchema as JsonSchema.JsonSchema,
                options: { codemode: false },
                execute: async (input) => ({ content: await guardTool.run(input, env) }),
            });
        }
    });

    await ctx.tool.hook("execute.before", (event) => {
        const blocked = findBlockedAccess(event.tool, event.input);
        if (blocked) throw new Error(blockedAccessMessage(blocked));
    });

    await ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed" || event.tool.startsWith("envsitter_")) return;
        const result = event.tool === "grep" ? redactGrepResult(event.result) : event.result;
        event.result = scrubToolResult(result, await loadScrub());
    });

    await ctx.permission.hook("evaluate", (event) => {
        const message = permissionDenial(event.action, event.resources);
        if (!message) return;
        event.effect = "deny";
        event.message = message;
    });
}
