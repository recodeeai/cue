import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createExperiment, loadExperiment, readTokenUsage } from "./experiment";

test("both arms inject the full skill, changing only integration guidance", async () => {
  const before = createExperiment("before", "test-model", "# Ponytail\nFull skill body.");
  const after = createExperiment("after", "test-model", "# Ponytail\nFull skill body.");
  const { setup: setupBefore, onRunComplete: hookBefore, ...configBefore } = before;
  const { setup: setupAfter, onRunComplete: hookAfter, ...configAfter } = after;
  expect(configBefore).toEqual(configAfter);
  expect(configBefore).toMatchObject({ agent: "codex", runs: 3, earlyExit: false, sandbox: "docker" });
  const capture = async (setup: typeof setupBefore) => {
    let files: Record<string, string> = {};
    await setup!({ writeFiles: async (value) => { files = value; } } as Parameters<NonNullable<typeof setup>>[0]);
    return files;
  };
  const a = await capture(setupBefore);
  const b = await capture(setupAfter);
  expect(Object.keys(a)).toEqual(["AGENTS.md"]);
  expect(Object.keys(b)).toEqual(["AGENTS.md"]);
  expect(a["AGENTS.md"]).toContain("Full skill body.");
  expect(b["AGENTS.md"]).toContain("Full skill body.");
  expect(a["AGENTS.md"]).not.toBe(b["AGENTS.md"]);
  expect(hookBefore).toBeFunction();
  expect(hookAfter).toBeFunction();
});

test("model selection is explicit, never an ambient native default", () => {
  for (const model of [undefined, "", "  ", "model; echo unsafe", "--model"]) {
    expect(() => createExperiment("before", model, "skill")).toThrow("CUE_EVAL_MODEL");
  }
});

test("preflight exits unsuccessfully when configuration is missing", () => {
  const env = { ...process.env };
  delete env.CUE_EVAL_MODEL;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./experiment.ts", import.meta.url))], { env, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CUE_EVAL_MODEL");
});

test("the real loader rejects unpinned skill content without fetching", () => {
  const priorModel = process.env.CUE_EVAL_MODEL, priorSkill = process.env.CUE_EVAL_SKILL;
  const dir = mkdtempSync(join(tmpdir(), "cue-skill-source-"));
  try {
    process.env.CUE_EVAL_MODEL = "test-model";
    process.env.CUE_EVAL_SKILL = join(dir, "SKILL.md");
    expect(() => loadExperiment("before")).toThrow("never downloads");
    writeFileSync(process.env.CUE_EVAL_SKILL, "# Not the pinned skill");
    expect(() => loadExperiment("before")).toThrow("checksum mismatch");
  } finally {
    if (priorModel === undefined) delete process.env.CUE_EVAL_MODEL;
    else process.env.CUE_EVAL_MODEL = priorModel;
    if (priorSkill === undefined) delete process.env.CUE_EVAL_SKILL;
    else process.env.CUE_EVAL_SKILL = priorSkill;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("result hooks preserve existing data and attach snapshot hashes and actual usage", async () => {
  const config = createExperiment("after", "test-model", "skill");
  const runData = { result: { status: "passed" as const, duration: 2, metadata: { existing: true } },
    transcript: '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":2}}' };
  const result = await config.onRunComplete!({ fixture: { name: "shared-limit" }, runData } as Parameters<NonNullable<typeof config.onRunComplete>>[0]);
  expect(result?.result.metadata?.existing).toBe(true);
  expect(result?.result.metadata?.cueSkillAb).toMatchObject({
    variant: "after", model: "test-model", taskSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(result?.result.analysis?.tokenUsage).toEqual({ inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 });
  expect(runData.result.metadata).toEqual({ existing: true });
});

test("Codex usage preserves missing data and does not double-count cached input", () => {
  expect(readTokenUsage(undefined)).toBeNull();
  expect(readTokenUsage("not-json\n{}")).toBeNull();
  const line = (input: number, cached: number, output: number) =>
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } });
  expect(readTokenUsage([line(100, 40, 10), line(50, 20, 5)].join("\n"))).toEqual({
    inputTokens: 150, cachedInputTokens: 60, outputTokens: 15,
  });
  expect(readTokenUsage(JSON.stringify({ type: "turn.completed", usage: { input_tokens: -1 } }))).toBeNull();
});

// These reference repairs stay on the host: the agent never receives them.
const repairs: Record<string, string> = {
  "shared-limit": `export function parseLimit(value) {
  if (value === undefined) return 20;
  const limit = Number(value);
  if (value === "" || !Number.isInteger(limit) || limit < 0 || limit > 100) throw new RangeError("limit");
  return limit;
}
export const listLimit = (value) => parseLimit(value);
export const searchLimit = (value) => parseLimit(value);
`,
  "query-encoding": `import { encodeQuery } from "./query.js";
export function buildUrl(path, params) {
  const query = encodeQuery(params);
  return query ? path + "?" + query : path;
}
`,
  "stable-dedupe": `export function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
`,
  "settings-patch": `export function patchSettings(current, patch) {
  const invalid = { ok: false, error: { code: "INVALID_PATCH" } };
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return invalid;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "displayName") {
      if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 80) return invalid;
    } else if (key === "notifications") {
      if (typeof value !== "boolean") return invalid;
    } else return invalid;
  }
  return { ok: true, value: { ...current, ...patch,
    ...(Object.hasOwn(patch, "displayName") ? { displayName: patch.displayName.trim() } : {}),
  } };
}
`,
  "async-cleanup": `export async function withResource(open, action) {
  const resource = await open();
  try { return await action(resource); }
  finally { await resource.close(); }
}
`,
};

for (const [name, repair] of Object.entries(repairs)) {
  test(`${name}: grader rejects the starter and accepts a reference repair`, () => {
    const scratch = mkdtempSync(join(tmpdir(), "cue-skill-eval-"));
    try {
      cpSync(new URL(`./evals/${name}/`, import.meta.url), scratch, { recursive: true });
      // EVAL.ts deliberately uses only JS + node:assert. Run its identical assertions
      // with node:test locally; fixture devDependencies supply Vitest in Docker.
      const manifest = JSON.parse(readFileSync(join(scratch, "package.json"), "utf8"));
      expect(manifest.devDependencies).toEqual({ vitest: "2.1.0" });
      const grader = readFileSync(join(scratch, "EVAL.ts"), "utf8").replace('from "vitest"', 'from "node:test"');
      writeFileSync(join(scratch, "acceptance.mjs"), grader);
      const run = () => spawnSync("node", ["--test", "acceptance.mjs"], { cwd: scratch, encoding: "utf8", timeout: 10_000 });
      expect(run().status).not.toBe(0);
      writeFileSync(join(scratch, "src/index.js"), repair);
      const fixed = run();
      if (fixed.status !== 0) throw new Error(fixed.stdout + fixed.stderr);
      expect(fixed.stdout + fixed.stderr).not.toContain("Cannot find");
      expect(fixed.status).toBe(0);
      if (name === "async-cleanup") {
        writeFileSync(join(scratch, "src/index.js"), `export async function withResource(open, action) {
          const resource = await open();
          await resource.close();
          return action(resource);
        }`);
        const premature = run();
        expect(premature.status).not.toBe(0);
        expect(premature.stdout).toContain("resource stays open until the async action completes");
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
