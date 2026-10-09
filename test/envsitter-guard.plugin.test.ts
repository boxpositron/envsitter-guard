import assert from "node:assert/strict";
import test from "node:test";

import EnvSitterGuard from "../index.js";

test("default export is an OpenCode V2 server plugin definition", () => {
    const definition: unknown = EnvSitterGuard;
    const error = "Plugin must export a default definition with an id and an effect or setup function.";
    assert(definition !== null && typeof definition === "object", error);
    assert("id" in definition && typeof definition.id === "string" && definition.id.length > 0, error);
    assert("setup" in definition && typeof definition.setup === "function", error);
});
