import assert from "node:assert/strict";
import { uniqueBy } from "./src/index.js";
assert.deepEqual(uniqueBy([1, 2], (value) => value), [1, 2]);
