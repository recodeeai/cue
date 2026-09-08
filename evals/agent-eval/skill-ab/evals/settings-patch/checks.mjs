import assert from "node:assert/strict";
import { patchSettings } from "./src/index.js";
assert.equal(patchSettings({ displayName: "Old" }, { displayName: "New" }).value.displayName, "New");
