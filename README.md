# envsitter-guard

[![CI](https://github.com/boxpositron/envsitter-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/boxpositron/envsitter-guard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/envsitter-guard)](https://www.npmjs.com/package/envsitter-guard)

OpenCode plugin that prevents agents/tools from reading or editing sensitive `.env` files, while still allowing safe inspection via EnvSitter (keys + deterministic fingerprints; never values).

Docs: https://boxpositron.github.io/envsitter/guard/

One package supports both OpenCode majors:

- **OpenCode 2** (`@opencode/plugin` API, 2.0.32+): loaded through the default export's `id` + `setup()`.
- **OpenCode 1** (1.18.29+): loaded through the same default export's `server()`.

## Compatibility

| OpenCode | Minimum | Verified end to end | Entry point | Built-in tools covered |
|----------|---------|---------------------|-------------|------------------------|
| 2.x | 2.0.32 | 2.0.32, 2.1.0 | `setup(ctx)` | `read`, `write`, `edit`, `patch`, `shell`, `grep` |
| 1.x | 1.18.29 | 1.18.31, 1.19.3 | `server()` | `read`, `write`, `edit`, `apply_patch`, `bash`, `grep` |

"Verified end to end" means `npm run test:e2e` passed against that CLI: the plugin loaded, all 15 `envsitter_*` tools were visible to the model, and every blocking scenario held (see [Development](#development)).

## Quickstart (OpenCode)

Reference docs:
- OpenCode 2: https://opencode.ai/v2/docs/plugins
- OpenCode 1: https://opencode.ai/docs/plugins/

### Option A (recommended): load from npm

OpenCode 2 (`opencode.json` uses `plugins`, plural):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["envsitter-guard@latest"]
}
```

Or install it globally with the OpenCode 2 CLI:

```bash
opencode plugin add envsitter-guard@latest
```

OpenCode 1 (`plugin`, singular; OpenCode 2 also accepts this V1 key):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["envsitter-guard@latest"]
}
```

Restart OpenCode after updating config (OpenCode 2 reloads watched config automatically).

## Why

Accidentally printing `.env` contents is one of the easiest ways for an agentic workflow to leak secrets into:

- chat transcripts
- logs/tool output
- commits/patches
- screenshots / shared sessions

`envsitter-guard` blocks risky operations and points you to safe alternatives.

This plugin is built on top of [envsitter](https://github.com/boxpositron/envsitter), a library for safely inspecting and matching `.env` secrets without ever printing values.

## What it does

This plugin provides safe EnvSitter-backed tools and blocks sensitive file access via OpenCode tool hooks.

### Safe tools (no values)

These tools never return raw `.env` values:

**Reading:**
- `envsitter_keys`: list keys in a dotenv file
- `envsitter_fingerprint`: deterministic fingerprint of a single key's value
- `envsitter_scan`: scan value *shapes* (jwt/url/base64) without printing values

**Matching:**
- `envsitter_match`: boolean/shape checks and outside-in candidate matching (without printing values)
- `envsitter_match_by_key`: bulk candidate-by-key matching (returns booleans only)

**Mutations:**
- `envsitter_add`: add a new key (fails if key exists)
- `envsitter_set`: set a key's value (creates or updates)
- `envsitter_unset`: unset a key's value (sets to empty, keeps the key)
- `envsitter_delete`: delete key(s) entirely from the file

**File Operations:**
- `envsitter_validate`: validate dotenv syntax (no values; issues only)
- `envsitter_copy`: copy keys between env files (no values; plan + line numbers only)
- `envsitter_format` / `envsitter_reorder`: reorder/format env files (no values)
- `envsitter_annotate`: add comments near keys (no values)

**Help:**
- `envsitter_help`: comprehensive usage guide for all tools (topics: `overview`, `reading`, `matching`, `mutations`, `file_ops`, `all`)

Notes for file operations:

- File operations are dry-run unless `write: true` is provided.
- Tools only return keys, booleans, and line numbers/operation plans.

### Blocking behavior

Protected files come from envsitter's path policy (`isSensitiveEnvFile` / `isEnvSitterPepperFile`):

- Protected: `.env`, `.env.<anything>`, `<name>.env`, `<name>.env.<anything>` (e.g. `.env.local`, `api.env`, `config.env.local`)
- Readable: example/template files `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.default(s)`
- Not env files: source files such as `app.env.ts`
- Always protected: `.envsitter/pepper`

Blocked operations:

- Any non-EnvSitter tool whose path arguments (`filePath`, `path`, `file_path`, `paths`) point at a protected file: `read`, `edit`, `write`, `grep` on a file, MCP filesystem tools, and so on
- `patch` / `apply_patch` when the patch adds, updates, moves, or deletes a protected file
- Shell commands (`bash` / `shell`) that name a protected file, e.g. `cat .env`, `source .env`, `echo X >> .env`, `node --env-file=.env` (envsitter CLI calls such as `npx envsitter keys --file .env` are allowed)
- `grep` results: matches inside protected files are removed from the output
- Secret values in tool output: secret-looking values from the project's protected env files are replaced with `[envsitter: KEY redacted]` in the result of every non-EnvSitter tool (shell, `read` of other files, `grep`, MCP tools). The plugin finds env files up to three directories deep from the project root (for a session outside a repository, the session directory), skipping dependency, build, and cache folders, and re-reads them when they change. In a home directory or at the filesystem root, only that directory's own env files are used. Folders it cannot read and files that are not valid dotenv are skipped, and a scrubbing problem never fails the tool call. Which values count as secret is decided by envsitter's redactor (see the envsitter README).
- OpenCode 2 only: a permission `evaluate` hook also denies `read`, `edit`, and `shell` permission checks on protected files, including tool calls made from Code Mode

When blocked, the plugin throws an error with guidance on which EnvSitter tools to use instead.

Limits: this is a guardrail against accidental reads, not a sandbox. Commands that reach file contents without naming the file (`grep -r TOKEN .`, `cat *`, variables, `eval`) are not blocked; their output is scrubbed instead, which catches values as written but not encoded or transformed ones (base64, split strings) or values that do not look secret. Custom pepper locations are not recognized.

## Tools

Tools only operate on dotenv files (`.env*`, `*.env`, including examples) inside the current project.

- Most tools accept a `filePath` that defaults to `.env`.
- File operations are dry-run unless `write: true` is provided.

### `envsitter_keys`

Lists keys in a dotenv file.

- Input: `{ "filePath"?: string, "filterRegex"?: string }`
- Output: JSON `{ file, keys }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_keys", "args": { "filePath": ".env" } }
```

Optional filtering:

```json
{ "tool": "envsitter_keys", "args": { "filePath": ".env", "filterRegex": "/^(API_|DB_)/" } }
```

### `envsitter_fingerprint`

Computes a deterministic fingerprint of a single key.

- Input: `{ "filePath"?: string, "key": string }`
- Output: JSON `{ file, key, result }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_fingerprint", "args": { "filePath": ".env", "key": "DATABASE_URL" } }
```

### `envsitter_match`

Matches key values without printing them.

- Input:
  - `{ "filePath"?: string, "op"?: string, "key"?: string, "keys"?: string[], "allKeys"?: boolean, "candidate"?: string, "candidateEnvVar"?: string }`
- Output:
  - If `key` provided: JSON `{ file, key, op, match }`
  - If `keys` or `allKeys`: JSON `{ file, op, matches }`

Notes:

- Provide exactly one selector: `key`, `keys`, or `allKeys: true`.
- For ops that compare against a candidate (`is_equal`, `partial_match_*`), provide `candidate` or `candidateEnvVar`.

Examples (inside OpenCode):

```json
{ "tool": "envsitter_match", "args": { "filePath": ".env", "key": "SENTRY_DSN", "op": "exists" } }
```

```json
{ "tool": "envsitter_match", "args": { "filePath": ".env", "key": "PORT", "op": "is_number" } }
```

```json
{ "tool": "envsitter_match", "args": { "filePath": ".env", "key": "NODE_ENV", "op": "is_equal", "candidate": "production" } }
```

### `envsitter_match_by_key`

Bulk match candidates-by-key without printing values (returns booleans only).

- Input:
  - `{ "filePath"?: string, "candidatesByKey"?: Record<string,string>, "candidatesByKeyJson"?: string, "candidatesByKeyEnvVar"?: string }`
- Output: JSON `{ file, matches }`

Note: provide exactly one of `candidatesByKey`, `candidatesByKeyJson`, or `candidatesByKeyEnvVar`.

Example (inside OpenCode):

```json
{ "tool": "envsitter_match_by_key", "args": { "filePath": ".env", "candidatesByKey": { "NODE_ENV": "production" } } }
```

### `envsitter_scan`

Scan value shapes (jwt/url/base64) without printing values.

- Input: `{ "filePath"?: string, "detect"?: ("jwt"|"url"|"base64")[], "keysFilterRegex"?: string }`
- Output: JSON `{ file, findings }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_scan", "args": { "filePath": ".env", "detect": ["jwt", "url"] } }
```

### `envsitter_validate`

Validate dotenv syntax.

- Input: `{ "filePath"?: string }`
- Output: JSON `{ file, ok, issues }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_validate", "args": { "filePath": ".env" } }
```

### `envsitter_copy`

Copy keys between env files. Output includes a plan (keys + line numbers), never values.

- Input:
  - `{ "from": string, "to": string, "keys"?: string[], "includeRegex"?: string, "excludeRegex"?: string, "rename"?: string, "onConflict"?: "error"|"skip"|"overwrite", "write"?: boolean }`
- Output: JSON `{ from, to, onConflict, willWrite, wrote, hasChanges, issues, plan }`

Examples (inside OpenCode):

```json
{ "tool": "envsitter_copy", "args": { "from": ".env.production", "to": ".env.staging", "keys": ["API_URL"], "onConflict": "overwrite" } }
```

```json
{ "tool": "envsitter_copy", "args": { "from": ".env.production", "to": ".env.staging", "keys": ["API_URL"], "onConflict": "overwrite", "write": true } }
```

### `envsitter_format` / `envsitter_reorder`

Format/reorder an env file (no values in output).

- Input: `{ "filePath"?: string, "mode"?: "sections"|"global", "sort"?: "alpha"|"none", "write"?: boolean }`
- Output: JSON `{ file, mode, sort, willWrite, wrote, hasChanges, issues }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_format", "args": { "filePath": ".env", "mode": "sections", "sort": "alpha", "write": true } }
```

### `envsitter_annotate`

Annotate an env key with a comment (no values in output).

- Input: `{ "filePath"?: string, "key": string, "comment": string, "line"?: number, "write"?: boolean }`
- Output: JSON `{ file, key, willWrite, wrote, hasChanges, issues, plan }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_annotate", "args": { "filePath": ".env", "key": "DATABASE_URL", "comment": "prod only", "write": true } }
```

### `envsitter_add`

Add a new key to a dotenv file (fails if key already exists).

- Input: `{ "filePath"?: string, "key": string, "value": string, "write"?: boolean }`
- Output: JSON `{ file, key, willWrite, wrote, hasChanges, issues, plan }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_add", "args": { "filePath": ".env", "key": "NEW_API_KEY", "value": "sk-xxx", "write": true } }
```

### `envsitter_set`

Set a key's value in a dotenv file (creates if missing, updates if exists).

- Input: `{ "filePath"?: string, "key": string, "value": string, "write"?: boolean }`
- Output: JSON `{ file, key, willWrite, wrote, hasChanges, issues, plan }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_set", "args": { "filePath": ".env", "key": "API_KEY", "value": "new-value", "write": true } }
```

### `envsitter_unset`

Unset a key's value (sets to empty string, keeps the key line).

- Input: `{ "filePath"?: string, "key": string, "write"?: boolean }`
- Output: JSON `{ file, key, willWrite, wrote, hasChanges, issues, plan }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_unset", "args": { "filePath": ".env", "key": "OLD_KEY", "write": true } }
```

### `envsitter_delete`

Delete key(s) from a dotenv file entirely (removes the line).

- Input: `{ "filePath"?: string, "keys": string[], "write"?: boolean }`
- Output: JSON `{ file, keys, willWrite, wrote, hasChanges, issues, plan }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_delete", "args": { "filePath": ".env", "keys": ["OLD_KEY", "UNUSED_KEY"], "write": true } }
```

### `envsitter_help`

Get comprehensive help on all EnvSitter tools.

- Input: `{ "topic"?: "overview" | "reading" | "matching" | "mutations" | "file_ops" | "all" }`
- Output: Markdown documentation for the requested topic

Topics:
- `overview`: What EnvSitter is and tool categories
- `reading`: `envsitter_keys`, `envsitter_fingerprint`, `envsitter_scan`
- `matching`: `envsitter_match`, `envsitter_match_by_key` with all operators
- `mutations`: `envsitter_add`, `envsitter_set`, `envsitter_unset`, `envsitter_delete`
- `file_ops`: `envsitter_validate`, `envsitter_copy`, `envsitter_format`, `envsitter_annotate`
- `all`: Full guide (default)

Example (inside OpenCode):

```json
{ "tool": "envsitter_help", "args": { "topic": "mutations" } }
```

## Install & enable in OpenCode (alternatives)

### Option B: local plugin file (project-level)

If you want a local plugin file in-repo (or need local overrides), create `.opencode/plugins/envsitter-guard.ts` (OpenCode 2) or `.opencode/plugin/envsitter-guard.ts` (OpenCode 1; OpenCode 2 also scans this directory):

```ts
import EnvSitterGuard from "envsitter-guard";

export default EnvSitterGuard;
export { EnvSitterGuard } from "envsitter-guard";
```

Then create `.opencode/package.json` with the dependency so OpenCode can install it:

```json
{
  "dependencies": {
    "envsitter-guard": "latest"
  }
}
```

Restart OpenCode; files in `.opencode/plugins/` (and `.opencode/plugin/`) are loaded automatically.

### Option C: global plugin file

Place a plugin file in `~/.config/opencode/plugins/` (OpenCode 2) or `~/.config/opencode/plugin/` (OpenCode 1) if you want it enabled for all projects.

(You can use the same contents as Option B.)

## Development

### Install

```bash
npm ci
```

### Typecheck

```bash
npm run typecheck
```

### Test

```bash
npm test
```

### End-to-end check against OpenCode 1 and 2

```bash
npm run test:e2e
```

`scripts/e2e-opencode.mjs` builds the plugin, then runs the real `opencode` (1.x) and `opencode2` (2.x) CLIs against a scripted OpenAI-compatible model served on `127.0.0.1`. For each version it checks what the model gets back from each tool:

- `envsitter_keys` lists keys without values, and all 15 `envsitter_*` tools are offered directly
- `read` of `.env` is blocked, `read` of `.env.example` is allowed
- `write` to `.env` and a patch adding `.env.local` are blocked, and the files stay untouched
- `cat .env` through the shell tool is blocked
- `cat logs/app.log` through the shell tool and `read` of that log return the token in it as `[envsitter: API_TOKEN redacted]`
- `grep` results omit matches inside `.env`

Each version runs in its own temporary `HOME` with fake secrets, so your real config, credentials, and session database are never read or modified, and no paid model is called. A version whose CLI is missing is skipped. CI runs the check against the minimum and latest-tested versions on every push, and `.github/workflows/e2e-latest.yml` runs it weekly against the newest `opencode-ai` and `@opencode/cli` releases.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCODE_V1_BIN` | `opencode` | OpenCode 1 CLI to test |
| `OPENCODE_V2_BIN` | `opencode2` | OpenCode 2 CLI to test |
| `KEEP_E2E` | unset | `1` keeps the temporary projects for inspection |
| `E2E_REQUIRE_ALL` | unset | `1` fails instead of skipping when a CLI is missing (CI sets it) |

### Running OpenCode 2 next to OpenCode 1

The OpenCode 2 curl installer replaces the OpenCode 1 binary. To keep both, install OpenCode 2 from npm into its own prefix; the package also ships an `opencode2` command:

```bash
npm install -g --prefix ~/.local/opt/opencode2 @opencode/cli
~/.local/opt/opencode2/bin/opencode2 --version
```

OpenCode 2 reads the same config and data directories as OpenCode 1 and, by default, the same `opencode.db`, which it migrates in place. Give it its own database unless you mean to migrate:

```bash
OPENCODE_DB=opencode-v2.db ~/.local/opt/opencode2/bin/opencode2
```

### Build (for publishing)

```bash
npm run build
```

### Releasing

Releases are published by GitHub Actions with npm trusted publishing, so no npm token is stored anywhere and every version ships with a provenance attestation.

1. Release `envsitter` first when this version depends on a new one, then run `npm install` here so `package-lock.json` picks it up.
2. Bump `version` in `package.json` and replace `(Unreleased)` in the matching `CHANGELOG.md` heading with the release date.
3. Commit, then push a matching tag: `git tag v0.1.0 && git push origin main v0.1.0`.
4. The Release workflow reruns CI, including the OpenCode 1 + 2 end-to-end check (pinned in `.github/workflows/ci.yml`), checks that the tag, `package.json`, and the CHANGELOG agree, publishes to npm (prereleases go to the `next` dist-tag), and creates the GitHub Release from the CHANGELOG section.

## Related

- [envsitter](https://github.com/boxpositron/envsitter) — The underlying library this plugin is built on. Provides CLI and programmatic API for safe `.env` inspection.
- EnvSitter CLI: `npx envsitter keys --file .env` (alternative to plugin tools)

## Notes

- This project intentionally avoids reading or printing `.env` values.
- All tools return keys, booleans, line numbers, and operation plans — never secret values.

## License

MIT. See `LICENSE`.
