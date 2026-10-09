# Use the OpenCode V2 plugin API

## Status

Accepted for the V2 migration in [issue #1](https://github.com/boxpositron/envsitter-guard/issues/1).

## Context

OpenCode V2 rejects the V1 plugin function exported by version 0.0.4. The guard and
safe tools are therefore unavailable. Changing the export alone does not migrate
the tool registrations, input schemas, result content, or execution hook.

## Decision

Use `@opencode/plugin` and default-export a definition with the stable ID
`envsitter-guard` and a Promise-based `setup` function. Register the existing tools
through the V2 tool transform, retain Zod input validation through Standard Schema,
and return V2 text content. Read guarded inputs from the V2 execution hook and
inspect every native patch target. Resolve tool paths within the current location's
project root, not the canonical checkout.

## Consequences

The migrated package requires OpenCode V2; V1 users retain version 0.0.4. Existing
tool names, safe outputs, and dry-run defaults remain unchanged. The guard still
only covers its named tools and is not a sandbox or a symlink confinement boundary.
