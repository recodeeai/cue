import assert from "node:assert/strict";
import { buildUrl } from "./src/index.js";
assert.equal(buildUrl("/search", { q: "hello" }), "/search?q=hello");
