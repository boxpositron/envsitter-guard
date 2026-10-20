import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createScrubLoader, findSensitiveEnvFiles, scrubToolResult } from "../lib/scrub.js";

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
