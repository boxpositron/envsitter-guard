import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin as V2 } from "@opencode/plugin";

import { serverV1 } from "./lib/v1.js";
import { setupV2 } from "./lib/v2.js";

// One default export serves both OpenCode majors: V2 reads `id` + `setup`, V1 (>= 1.18.29) calls `server`.
// Keep every export of this module plugin-shaped: V1 rejects modules that export anything else.
export const EnvSitterGuard: V2.Plugin & { readonly server: V1Plugin } = {
    id: "envsitter-guard",
    setup: setupV2,
    server: serverV1,
};

export default EnvSitterGuard;
