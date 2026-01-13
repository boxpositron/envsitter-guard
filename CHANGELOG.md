# Changelog

## Unreleased

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
