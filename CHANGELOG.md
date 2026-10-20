# Changelog

## 0.1.0 (Unreleased)

### Added

- OpenCode 2 support. The default export is now `{ id: "envsitter-guard", setup, server }`: OpenCode 2 calls `setup(ctx)`, OpenCode 1 (1.18.29+) calls `server()`.
- OpenCode 2 tools are registered with `ctx.tool.transform` and `codemode: false`, so agents see them directly instead of behind Code Mode.
- OpenCode 2 blocking runs in `ctx.tool.hook("execute.before")` (which also sees calls made inside Code Mode) plus a `ctx.permission.hook("evaluate")` layer that denies `read`, `edit`, and `shell` checks on protected files.
- Blocks `patch` / `apply_patch` calls whose patch touches a protected file.
- Blocks shell commands (`bash` / `shell`) that name a protected file; envsitter CLI invocations stay allowed.
- Hides `grep` matches from protected files (V1 `tool.execute.after`, V2 `execute.after`).
- Blocks any other tool, such as MCP filesystem tools, whose path arguments point at a protected file.
- `npm run test:e2e`: cross-version end-to-end check that drives the real OpenCode 1 and OpenCode 2 CLIs with a scripted model in an isolated home. Verified against OpenCode 1.18.31 + 2.0.32 (the minimums) and 1.19.3 + 2.1.0.
- Release automation: CI on every push and pull request (unit tests on Node 22, 24, and 26 plus the OpenCode 1 + 2 end-to-end check against both version pairs), and tag-driven releases that only publish after that CI passes, using npm trusted publishing with provenance.
- Documentation page at https://boxpositron.github.io/envsitter/guard/.
- Tool output scrubbing: secret-looking values from the project's protected env files are replaced with `[envsitter: KEY redacted]` in the output of every non-EnvSitter tool (OpenCode 1 `tool.execute.after`, OpenCode 2 `execute.after`), so commands that never name `.env` (`grep -r`, `cat *`, log files) no longer hand values to the model. Uses envsitter's redactor; env files are found up to three levels deep and re-read when they change.
- Weekly end-to-end run against the newest OpenCode 1 and 2 releases (`e2e-latest.yml`), and Dependabot for npm dependencies and GitHub Actions.

### Changed

- **Breaking:** the named export `EnvSitterGuard` is now the plugin definition object, not a V1 plugin function. Code that called `EnvSitterGuard(input)` directly should call `EnvSitterGuard.server(input)`. Re-exporting it from a local plugin file keeps working.
- OpenCode 1 support now requires 1.18.29 or newer (object-form plugin entrypoint).
- Protected files now come from envsitter's path policy: named env files such as `api.env` and `config.env.local` are protected, and EnvSitter tools accept them.
- Example/template files `.env.sample`, `.env.template`, `.env.dist`, and `.env.default(s)` are now readable, matching envsitter's definition (previously only `.env.example`).
- Tool definitions are shared between OpenCode 1 and 2; V2 receives JSON Schema generated from the same argument schemas, and inputs are validated before execution.
- Bumped `envsitter` dependency to `^0.1.0`.
- Bumped `@opencode-ai/plugin` dependency to `^1.19.3`.

### Fixed

- OpenCode 1.19 names its patch tool `apply_patch`; the previous `patch` check never matched it.

## 0.0.4

### Added

- `envsitter_add`: add a new key to a dotenv file (fails if key exists; dry-run unless `write: true`).
- `envsitter_set`: set a key's value (creates or updates; dry-run unless `write: true`).
- `envsitter_unset`: unset a key's value to empty string (keeps the key; dry-run unless `write: true`).
- `envsitter_delete`: delete key(s) from a dotenv file entirely (dry-run unless `write: true`).
- `envsitter_help`: comprehensive help tool explaining all EnvSitter tools to agents. Supports topics: `overview`, `reading`, `matching`, `mutations`, `file_ops`, `all`.

### Changed

- Blocking behavior is now silent (error message only, no toast notifications).
- Improved error messages to reference `envsitter_help` for guidance.
- Bumped `envsitter` dependency to `^0.0.4`.

## 0.0.3

### Added

- `envsitter_validate`: validate dotenv syntax (issues only; never values).
- `envsitter_copy`: copy keys between dotenv files (dry-run unless `write: true`; never values).
- `envsitter_format` / `envsitter_reorder`: format/reorder dotenv files (dry-run unless `write: true`; never values).
- `envsitter_annotate`: annotate dotenv keys with comments (dry-run unless `write: true`; never values).

### Changed

- `envsitter_match`: uses EnvSitter outside-in matching for `op: "is_equal"`.
- Block warnings: removed prompt append (toast-only) to avoid writing into OpenCode's input.
- Bumped `envsitter` dependency to `^0.0.3`.

## 0.0.2

### Added

- `envsitter_match`: safe boolean matching for `.env` keys (single key, bulk keys, or all keys) with support for the EnvSitter match operators.
- `envsitter_match_by_key`: safe candidates-by-key matching (returns booleans only).
- `envsitter_scan`: safe shape scanning (`jwt`, `url`, `base64`) without returning values.
- `envsitter_keys.filterRegex`: optional regex filter for key listing.

### Changed

- Bumped `envsitter` dependency to `^0.0.2`.
