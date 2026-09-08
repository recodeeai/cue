Fix uniqueBy(items, keyOf): keep the FIRST item for each key, in input order, preserving object identity.
Do not mutate the input. Call keyOf exactly once per item. Empty input returns [].
Keys use Set/Map equality, including falsy keys (0, "", false, undefined) and object keys.

Change only src/index.js; you may add a separate regression-check file. Do not edit package.json, checks.mjs, or existing helper files. Preserve existing checks and run npm test. Use the installed runtime and standard library; no downloads or new dependencies.
