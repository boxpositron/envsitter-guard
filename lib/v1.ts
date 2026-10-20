import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";

import { blockedAccessMessage, findBlockedAccess, redactGrepOutput } from "./policy.js";
import { createScrubLoader } from "./scrub.js";
import { guardTools, type ToolEnvironment } from "./tools.js";

export const serverV1: Plugin = async ({ directory, worktree }) => {
    const env: ToolEnvironment = { directory, root: worktree };
    const loadScrub = createScrubLoader(worktree);

    const tools: NonNullable<Hooks["tool"]> = {};
    for (const guardTool of guardTools) {
        tools[guardTool.name] = tool({
            description: guardTool.description,
            args: guardTool.args,
            execute: (args) => guardTool.run(args, env),
        });
    }

    return {
        tool: tools,
        "tool.execute.before": async (input, output) => {
            const blocked = findBlockedAccess(input.tool, output.args);
            if (blocked) throw new Error(blockedAccessMessage(blocked));
        },
        "tool.execute.after": async (input, output) => {
            if (input.tool.startsWith("envsitter_") || typeof output.output !== "string") return;
            const text = input.tool === "grep" ? redactGrepOutput(output.output).output : output.output;
            output.output = (await loadScrub())(text);
        },
    };
};
