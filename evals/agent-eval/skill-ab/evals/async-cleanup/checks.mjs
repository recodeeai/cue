import assert from "node:assert/strict";
import { withResource } from "./src/index.js";
assert.equal(await withResource(async () => ({ close() {} }), async () => 42), 42);
