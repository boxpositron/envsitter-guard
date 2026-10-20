import assert from "node:assert/strict";
import test from "node:test";

import { extractPatchPaths, findBlockedAccess, findProtectedPathsInCommand, redactGrepOutput } from "../lib/policy.js";

test("shell scan flags commands that name protected files", () => {
    const blocked = [
        "cat .env",
        "source .env",
        ". .env.local",
        "echo TOKEN=x >> .env",
        "cat<.env",
        "node --env-file=.env app.js",
        'echo "$(cat .env)"',
        "echo `cat api.env`",
        "cat .env*",
        "cat .envsitter/pepper",
        "ls && cat config/app.env",
        "envsitter keys --file .env; cat .env",
    ];

    for (const command of blocked) {
        assert.ok(findProtectedPathsInCommand(command).length > 0, command);
    }
});

test("shell scan allows envsitter CLI calls, example files, and prose mentions", () => {
    const allowed = [
        "npx envsitter keys --file .env",
        "npx -y envsitter@latest match --file .env --key A --op exists",
        "envsitter set --file .env.local --key A --value-stdin --write",
        "pnpm dlx envsitter validate --file .env",
        'git commit -m "document .env usage"',
        "cat .env.example",
        "cp .env.example .env.sample",
        "ls -la",
        "npm test",
    ];

    for (const command of allowed) {
        assert.deepEqual(findProtectedPathsInCommand(command), [], command);
    }
});

test("patch path extraction covers patch envelopes and unified diffs", () => {
    const envelope = ["*** Begin Patch", "*** Update File: src/a.ts", "*** Move to: src/b.ts", "*** Add File: .env", "*** Delete File: old.env", "*** End Patch"].join("\n");
    assert.deepEqual(extractPatchPaths(envelope), ["src/a.ts", "src/b.ts", ".env", "old.env"]);

    const unified = ["--- a/.env.local", "+++ b/.env.local", "@@ -1 +1 @@", "-A=1", "+A=2"].join("\n");
    assert.deepEqual(extractPatchPaths(unified), [".env.local", ".env.local"]);
    assert.deepEqual(extractPatchPaths("--- /dev/null\n+++ b/src/new.ts"), ["src/new.ts"]);
});

test("findBlockedAccess reads path arguments from V1 and V2 tool shapes", () => {
    assert.equal(findBlockedAccess("read", { filePath: ".env" })?.kind, "read");
    assert.equal(findBlockedAccess("read", { path: ".env" })?.kind, "read");
    assert.equal(findBlockedAccess("multi_read", { paths: ["a.ts", ".env.production"] })?.kind, "access");
    assert.equal(findBlockedAccess("envsitter_keys", { filePath: ".env" }), undefined);
    assert.equal(findBlockedAccess("read", "not-an-object"), undefined);
});

test("grep redaction is a no-op when nothing is protected", () => {
    const output = "Found 1 matches\n/repo/src/a.ts:\n  Line 1: TOKEN";
    assert.deepEqual(redactGrepOutput(output), { output, hidden: 0 });
});
