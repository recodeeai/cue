Fix buildUrl(path, params) to encode query parameters correctly using the existing encodeQuery helper in src/query.js.
Preserve repeated array values in order and omit undefined values. An empty parameter object must return the path without a trailing question mark.
Input paths have no existing query or fragment. Keep the helper unchanged.

Change only src/index.js; you may add a separate regression-check file. Do not edit package.json, checks.mjs, or existing helper files. Preserve existing checks and run npm test. Use the installed runtime and standard library; no downloads or new dependencies.
