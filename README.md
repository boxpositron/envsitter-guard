# envsitter-guard

OpenCode plugin that prevents agents/tools from reading or editing sensitive `.env*` files, while still allowing safe inspection via EnvSitter (keys + deterministic fingerprints; never values).

## Quickstart (OpenCode)

OpenCode supports loading plugins from npm or local plugin files.

Reference docs:
- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/config/#plugins

### Option A (recommended): load from npm via `opencode.json`

Add the plugin package to your OpenCode config.

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["envsitter-guard@latest"]
}
```

Restart OpenCode after updating config.

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

- Sensitive paths: `.env`, `.env.local`, `.env.production`, etc. (`.env*`)
- Allowed: `.env.example`
- Always blocked: `.envsitter/pepper`

Blocked operations via tool hooks:

- `read` on sensitive `.env*` paths
- `edit` / `write` / `patch` / `multiedit` on sensitive `.env*` paths

When blocked, the plugin throws an error with guidance on which EnvSitter tools to use instead.

## Tools

Tools only operate on `.env`-style files inside the current project.

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

If you want a local plugin file in-repo (or need local overrides), create `.opencode/plugin/envsitter-guard.ts`:

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

Restart OpenCode; files in `.opencode/plugin/` are loaded automatically.

### Option C: global plugin file

Place a plugin file in `~/.config/opencode/plugin/` if you want it enabled for all projects.

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

### Build (for publishing)

```bash
npm run build
```

## Related

- [envsitter](https://github.com/boxpositron/envsitter) — The underlying library this plugin is built on. Provides CLI and programmatic API for safe `.env` inspection.
- EnvSitter CLI: `npx envsitter keys --file .env` (alternative to plugin tools)

## Notes

- This project intentionally avoids reading or printing `.env` values.
- All tools return keys, booleans, line numbers, and operation plans — never secret values.

## License

MIT. See `LICENSE`.
