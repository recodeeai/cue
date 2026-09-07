import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const workflow = (name: string) => parse(readFileSync(
  resolve(import.meta.dirname, "../../.github/workflows", name), "utf8",
));

describe("CI verification contracts", () => {
  test("profile validation fails the main CI on errors", () => {
    const steps = workflow("ci.yml").jobs.test.steps;
    const validation = steps.find((step: { run?: string }) => step.run?.includes("validate --all"));
    expect(validation).toBeDefined();
    expect(validation.run).not.toContain("||");
    expect(validation["continue-on-error"]).not.toBe(true);
  });

  test("full Node matrix builds and exercises the bundled CLI", () => {
    const steps = workflow("ci-full.yml").jobs.test.steps;
    const commands = steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(commands).toContain("bun install --frozen-lockfile");
    expect(commands).toContain("bun run build:bundle");
    expect(commands).toContain("node bin/cue.mjs list --json");
    expect(commands).not.toContain("Replace this step");
  });

  test("CI checks the separate web TypeScript project", () => {
    const jobs = workflow("ci.yml").jobs;
    const steps = Object.values(jobs).flatMap((job: any) => job.steps);
    expect(steps.some((step: { run?: string }) => step.run?.includes("tsc --noEmit -p web/tsconfig.json"))).toBe(true);
  });

  test("main validation also covers source-only and submodule PRs", () => {
    const trigger = workflow("ci.yml").on.pull_request;
    expect(trigger.branches).toContain("main");
    expect(trigger.paths).toBeUndefined();
    expect(trigger["paths-ignore"]).toBeUndefined();
  });
});
