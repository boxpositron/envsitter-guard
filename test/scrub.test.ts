import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createScrubLoader, findSensitiveEnvFiles, scrubToolResult } from "../lib/scrub.js";
import { projectRoot } from "../lib/tools.js";

const TOKEN = "tok_live_9f8a7b6c5d4e";
const DB_PASSWORD = "s3cretPassw0rd";

async function createProject(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envsitter-guard-scrub-"));
    for (const [name, contents] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await fs.writeFile(path.join(dir, name), contents);
    }
    return dir;
}

test("finds sensitive env files in the project, skipping examples and dependency folders", async () => {
    const root = await createProject({
        ".env": `API_TOKEN=${TOKEN}\n`,
        ".env.example": "API_TOKEN=replace-me\n",
        "apps/web/.env.local": `DATABASE_URL=postgres://app:${DB_PASSWORD}@db:5432/app\n`,
        "node_modules/pkg/.env": "X=1\n",
        "a/b/c/d/.env": "TOO_DEEP=1\n",
    });

    const files = (await findSensitiveEnvFiles(root)).map((file) => path.relative(root, file));
    assert.deepEqual(files, [".env", path.join("apps", "web", ".env.local")]);
});

test("scrub replaces secret values from every env file and leaves other text alone", async () => {
    const root = await createProject({
        ".env": `API_TOKEN=${TOKEN}\nNODE_ENV=development\n`,
        "apps/web/.env.local": `DATABASE_URL=postgres://app:${DB_PASSWORD}@db:5432/app\n`,
    });

    const scrub = await createScrubLoader(root)();
    const output = scrub(`Bearer ${TOKEN}\npassword=${DB_PASSWORD}\nNODE_ENV=development`);
    assert.equal(output, "Bearer [envsitter: API_TOKEN redacted]\npassword=[envsitter: DATABASE_URL redacted]\nNODE_ENV=development");
});

test("scrub picks up env file changes", async () => {
    const root = await createProject({ ".env": `API_TOKEN=${TOKEN}\n` });
    const loadScrub = createScrubLoader(root);
    assert.ok(!(await loadScrub())(TOKEN).includes(TOKEN));

    const rotated = "tok_live_0a1b2c3d4e5f6a7b8c";
    await fs.writeFile(path.join(root, ".env"), `API_TOKEN=${rotated}\n`);
    const scrub = await loadScrub();
    assert.equal(scrub(rotated), "[envsitter: API_TOKEN redacted]");
    assert.equal(scrub(TOKEN), TOKEN);
});

test("scrubToolResult scrubs text content and structured output, and keeps untouched results identical", () => {
    const scrub = (text: string) => text.replaceAll(TOKEN, "[x]");

    const result = {
        content: [{ type: "text", text: `token ${TOKEN}` }, { type: "image", data: TOKEN }],
        output: { stdout: `ok ${TOKEN}`, exitCode: 0, lines: [TOKEN, "fine"] },
        metadata: { title: "t" },
    };
    const scrubbed = scrubToolResult(result, scrub);
    assert.deepEqual(scrubbed.content, [{ type: "text", text: "token [x]" }, { type: "image", data: TOKEN }]);
    assert.deepEqual(scrubbed.output, { stdout: "ok [x]", exitCode: 0, lines: ["[x]", "fine"] });
    assert.equal(scrubbed.metadata, result.metadata);

    const clean = { content: "nothing secret", output: { exitCode: 0 } };
    assert.equal(scrubToolResult(clean, scrub), clean);
});

const NESTED_TOKEN = "tok_nested_1a2b3c4d5e6f";
const realReaddir = fs.readdir.bind(fs) as (dir: string, options?: unknown) => Promise<unknown>;

test("skips directories the system refuses to list instead of failing", async (t) => {
    const root = await createProject({ ".env": `API_TOKEN=${TOKEN}\n`, "locked/app.env": `NESTED_TOKEN=${NESTED_TOKEN}\n` });
    const locked = path.join(root, "locked");
    t.mock.method(fs, "readdir", async (dir: string, options?: unknown) => {
        if (dir === locked) throw Object.assign(new Error(`EPERM: operation not permitted, scandir '${locked}'`), { code: "EPERM" });
        return realReaddir(dir, options);
    });

    const files = (await findSensitiveEnvFiles(root)).map((file) => path.relative(root, file));
    assert.deepEqual(files, [".env"]);
    assert.equal((await createScrubLoader(root)())(TOKEN), "[envsitter: API_TOKEN redacted]");
});

test("an env-named file that is not dotenv does not break scrubbing", async () => {
    const root = await createProject({
        ".env": `API_TOKEN=${TOKEN}\n`,
        "ios/.xcode.env": "export NODE_BINARY=$(command -v node)\nif [ -f .xcode.env.local ]; then\n  source .xcode.env.local\nfi\n",
    });

    const scrub = await createScrubLoader(root)();
    assert.equal(scrub(`Bearer ${TOKEN}`), "Bearer [envsitter: API_TOKEN redacted]");
});

test("a filesystem-root project falls back to the session directory", () => {
    const session = path.join(os.tmpdir(), "session");
    assert.equal(projectRoot(path.parse(session).root, session), session);
    assert.equal(projectRoot("/repo", "/repo/packages/app"), "/repo");
});

test("home directories are only checked at the top level", { skip: process.platform === "win32" ? "HOME is POSIX-only" : false }, async (t) => {
    const home = await createProject({ ".env": `API_TOKEN=${TOKEN}\n`, "work/app/.env": `NESTED_TOKEN=${NESTED_TOKEN}\n` });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    t.after(() => {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
    });

    const files = (await findSensitiveEnvFiles(home)).map((file) => path.relative(home, file));
    assert.deepEqual(files, [".env"]);
});

test("the filesystem root is never walked below its top level", async (t) => {
    const root = path.parse(process.cwd()).root;
    const calls: string[] = [];
    t.mock.method(fs, "readdir", async (dir: string, options?: unknown) => {
        calls.push(dir);
        return realReaddir(dir, options);
    });

    await findSensitiveEnvFiles(root);
    assert.deepEqual(calls, [root]);
});

test("the env file list is reused between calls and rescanned once it expires", async (t) => {
    const root = await createProject({ ".env": `API_TOKEN=${TOKEN}\n` });
    const calls: string[] = [];
    t.mock.method(fs, "readdir", async (dir: string, options?: unknown) => {
        calls.push(dir);
        return realReaddir(dir, options);
    });

    const cached = createScrubLoader(root, { listTtlMs: 60_000 });
    await cached();
    const firstScan = calls.length;
    assert.ok(firstScan > 0);
    await cached();
    assert.equal(calls.length, firstScan, "a second call within the TTL must not rescan");

    await fs.writeFile(path.join(root, "app.env"), `SECOND_TOKEN=${NESTED_TOKEN}\n`);
    const uncached = createScrubLoader(root, { listTtlMs: 0 });
    assert.equal((await uncached())(NESTED_TOKEN), "[envsitter: SECOND_TOKEN redacted]");
});

test("an unexpected scan failure keeps the last working scrub instead of failing the tool call", async (t) => {
    const root = await createProject({ ".env": `API_TOKEN=${TOKEN}\n` });
    const load = createScrubLoader(root, { listTtlMs: 0 });
    assert.equal((await load())(TOKEN), "[envsitter: API_TOKEN redacted]");

    t.mock.method(fs, "readdir", async () => {
        throw new Error("unexpected");
    });
    assert.equal((await load())(TOKEN), "[envsitter: API_TOKEN redacted]");
    assert.equal((await createScrubLoader(root)())(TOKEN), TOKEN);
});
