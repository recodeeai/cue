import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperiment } from "./experiment";
import { localEnvironment, runLocal } from "./local";
import { findRealAgentBin } from "../../../src/lib/claude-binary";

test("local auth keeps CODEX_HOME without forwarding API keys or nested-session state", () => {
  expect(localEnvironment({ PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/auth/home",
    OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret", CUE_REAL_CODEX: "wrapper",
    NODE_OPTIONS: "--require evil", OMX_SESSION_ID: "parent" })).toEqual({
    PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/auth/home",
  });
});

function fixture(mode = "pass", sandboxBin?: string) {
  const root = mkdtempSync(join(tmpdir(), "cue-local-test-"));
  const codex = join(root, "codex");
  writeFileSync(codex, `#!/usr/bin/env node
const fs = require("node:fs"), cp = require("node:child_process");
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
if (args[0] === "--version") { console.log("codex-cli test"); process.exit(0); }
if (args[0] === "login") {
  console.error(mode === "no-login" ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(mode === "no-login" ? 1 : 0);
}
if (args[0] === "sandbox") {
  const native = ${JSON.stringify(sandboxBin ?? null)};
  if (native) {
    const result = cp.spawnSync(native, args, { stdio: "inherit", env: process.env });
    process.exit(result.status ?? 1);
  }
  if (mode === "sandbox-fail") process.exit(1);
  const command = args.slice(args.indexOf("--") + 1);
  const result = cp.spawnSync(command[0], command.slice(1), { cwd: args[args.indexOf("-C") + 1], encoding: "utf8" });
  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
  process.exit(result.status ?? 1);
}
if (args[0] !== "exec") process.exit(9);
if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) process.exit(10);
if (!args.includes("--ignore-user-config") || !args.includes("workspace-write")) process.exit(11);
if (fs.existsSync("EVAL.ts") || fs.existsSync("acceptance.mjs")) process.exit(12);
if (mode === "exec-fail") process.exit(1);
if (mode === "symlink") { fs.unlinkSync("src/index.js"); fs.symlinkSync("/etc/passwd","src/index.js"); }
if (mode === "timeout") { setInterval(() => {}, 1000); return; }
if (!["grader-fail", "symlink"].includes(mode)) fs.writeFileSync("src/index.js",
  "export async function withResource(open, action) { const resource = await open(); try { return await action(resource); } finally { await resource.close(); } }");
if (mode !== "incomplete") console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,cached_input_tokens:5,output_tokens:2}}));
`);
  chmodSync(codex, 0o700);
  const configs = [createExperiment("before", "test-model", "skill"), createExperiment("after", "test-model", "skill")] as const;
  return { root, codex, configs, outputRoot: join(root, "results"), smoke: true };
}

test("native smoke uses saved login and writes instrumented results with hidden graders", async () => {
  const options = fixture();
  try {
    await runLocal(options);
    for (const variant of ["before", "after"]) {
      const dir = join(options.outputRoot, variant, "async-cleanup");
      const result = JSON.parse(readFileSync(join(dir, "run-1/result.json"), "utf8"));
      expect(result.status).toBe("passed");
      expect(result.analysis.tokenUsage).toEqual({ inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 });
      expect(result.metadata.cueSkillAb.variant).toBe(variant);
      expect(result.metadata.cueSkillAb.executionSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"))).toMatchObject({ totalRuns: 1, valid: true });
    }
  } finally { rmSync(options.root, { recursive: true, force: true }); }
});

for (const mode of ["no-login", "exec-fail", "incomplete", "grader-fail", "timeout", "sandbox-fail", "symlink"]) {
  test(`native runner fails closed on ${mode}`, async () => {
    const options = fixture(mode);
    if (mode === "timeout") for (const config of options.configs) config.timeout = 0.1;
    try { await expect(runLocal(options)).rejects.toThrow(); }
    finally { rmSync(options.root, { recursive: true, force: true }); }
  });
}

test.skipIf(process.env.CUE_EVAL_NATIVE_SANDBOX !== "1")("real Codex sandbox preserves grader output and rejects broken code (no model calls)", async () => {
  const codex = findRealAgentBin("codex");
  if (!codex) throw new Error("Codex is required for the opt-in sandbox test.");
  for (const mode of ["pass", "grader-fail"]) {
    const options = fixture(mode, codex);
    try {
      if (mode === "pass") await runLocal(options);
      else await expect(runLocal(options)).rejects.toThrow("graded run");
    } finally { rmSync(options.root, { recursive: true, force: true }); }
  }
});
