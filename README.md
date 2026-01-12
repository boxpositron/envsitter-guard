# envsitter-guard

OpenCode plugin that prevents agents/tools from reading or editing sensitive `.env*` files, while still allowing safe inspection via EnvSitter (keys + deterministic fingerprints; never values).

## Why

Accidentally printing `.env` contents is one of the easiest ways for an agentic workflow to leak secrets into:

- chat transcripts
- logs/tool output
- commits/patches
- screenshots / shared sessions

`envsitter-guard` blocks the risky operations and points users to safe alternatives.

## What it does

This plugin does two things:

1. Adds safe tools:
   - `envsitter_keys`: list keys in a dotenv file (no values)
   - `envsitter_fingerprint`: hash/fingerprint one key’s value (no value)
2. Blocks sensitive file access via OpenCode tool hooks:
   - blocks `read` of sensitive `.env*` paths
   - blocks `edit` / `write` / `patch` of sensitive `.env*` paths
   - blocks access to `.envsitter/pepper`

`.env.example` is explicitly allowed.

## Tools

### `envsitter_keys`

Lists keys in a dotenv file.

- Input: `{ "filePath"?: string }` (defaults to `.env`)
- Output: JSON `{ file, keys }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_keys", "args": { "filePath": ".env" } }
```

### `envsitter_fingerprint`

Computes a deterministic fingerprint of a single key.

- Input: `{ "filePath"?: string, "key": string }` (filePath defaults to `.env`)
- Output: JSON `{ file, key, result }`

Example (inside OpenCode):

```json
{ "tool": "envsitter_fingerprint", "args": { "filePath": ".env", "key": "DATABASE_URL" } }
```

## Install & enable in OpenCode

OpenCode supports loading plugins either from local files or from npm.

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

## Behavior details

### What paths are considered sensitive?

- Sensitive: `.env`, `.env.local`, `.env.production`, etc. (`.env*`)
- Allowed: `.env.example`
- Always blocked: `.envsitter/pepper`

### What operations are blocked?

- `read` on sensitive `.env*` paths
- `edit` / `write` / `patch` on sensitive `.env*` paths

When blocked, the plugin shows a throttled warning toast and suggests using EnvSitter instead.

## Development

### Install

```bash
npm ci
```

### Typecheck

```bash
npm run typecheck
```

There are currently no lint scripts in this repo. Run tests with `npm test`.

## License

MIT. See `LICENSE`.
