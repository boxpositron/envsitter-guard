# Changelog

## Unreleased

### Added

- `envsitter_match`: safe boolean matching for `.env` keys (single key, bulk keys, or all keys) with support for the EnvSitter match operators.
- `envsitter_match_by_key`: safe candidates-by-key matching (returns booleans only).
- `envsitter_scan`: safe shape scanning (`jwt`, `url`, `base64`) without returning values.
- `envsitter_keys.filterRegex`: optional regex filter for key listing.

### Changed

- Bumped `envsitter` dependency to `^0.0.2`.
