#!/usr/bin/env node
// Cross-version end-to-end check: loads the built plugin (dist/) into the real OpenCode 1 and OpenCode 2 CLIs,
// drives them with a scripted OpenAI-compatible model, and asserts what the model receives back from each tool.
// Everything runs in a temporary HOME with fake secrets, so real config, credentials, and databases are never touched.
//
// Usage: npm run build && node scripts/e2e-opencode.mjs
// Env:   OPENCODE_V1_BIN (default "opencode"), OPENCODE_V2_BIN (default "opencode2"), KEEP_E2E=1 to keep the temp dir,
//        E2E_REQUIRE_ALL=1 to fail (instead of skip) when a CLI is missing, as CI does.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginEntry = path.join(repoRoot, "dist", "index.js");
const FAKE_SECRET = "sk-fake-guard-e2e-123";
const RUN_TIMEOUT_MS = 240_000;

if (!fs.existsSync(pluginEntry)) {
    console.error("dist/index.js is missing. Run `npm run build` first.");
    process.exit(2);
}

const versions = [
    {
        name: "OpenCode 1",
        major: 1,
        bin: process.env.OPENCODE_V1_BIN ?? "opencode",
        args: (model, prompt) => ["run", "--model", model, prompt],
    },
    {
        name: "OpenCode 2",
        major: 2,
        bin: process.env.OPENCODE_V2_BIN ?? "opencode2",
        args: (model, prompt) => ["run", "--standalone", "--auto", "--model", model, prompt],
    },
];

const textOf = (content) =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "";
const toolNames = (tools) => tools.map((tool) => tool.function?.name).filter(Boolean);
const toolProps = (tools, name) => tools.find((tool) => tool.function?.name === name)?.function?.parameters?.properties ?? {};
const pathArg = (tools, name, value) => ("filePath" in toolProps(tools, name) ? { filePath: value } : { path: value });
const firstTool = (tools, names) => names.find((name) => toolNames(tools).includes(name));

function scenarios(project) {
    const envFile = path.join(project, ".env");
    const envBefore = fs.readFileSync(envFile, "utf8");
    const noLeak = (result) => !result.includes(FAKE_SECRET);

    return [
        {
            name: "envsitter_keys lists keys without values",
            plan: () => ["envsitter_keys", { filePath: ".env" }],
            pass: (result) => result.includes("API_TOKEN") && result.includes("DB_PASSWORD") && noLeak(result),
        },
        {
            name: "read .env is blocked",
            plan: (tools) => ["read", pathArg(tools, "read", envFile)],
            pass: (result) => result.includes("Reading `.env*` is blocked") && noLeak(result),
        },
        {
            name: "read .env.example is allowed",
            plan: (tools) => ["read", pathArg(tools, "read", path.join(project, ".env.example"))],
            pass: (result) => result.includes("replace-me"),
        },
        {
            name: "write .env is blocked",
            plan: (tools) => ["write", { ...pathArg(tools, "write", envFile), content: "API_TOKEN=overwritten\n" }],
            pass: (result) => result.includes("Editing `.env*`") && fs.readFileSync(envFile, "utf8") === envBefore,
        },
        {
            name: "shell `cat .env` is blocked",
            plan: (tools) => {
                const name = firstTool(tools, ["bash", "shell"]);
                if (!name) return undefined;
                const args = { command: "cat .env" };
                if ("description" in toolProps(tools, name)) args.description = "Print env file";
                return [name, args];
            },
            pass: (result) => result.includes("Shell commands that reference") && noLeak(result),
        },
        {
            name: "shell output reaching .env values without naming the file is scrubbed",
            plan: (tools) => {
                const name = firstTool(tools, ["bash", "shell"]);
                if (!name) return undefined;
                const args = { command: "cat logs/app.log" };
                if ("description" in toolProps(tools, name)) args.description = "Print app log";
                return [name, args];
            },
            pass: (result) => result.includes("Bearer [envsitter: API_TOKEN redacted]") && noLeak(result),
        },
        {
            name: "read of a non-env file containing a secret is scrubbed",
            plan: (tools) => ["read", pathArg(tools, "read", path.join(project, "logs", "app.log"))],
            pass: (result) => result.includes("Bearer [envsitter: API_TOKEN redacted]") && noLeak(result),
        },
        {
            name: "grep hides matches inside .env",
            plan: () => ["grep", { pattern: "API_TOKEN" }],
            pass: (result) => result.includes("app.ts") && noLeak(result),
        },
        {
            name: "patch adding .env.local is blocked",
            model: "mock/gpt-5-scripted",
            plan: (tools) => {
                const name = firstTool(tools, ["apply_patch", "patch"]);
                return name && [name, { patchText: "*** Begin Patch\n*** Add File: .env.local\n+X=1\n*** End Patch" }];
            },
            pass: (result) => result.includes("Editing `.env*`") && !fs.existsSync(path.join(project, ".env.local")),
        },
    ];
}

