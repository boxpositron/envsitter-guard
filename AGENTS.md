# AGENTS.md — envsitter-guard

This repository is a minimal TypeScript plugin for OpenCode 1 (`@opencode-ai/plugin`, 1.18.29+) and OpenCode 2 (`@opencode/plugin`, 2.0.32+), served from one default export.

## Repo layout

- `index.ts`: package entry. Exports only `EnvSitterGuard` = `{ id, setup, server }` (also the default export).
- `lib/tools.ts`: the 15 `envsitter_*` tools, defined once (zod args, JSON Schema for V2, `run(input, env)`).
- `lib/policy.ts`: pure blocking logic (protected paths, patch paths, shell scan, grep redaction, permission denial).
- `lib/scrub.ts`: finds the project's sensitive env files and scrubs secret values from tool output with envsitter's redactor.
- `lib/v1.ts` / `lib/v2.ts`: thin adapters (V1 hooks object; V2 `ctx.tool.transform`/`hook`, `ctx.permission.hook`).
- `lib/help.ts`: `envsitter_help` text.
- `test/`: `*.hook.test.ts` (V1 hooks), `*.tools.test.ts` (tools via V1), `*.v2.test.ts` (V2 setup with a fake ctx), `policy.test.ts`, `scrub.test.ts`.
- `scripts/e2e-opencode.mjs`: `npm run test:e2e`, real OpenCode 1 (`opencode`) and 2 (`opencode2`) CLIs vs a scripted model, isolated `HOME`.
- `.github/workflows/`: `ci.yml` (unit tests + pinned OpenCode e2e), `e2e-latest.yml` (weekly e2e vs newest OpenCode), `release.yml` (tag `vX.Y.Z` -> CI -> npm trusted publishing -> GitHub Release). Keep the `release.yml` name: npm's trusted-publisher config pins it. `origin` is Gitea (`git.boxpositron.dev`), mirrored to GitHub; jobs carry `if: github.server_url == 'https://github.com'` so Gitea's runner skips them.
- `tsconfig.json`: strict, `noEmit` (typecheck). `tsconfig.build.json` emits `dist/` (publish); `tsconfig.test.json` emits `dist-test/`.
- `.opencode/`: OpenCode packaging/runtime wrapper.
  - `.opencode/plugin/envsitter-guard.ts` re-exports the plugin from `index.ts` (the only tracked file here).
  - `.opencode/package.json` and `.opencode/bun.lock` are local-only (ignored by `.opencode/.gitignore`).
- `node_modules/`: npm-installed deps (do not edit); `envsitter` comes from npm, not the sibling checkout.

## Commands (build / lint / test)

### Install

- Root install (lockfile: `package-lock.json`): `npm ci` (preferred) or `npm install`

- `.opencode/` install (local-only Bun lockfile, untracked):
  - If you need to refresh `.opencode/node_modules`, use Bun from `.opencode/`:
    - `cd .opencode && bun install`
  - If Bun is unavailable, do not guess; ask before changing `.opencode/` dependency management.

### Build / typecheck

Day-to-day work only typechecks. `npm run build` (`tsconfig.build.json` -> `dist/`) produces the published package and runs on `prepack`; `prepublishOnly` runs typecheck, test, then build.

- Typecheck (canonical): `npm run typecheck` (= `npx tsc -p tsconfig.json`)

### Lint / format

- No linting or formatting commands are configured in the root project.
- No `.eslintrc*`, `eslint.config.*`, `biome.json`, or Prettier config exists at repo root.
- Do not introduce new linters/formatters unless explicitly requested.

### Tests

Tests use Node’s built-in test runner, compiled via `tsc` into `dist-test/`.

- Run all tests (builds then runs): `npm test`
- Build test output only: `npm run build:test`
- Cross-version e2e (needs the CLIs installed; not part of `npm test`): `npm run test:e2e`
- Run a single test file:
  - `npm run build:test && node --test dist-test/test/envsitter-guard.v2.test.js`
- To test against an unreleased `envsitter`: `npm pack` in `../envsitter`, then `npm install --no-save <tarball>` here (CI always uses the published version from the lockfile).

Pre-commit checks are enforced via Husky:
- `npm install` installs the git hook.
- `.husky/pre-commit` runs `npm run typecheck` and `npm test`.

## TypeScript / module conventions

