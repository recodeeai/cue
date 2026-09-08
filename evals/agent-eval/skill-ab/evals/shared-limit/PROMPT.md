Fix the shared page-size parser used by listLimit and searchLimit. Both callers must keep using parseLimit.
Undefined means 20. Numeric values and numeric strings from 0 through 100 inclusive must be accepted, including zero.
Reject empty strings, fractions, negative values, values above 100, and nonnumeric strings with RangeError.
Keep all three exports.

Change only src/index.js; you may add a separate regression-check file. Do not edit package.json, checks.mjs, or existing helper files. Preserve existing checks and run npm test. Use the installed runtime and standard library; no downloads or new dependencies.
