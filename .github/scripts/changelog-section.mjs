#!/usr/bin/env node
// Prints the CHANGELOG.md section for a version (used as GitHub Release notes).
// Fails when the section is missing or still marked "Unreleased", so a release cannot ship undated notes.
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
    console.error("Usage: changelog-section.mjs <version>");
    process.exit(2);
}

const lines = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const start = lines.findIndex((line) => new RegExp(`^## ${escaped}(\\s|$)`).test(line));

if (start === -1) {
    console.error(`CHANGELOG.md has no "## ${version}" section.`);
    process.exit(1);
}
if (/unreleased/i.test(lines[start] ?? "")) {
    console.error(`CHANGELOG.md section "${lines[start]}" is still marked Unreleased; replace it with the release date.`);
    process.exit(1);
}

const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const body = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
process.stdout.write(`${body}\n`);