function startModel(state) {
    const send = (res, chunks) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of chunks) res.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
        res.end();
    };
    const base = { id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 0, model: "scripted" };
    const finish = (reason) => ({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const text = (res, content) =>
        send(res, [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }, finish("stop"), "[DONE]"]);
    const toolCall = (res, name, args) =>
        send(res, [
            {
                ...base,
                choices: [
                    {
                        index: 0,
                        delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_e2e_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
                        finish_reason: null,
                    },
                ],
            },
            finish("tool_calls"),
            "[DONE]",
        ]);

    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
            if (!req.url?.endsWith("/chat/completions")) {
                res.writeHead(404).end();
                return;
            }
            const body = JSON.parse(raw || "{}");
            const messages = body.messages ?? [];
            const tools = body.tools ?? [];
            const marker = messages.map((m) => (m.role === "user" ? /E2E-SCENARIO:(\d+)/.exec(textOf(m.content))?.[1] : undefined)).find(Boolean);
            const scenario = marker === undefined ? undefined : state.scenarios[Number(marker)];
            if (!scenario || tools.length === 0) return text(res, "Guard e2e");

            state.toolNames = toolNames(tools);
            const last = messages.at(-1);
            if (last?.role === "tool") {
                state.result = textOf(last.content);
                return text(res, "DONE");
            }
            const planned = scenario.plan(tools);
            if (!planned) {
                state.result = "<<tool unavailable>>";
                return text(res, "UNAVAILABLE");
            }
            state.call = planned;
            return toolCall(res, planned[0], planned[1]);
        });
    });

    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function createProject(root, baseURL) {
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.mkdirSync(path.join(project, ".opencode", "plugin"), { recursive: true });
    fs.writeFileSync(path.join(project, ".env"), `API_TOKEN=${FAKE_SECRET}\nDB_PASSWORD=fake-db-pass-456\n`);
    fs.writeFileSync(path.join(project, ".env.example"), "API_TOKEN=replace-me\n");
    fs.writeFileSync(path.join(project, "src", "app.ts"), "export const token = process.env.API_TOKEN;\n");
    fs.mkdirSync(path.join(project, "logs"), { recursive: true });
    fs.writeFileSync(path.join(project, "logs", "app.log"), `request ok\nauth header: Bearer ${FAKE_SECRET}\n`);
    // React Native's ios/.xcode.env matches the env-file naming but is a shell script; it must not break any tool call.
    fs.mkdirSync(path.join(project, "ios"), { recursive: true });
    fs.writeFileSync(path.join(project, "ios", ".xcode.env"), "export NODE_BINARY=$(command -v node)\nif [ -f .xcode.env.local ]; then\n  source .xcode.env.local\nfi\n");
    fs.writeFileSync(
        path.join(project, ".opencode", "plugin", "envsitter-guard.ts"),
        `export { default, EnvSitterGuard } from ${JSON.stringify(pluginEntry)};\n`,
    );
    fs.writeFileSync(
        path.join(project, "opencode.json"),
        JSON.stringify(
            {
                $schema: "https://opencode.ai/config.json",
                model: "mock/scripted",
                small_model: "mock/scripted",
                provider: {
                    mock: {
                        npm: "@ai-sdk/openai-compatible",
                        name: "Mock",
                        options: { baseURL, apiKey: "e2e" },
                        models: { scripted: { name: "Scripted", tool_call: true }, "gpt-5-scripted": { name: "GPT 5 Scripted", tool_call: true } },
                    },
                },
                permission: { edit: "allow", bash: "allow", webfetch: "allow" },
            },
            null,
            2,
        ),
    );
    spawnSync("git", ["init", "-q"], { cwd: project });
    return project;
}

function isolatedEnv(home, project) {
    return {
        ...process.env,
        HOME: home,
        PWD: project,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        ENVSITTER_PEPPER: "e2e-pepper",
    };
}

function run(bin, args, options) {
    return new Promise((resolve) => {
        const child = spawn(bin, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.stdout.resume();
        const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stderr });
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ code: -1, stderr: String(error) });
        });
    });
}

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "envsitter-guard-e2e-")));
const state = { scenarios: [] };
const server = await startModel(state);
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
let failures = 0;

for (const version of versions) {
    const probe = spawnSync(version.bin, ["--version"], { encoding: "utf8" });
    const reported = `${probe.stdout ?? ""}`.trim();
    const major = Number(/(\d+)\.\d+\.\d+/.exec(reported)?.[1]);
    if (probe.status !== 0 || major !== version.major) {
        const required = process.env.E2E_REQUIRE_ALL === "1";
        if (required) failures += 1;
        console.log(`\n${version.name}: ${required ? "FAIL, missing" : "skipped"} (\`${version.bin} --version\` reported ${JSON.stringify(reported || probe.error?.message || "nothing")})`);
        continue;
    }

    const versionRoot = path.join(tempRoot, `v${version.major}`);
    const project = createProject(versionRoot, baseURL);
    const env = isolatedEnv(path.join(versionRoot, "home"), project);
    state.scenarios = scenarios(project);
    console.log(`\n${version.name} (${reported})`);

    for (const [index, scenario] of state.scenarios.entries()) {
        state.result = undefined;
        state.call = undefined;
        const outcome = await run(version.bin, version.args(scenario.model ?? "mock/scripted", `E2E-SCENARIO:${index}`), { cwd: project, env });
        const result = state.result ?? "<<no tool result>>";
        const ok = outcome.code === 0 && result !== "<<tool unavailable>>" && scenario.pass(result);
        if (!ok) failures += 1;
        const via = state.call ? ` via ${state.call[0]}` : "";
        console.log(`  ${ok ? "PASS" : "FAIL"} ${scenario.name}${via}`);
        if (!ok) console.log(`       exit=${outcome.code} result=${JSON.stringify(result.slice(0, 300))} stderr=${JSON.stringify(outcome.stderr.slice(-300))}`);
    }

    const visible = (state.toolNames ?? []).filter((name) => name.startsWith("envsitter_")).length;
    const toolsOk = visible === 15;
    if (!toolsOk) failures += 1;
    console.log(`  ${toolsOk ? "PASS" : "FAIL"} model sees all 15 envsitter_* tools directly (${visible})`);
}

server.close();
if (process.env.KEEP_E2E === "1") console.log(`\nKept ${tempRoot}`);
else fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
