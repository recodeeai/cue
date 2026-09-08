import assert from "node:assert/strict";
import { listLimit, searchLimit } from "./src/index.js";
assert.equal(listLimit(undefined), 20);
assert.equal(searchLimit("5"), 5);
