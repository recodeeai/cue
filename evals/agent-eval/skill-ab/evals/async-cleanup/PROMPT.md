Fix withResource(open, action) so that an acquired resource is closed exactly once on success, synchronous action throws, and asynchronous action rejection.
Wait for asynchronous close() before settling. Preserve the action's value or original error when close succeeds.
If open rejects, do not call action. If close rejects, propagate its error (even if action also failed).
Keep the exported API; no retries, pools, or new dependencies.

Change only src/index.js; you may add a separate regression-check file. Do not edit package.json, checks.mjs, or existing helper files. Preserve existing checks and run npm test. Use the installed runtime and standard library; no downloads or new dependencies.
