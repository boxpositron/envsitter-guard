export const HELP_TOPICS = ["overview", "reading", "matching", "mutations", "file_ops", "all"] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

const overview = `
## EnvSitter Tools Overview

EnvSitter provides safe .env file operations that NEVER expose secret values.
All tools return keys, booleans, line numbers, and operation plans only.

### Why Use EnvSitter?
- Direct access to sensitive env files (\`.env\`, \`.env.*\`, \`*.env\`) is BLOCKED to prevent secret leaks:
  reads, edits/writes/patches, shell commands that name them, and grep matches inside them
- Secret-looking values from those files are replaced with \`[envsitter: KEY redacted]\` in other tools' output
- Example/template files (\`.env.example\`, \`.env.sample\`, \`.env.template\`, \`.env.dist\`, \`.env.default(s)\`) stay readable
- These tools let you inspect, validate, and modify env files safely
- File modifications are dry-run by default; use \`write: true\` to apply

### Tool Categories
- **Reading**: envsitter_keys, envsitter_fingerprint, envsitter_scan
- **Matching**: envsitter_match, envsitter_match_by_key
- **Mutations**: envsitter_add, envsitter_set, envsitter_unset, envsitter_delete
- **File Ops**: envsitter_validate, envsitter_copy, envsitter_format, envsitter_annotate
`;

const reading = `
## Reading Tools (never return values)

### envsitter_keys
List all keys in a .env file.
\`\`\`json
{ "filePath": ".env", "filterRegex": "/^API_/" }
\`\`\`
Returns: \`{ file, keys: string[] }\`

### envsitter_fingerprint
Get a deterministic fingerprint of a key's value (for comparison/auditing).
\`\`\`json
{ "filePath": ".env", "key": "DATABASE_URL" }
\`\`\`
Returns: \`{ file, key, result: { algorithm, fingerprint, length } }\`

### envsitter_scan
Detect value shapes (JWT, URL, base64) without revealing values.
\`\`\`json
{ "filePath": ".env", "detect": ["jwt", "url", "base64"], "keysFilterRegex": "/TOKEN/" }
\`\`\`
Returns: \`{ file, findings: [{ key, detections }] }\`
`;

const matching = `
## Matching Tools (return booleans only)

### envsitter_match
Check if a key's value matches criteria without seeing the value.

**Operations** (op parameter):
- \`exists\`: key is present
- \`is_empty\`: value is empty string
- \`is_equal\`: matches candidate exactly (provide \`candidate\` or \`candidateEnvVar\`)
- \`partial_match_prefix\`: value starts with candidate
- \`partial_match_suffix\`: value ends with candidate
- \`partial_match_regex\`: value matches regex pattern
- \`is_number\`: value is numeric
- \`is_boolean\`: value is true/false
- \`is_string\`: value is neither number nor boolean

**Selectors** (provide exactly one):
- \`key\`: single key
- \`keys\`: array of keys
- \`allKeys: true\`: all keys in file

\`\`\`json
{ "filePath": ".env", "key": "NODE_ENV", "op": "is_equal", "candidate": "production" }
{ "filePath": ".env", "keys": ["API_KEY", "SECRET"], "op": "exists" }
{ "filePath": ".env", "allKeys": true, "op": "is_empty" }
\`\`\`

### envsitter_match_by_key
Bulk match different candidates against different keys.
\`\`\`json
{ "filePath": ".env", "candidatesByKey": { "API_KEY": "sk-xxx", "DB_PASS": "secret123" } }
\`\`\`
Returns: \`{ file, matches: [{ key, match: boolean }] }\`
`;

const mutations = `
## Mutation Tools (modify .env files safely)

All mutation tools are DRY-RUN by default. Set \`write: true\` to apply changes.
Output includes operation plan with line numbers, never values.

### envsitter_add
Add a NEW key (fails if key already exists).
\`\`\`json
{ "filePath": ".env", "key": "NEW_KEY", "value": "some-value", "write": true }
\`\`\`
Returns: \`{ file, key, hasChanges, plan: { action: "added"|"key_exists" } }\`

### envsitter_set
Create or update a key (upsert behavior).
\`\`\`json
{ "filePath": ".env", "key": "API_KEY", "value": "new-value", "write": true }
\`\`\`
Returns: \`{ file, key, hasChanges, plan: { action: "added"|"updated"|"no_change" } }\`

### envsitter_unset
Set a key to empty string (keeps the key line).
\`\`\`json
{ "filePath": ".env", "key": "OLD_KEY", "write": true }
\`\`\`
Returns: \`{ file, key, hasChanges, plan: { action: "unset"|"not_found" } }\`

### envsitter_delete
Remove key(s) entirely from the file.
\`\`\`json
{ "filePath": ".env", "keys": ["OLD_KEY", "UNUSED_KEY"], "write": true }
\`\`\`
Returns: \`{ file, keys, hasChanges, plan: [{ key, action: "deleted"|"not_found" }] }\`
`;

const fileOps = `
## File Operation Tools

### envsitter_validate
Check .env file syntax for errors.
\`\`\`json
{ "filePath": ".env" }
\`\`\`
Returns: \`{ file, ok: boolean, issues: [{ line, column, message }] }\`

### envsitter_copy
Copy keys between .env files. Dry-run unless \`write: true\`.
\`\`\`json
{
  "from": ".env.production",
  "to": ".env.staging",
  "keys": ["API_URL", "REDIS_URL"],
  "onConflict": "overwrite",
  "write": true
}
\`\`\`
Options: \`includeRegex\`, \`excludeRegex\`, \`rename\` (e.g., "OLD=NEW,A=B")
Returns: \`{ from, to, hasChanges, plan: [{ fromKey, toKey, action }] }\`

### envsitter_format / envsitter_reorder
Format/reorder a .env file. Dry-run unless \`write: true\`.
\`\`\`json
{ "filePath": ".env", "mode": "sections", "sort": "alpha", "write": true }
\`\`\`
Modes: \`sections\` (preserve section groupings), \`global\` (treat as flat list)
Sort: \`alpha\` (alphabetical), \`none\` (preserve order within sections)

### envsitter_annotate
Add a comment above a key. Dry-run unless \`write: true\`.
\`\`\`json
{ "filePath": ".env", "key": "DATABASE_URL", "comment": "Production DB only", "write": true }
\`\`\`
Returns: \`{ file, key, hasChanges, plan: { action: "inserted"|"updated"|"not_found" } }\`
`;

const sections: Record<Exclude<HelpTopic, "all">, string> = {
    overview,
    reading,
    matching,
    mutations,
    file_ops: fileOps,
};

export function helpText(topic: HelpTopic): string {
    if (topic === "all") return [overview, reading, matching, mutations, fileOps].join("\n---\n");
    return sections[topic];
}
