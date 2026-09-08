import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRuns, readRuns, type Run } from "./report";
import { TASKS } from "./experiment";

const runs = (variant: "before" | "after"): Run[] => TASKS.flatMap((task) =>
  Array.from({ length: 3 }, () => ({
    task, status: "passed" as const, duration: 10, observedModel: "test-model",
    metadata: { variant, model: "test-model", skillSha256: "skill", taskSha256: task, guidanceSha256: variant, instructionsSha256: variant },
    usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
  })));

test("report compares matched repeated runs and flags task regressions", () => {
  const before = runs("before"), after = runs("after");
  after[0]!.status = "failed";
  const result = compareRuns(before, after);
  expect(result.before).toMatchObject({ passed: 15, runs: 15, meanSeconds: 10, meanTokens: 110 });
  expect(result.after.passed).toBe(14);
  expect(result.regressions).toEqual([TASKS[0]]);
  expect(result.observedModelVerified).toBe(true);
});

test("missing token/model evidence is unknown, not zero or verified", () => {
  const before = runs("before"), after = runs("after");
  after[0]!.usage = null;
  after[0]!.observedModel = undefined;
  const result = compareRuns(before, after);
  expect(result.after.meanTokens).toBeNull();
  expect(result.observedModelVerified).toBe(false);
});

test("report rejects missing, unequal, and differently configured samples", () => {
  expect(() => compareRuns([], runs("after"))).toThrow();
  expect(() => compareRuns(runs("before").slice(1), runs("after"))).toThrow();
  for (const field of ["model", "skillSha256", "taskSha256", "guidanceSha256", "instructionsSha256", "executionSha256"] as const) {
    const after = runs("after");
    after[0]!.metadata[field] = "different";
    expect(() => compareRuns(runs("before"), after)).toThrow();
  }
  const after = runs("after");
  after[0]!.observedModel = "different";
  expect(() => compareRuns(runs("before"), after)).toThrow();
});

test("saved result loading validates summaries and usage before reporting", () => {
  const root = mkdtempSync(join(tmpdir(), "cue-ab-report-"));
  const samples = runs("before");
  try {
    for (const task of TASKS) {
      const selected = samples.filter((run) => run.task === task);
      selected.forEach((run, index) => {
        const dir = join(root, task, `run-${index + 1}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "result.json"), JSON.stringify({
          status: run.status, duration: run.duration, observedModel: run.observedModel,
          metadata: { cueSkillAb: run.metadata }, analysis: { tokenUsage: run.usage },
        }));
      });
      writeFileSync(join(root, task, "summary.json"), JSON.stringify({ totalRuns: 3 }));
    }
    expect(readRuns(root)).toEqual(samples);
    const summary = join(root, TASKS[0]!, "summary.json");
    writeFileSync(summary, JSON.stringify({ totalRuns: 3, valid: false }));
    expect(() => readRuns(root)).toThrow("infrastructure-invalid");
    writeFileSync(summary, JSON.stringify({ totalRuns: 3 }));
    writeFileSync(join(root, TASKS[0]!, "run-1/result.json"), JSON.stringify({
      status: "passed", duration: 1, metadata: { cueSkillAb: samples[0]!.metadata },
      analysis: { tokenUsage: { inputTokens: 10, cachedInputTokens: 20, outputTokens: 1 } },
    }));
    expect(() => readRuns(root)).toThrow("Invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
