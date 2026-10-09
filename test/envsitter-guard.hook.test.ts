import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadPlugin } from "./plugin-fixture.js";

test("blocks native reads and edits of secrets, but permits examples and safe tools", async () => {
    const { before } = await loadPlugin({ directory: process.cwd(), worktree: process.cwd() });
    for (const path of [".env", ".env.local", ".env.production", ".envsitter/pepper", "@.env"]) {
        await assert.rejects(() => before("read", { path }), /Reading `.env\*` is blocked/);
        for (const tool of ["edit", "write", "multiedit"]) {
            await assert.rejects(() => before(tool, { path }), /Editing `.env\*`/);
        }
    }
    await before("read", { path: ".env.example" });
    await before("edit", { path: ".env.example" });
    await before("read", { path: "index.ts" });
    await before("envsitter_keys", { filePath: ".env" });
});

test("recognizes legacy filePath and file_path arguments", async () => {
    const { before } = await loadPlugin({ directory: process.cwd(), worktree: process.cwd() });
    await assert.rejects(() => before("read", { filePath: "@.env" }), /blocked/);
    await assert.rejects(() => before("write", { file_path: ".env.local" }), /blocked/);
});

test("blocks every sensitive patch target, including moves and multi-file patches", async () => {
    const { before } = await loadPlugin({ directory: process.cwd(), worktree: process.cwd() });
    for (const header of [
        "*** Add File: .env.local\n+KEY=value",
        "*** Update File: .env\n@@\n-KEY=old\n+KEY=new",
        "*** Delete File: .env.production",
        "*** Update File: index.ts\n*** Move to: .env.local",
        "*** Update File: .env\n*** Move to: .env.example",
        "*** Add File: .env.example\n+KEY=\n*** Delete File: .envsitter/pepper",
        "  *** Delete File: .envsitter/./pepper  ",
    ]) {
        await assert.rejects(
            () => before("patch", { patchText: `*** Begin Patch\r\n${header}\r\n*** End Patch` }),
            /Editing `.env\*`/,
        );
    }
    await before("patch", { patchText: "*** Begin Patch\n*** Add File: .env.example\n+KEY=\n*** End Patch" });
});

test("protects pepper when paths are relative to the active directory", async () => {
    const worktree = process.cwd();
    const { before } = await loadPlugin({ directory: path.join(worktree, ".envsitter"), worktree });
    await assert.rejects(() => before("read", { path: "pepper" }), /blocked/);
    await assert.rejects(() => before("write", { path: "./pepper" }), /blocked/);
    await assert.rejects(() => before("patch", {
        patchText: "*** Begin Patch\n*** Delete File: pepper\n*** End Patch",
    }), /blocked/);
    await before("read", { path: "../.env.example" });
});