- ESM project: `package.json` has `"type": "module"`.
- TS config: `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `target: "ES2022"`, `strict: true`, `noEmit: true`.
- Prefer `import type { ... }` for type-only imports (see `index.ts`).
- Prefer `node:` specifier for Node built-ins (e.g. `import path from "node:path"`).

## Formatting conventions (match existing code)

- Indentation: 4 spaces.
- Quotes: double quotes.
- Semicolons: required.
- Trailing commas: used in multiline objects/args.
- Keep functions small and single-purpose (see `lib/policy.ts`).

## Naming conventions

- `camelCase`: functions, locals, parameters.
- `PascalCase`: exported plugin symbol (`EnvSitterGuard`).
- Booleans use `is*` / `has*` prefixes (e.g. `isProtectedPath`).

## Error handling & validation

This plugin is security-sensitive. Follow these patterns:

- Prefer early validation + `throw new Error("...")` with a clear, user-facing message.
- Avoid swallowing errors (no empty `catch` blocks).
- Avoid `any` and type suppression (`as any`, `@ts-ignore`, `@ts-expect-error`).
- When parsing unknown inputs, narrow types explicitly (e.g. `typeof args === "object"`, then access via `Record<string, unknown>`).

## Security & secrets

- Do not read or print `.env` values.
- Treat `.env.secure` as sensitive; never commit secrets.
- The plugin blocks protected env files and the pepper, and points agents to EnvSitter tools (keys, fingerprints, booleans; never values).

## Change discipline

- Prefer minimal diffs; avoid refactors during bugfixes.
- Keep behavior consistent with `lib/` patterns:
  - normalize paths before matching; decide "protected" only via envsitter's `isSensitiveEnvFile` / `isEnvSitterPepperFile`
  - ensure file paths stay within the project root (V1 `worktree`, V2 `ctx.location.project.directory`, via `projectRoot()`, which swaps a filesystem-root project for the session directory)
  - block silently: throw an actionable `Error`, never show a toast (hook test asserts zero toasts)
- Never add non-plugin exports to `index.ts`: OpenCode 1 throws when a plugin module exports anything else.
- Add or change a tool once in `lib/tools.ts`; both adapters pick it up. Update `lib/help.ts` with it.

## Plugin behavior notes

- Tool surface (15 tools; every file-taking tool resolves paths via `resolveEnvFilePath` in `lib/tools.ts`):
  - Read-only: `envsitter_keys`, `envsitter_fingerprint`, `envsitter_match`, `envsitter_match_by_key`, `envsitter_scan`, `envsitter_validate`.
  - Mutating, dry-run unless `write: true`: `envsitter_copy`, `envsitter_format`, `envsitter_reorder`, `envsitter_annotate`, `envsitter_add`, `envsitter_set`, `envsitter_unset`, `envsitter_delete`.
  - `envsitter_help`: agent-facing guide; update its topic text whenever a tool changes.
  - V2 registers them with `codemode: false` so agents call them by name.
- Blocking (`findBlockedAccess`, used by V1 `tool.execute.before` and V2 `execute.before`):
  - Any non-`envsitter_*` tool whose `filePath` / `path` / `file_path` / `paths` args hit a protected file.
  - `patchText` envelopes (`patch`, V1.19 `apply_patch`) and unified diffs touching protected files.
  - `command` strings naming protected files (best-effort shell scan; envsitter CLI segments allowed).
- `grep` output is redacted after execution and every non-envsitter tool's output is scrubbed of secret values (`lib/scrub.ts`); V2 also denies protected `read`/`edit`/`shell` permission checks.
- Protected = envsitter `isSensitiveEnvFile` (examples/templates stay readable) or `isEnvSitterPepperFile`.

## Path handling rules

- Treat all incoming tool args as untrusted.
- Normalize path separators before matching (Windows `\\` → `/`).
- Validate allowed paths before resolving to absolute paths.
- Ensure resolved paths stay within the project root using `path.relative()` checks.

## Output conventions

- Prefer returning structured JSON via `JSON.stringify(obj, null, 2)`.
- Never include secret values in output strings, prompts, or toast messages.
- Errors should be user-facing and actionable (what was blocked + safe alternative).

## Dependency & change policy

- Keep this repo minimalist: prefer existing dependencies over adding new ones.
- Do not change `.opencode/` dependency management unless you know the OpenCode packaging constraints.
- Never edit vendored `node_modules/` or `.opencode/node_modules/`.

## Repo hygiene

- When searching the codebase, exclude `node_modules/` and `.opencode/node_modules/` unless you are explicitly auditing dependency behavior.
- Do not add new config files (ESLint/Prettier/Biome/etc.) unless explicitly requested.

## Verification checklist

- `npm run typecheck` and `npm test` pass (V1 hook/tool tests and V2 tests).
- No tool path allows reading raw `.env*` values.
- `.opencode/plugin/envsitter-guard.ts` remains a re-export only.
- Error messages remain clear and do not leak file contents.
