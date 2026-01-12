# AGENTS.md — envsitter-guard

This repository is a minimal TypeScript plugin meant to run under OpenCode (`@opencode-ai/plugin`).

## Repo layout

- `index.ts`: main plugin implementation (`EnvSitterGuard`).
- `tsconfig.json`: TypeScript config (strict, `noEmit`).
- `.opencode/`: OpenCode packaging/runtime wrapper.
  - `.opencode/plugin/envsitter-guard.ts` re-exports the plugin from `index.ts`.
  - `.opencode/bun.lock` indicates Bun-managed deps inside `.opencode/`.
- `node_modules/`: vendored deps (present locally; do not edit).

## Commands (build / lint / test)

### Install

- Root install (lockfile: `package-lock.json`):
  - `npm ci`
  - `npm install` (ok for local dev; `npm ci` preferred for reproducibility)

- `.opencode/` install (Bun lockfile present):
  - If you need to refresh `.opencode/node_modules`, use Bun from `.opencode/`:
    - `cd .opencode && bun install`
  - If Bun is unavailable, do not guess; ask before changing `.opencode/` dependency management.

### Build / typecheck

This repo does not emit JS as part of its normal workflow.

- Typecheck (canonical):
  - `npm run typecheck`
  - Equivalent: `npx tsc -p tsconfig.json`

### Lint / format

- No linting or formatting commands are configured in the root project.
- No `.eslintrc*`, `eslint.config.*`, `biome.json`, or Prettier config exists at repo root.
- Do not introduce new linters/formatters unless explicitly requested.

### Tests

Tests use Node’s built-in test runner, compiled via `tsc` into `dist-test/`.

- Run all tests (builds then runs):
  - `npm test`
- Build test output only:
  - `npm run build:test`
- Run a single test file:
  - `npm run build:test && node --test dist-test/test/envsitter-guard.hook.test.js`

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
- Keep functions small and single-purpose (see path validation helpers in `index.ts`).

## Naming conventions

- `camelCase`: functions, locals, parameters.
- `PascalCase`: exported plugin symbol (`EnvSitterGuard`).
- Booleans use `is*` / `has*` prefixes (e.g. `isSensitiveDotEnvPath`).

## Error handling & validation

This plugin is security-sensitive. Follow these patterns:

- Prefer early validation + `throw new Error("...")` with a clear, user-facing message.
- Avoid swallowing errors (no empty `catch` blocks).
- Avoid `any` and type suppression (`as any`, `@ts-ignore`, `@ts-expect-error`).
- When parsing unknown inputs, narrow types explicitly (e.g. `typeof args === "object"`, then access via `Record<string, unknown>`).

## Security & secrets

- Do not read or print `.env` values.
- Treat `.env.secure` as sensitive; never commit secrets.
- This repo’s plugin is designed to block sensitive `.env*` and `.envsitter/pepper` access via tooling and to guide users toward safe inspection:
  - `envsitter_keys` (lists keys only)
  - `envsitter_fingerprint` (hash/fingerprint only)

## Working with `.opencode/`

- `.opencode/` is a packaging/runtime layer for OpenCode plugins; treat it as part of the deployment surface.
- Keep `.opencode/plugin/envsitter-guard.ts` as a thin re-export (do not add logic there).
- Avoid editing `.opencode/node_modules` directly.

## Change discipline

- Prefer minimal diffs; avoid refactors during bugfixes.
- Keep behavior consistent with `index.ts` patterns:
  - normalize paths before regex matching
  - ensure file paths stay within `worktree`
  - throttle UI toasts (`lastToastAt` pattern)

## Plugin behavior notes

- OpenCode entrypoint is `EnvSitterGuard` exported from `index.ts`.
- Plugin registration file `.opencode/plugin/envsitter-guard.ts` must remain a thin re-export.
- Tool surface area intentionally small:
  - `envsitter_keys`: lists keys only (no values)
  - `envsitter_fingerprint`: deterministic fingerprint of a single key (no value)
- Blocking behavior is enforced in `"tool.execute.before"`:
  - Blocks reads of `.env*` (except `.env.example`).
  - Blocks edits/writes/patching of `.env*` and `.envsitter/pepper`.
  - Throttles UI toasts via `lastToastAt`.

## Path handling rules

- Treat all incoming tool args as untrusted.
- Normalize path separators before matching (Windows `\\` → `/`).
- Validate allowed paths before resolving to absolute paths.
- Ensure resolved paths stay within `worktree` using `path.relative()` checks.

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

- `npm run typecheck` passes.
- No tool path allows reading raw `.env*` values.
- `.opencode/plugin/envsitter-guard.ts` remains a re-export only.
- Error messages remain clear and do not leak file contents.

## Cursor / Copilot rules

- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` were found in this repository.
