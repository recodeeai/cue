Fix patchSettings(current, patch) without adding dependencies. The patch is a JSON value. Return {ok:true,value:newSettings} for valid patches.
Only displayName (string, trimmed length 1..80) and notifications (boolean, including false) are allowed.
Reject null, arrays, nonobjects, unknown own keys, and invalid values with exactly {ok:false,error:{code:"INVALID_PATCH"}}.
Validate the entire patch before applying anything. Never mutate current or patch. An empty patch is valid.
Preserve unrelated existing settings, but do not accept unknown keys such as role or __proto__ from the patch.

Change only src/index.js; you may add a separate regression-check file. Do not edit package.json, checks.mjs, or existing helper files. Preserve existing checks and run npm test. Use the installed runtime and standard library; no downloads or new dependencies.
