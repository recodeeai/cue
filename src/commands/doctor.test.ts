/**
 * D9 activation check (checkActivation). Injectable opts let us drive it
 * against a throwaway HOME/PATH without touching the real machine.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyRuntimeFix, checkActivation, checkCodexHooks, missingMcpIssue } from "./doctor";
import { shimDir } from "../lib/shim-dir";

let home: string;
let binDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cue-doctor-"));
  binDir = shimDir(home);
  mkdirSync(binDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeShim() {
  writeFileSync(join(binDir, "claude"), '#!/usr/bin/env bash\nexec cue launch claude "$@"\n');
}

test("D11 explains dual sources, ownership drift and malformed files without repairing trust", async () => {
  const cue = { hooks: [{ type: "command", command: "cue hook" }] };
  const omx = { hooks: [{ type: "command", command: "omx hook" }] };
  const hooks = { Stop: [cue] };
  writeFileSync(join(home, "config.toml"), '[features]\nhooks = true\n[hooks.state."approved"]\nenabled = true\n');
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { Stop: [omx, cue] } }));
  const legacy = checkCodexHooks("test", home, hooks);
  expect(legacy[0]?.message).toContain("untracked");
  writeFileSync(join(home, ".cue-hooks.json"), JSON.stringify({ version: 1, hooks }));
  expect(checkCodexHooks("test", home, hooks)).toEqual([]);
  expect(checkCodexHooks("test", home, {})[0]?.message).toContain("stale");
  writeFileSync(join(home, "config.toml"), 'hooks = { Stop = [] }\n[hooks.state."approved"]\nenabled = true\n');
  const dual = checkCodexHooks("test", home, hooks);
  expect(dual[0]?.message).toContain("both");
  expect(await applyRuntimeFix(dual[0]!, home)).toBe(false);
  expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('enabled = true');
  writeFileSync(join(home, "hooks.json"), "invalid");
  expect(checkCodexHooks("test", home, hooks).some((issue) => issue.severity === "error")).toBe(true);
});

test("D11 accepts TOML state-only and runtimes with no hooks", () => {
  expect(checkCodexHooks("test", home)).toEqual([]);
  writeFileSync(join(home, "config.toml"), '[hooks.state."approved"]\nenabled = true\n');
  writeFileSync(join(home, "hooks.json"), '{"hooks":{}}');
  expect(checkCodexHooks("test", home)).toEqual([]);
});

describe("checkActivation (D9)", () => {
  test("no shim → D9 warning (gating)", () => {
    const issues = checkActivation({ homeDir: home, realBin: "/usr/bin/claude", pathDirs: [binDir, "/usr/bin"] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("D9");
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain("shim missing");
    expect(issues[0]!.fix).toBe("cue shell install");
  });

  test("shim + real bin + shim dir first on PATH → healthy", () => {
    writeShim();
    const issues = checkActivation({ homeDir: home, realBin: "/usr/bin/claude", pathDirs: [binDir, "/usr/bin"] });
    expect(issues).toHaveLength(0);
  });

  test("shim + real bin shadowing the shim on PATH → D9 error", () => {
    writeShim();
    const issues = checkActivation({ homeDir: home, realBin: "/usr/bin/claude", pathDirs: ["/usr/bin", binDir] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("D9");
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toContain("shadowed");
  });

  test("shim installed but the shim dir is not on PATH → D9 error", () => {
    // New failure mode: cue's shim dir is a directory nothing else puts on
    // PATH, so "installed but never runs" is a real state to catch.
    writeShim();
    const issues = checkActivation({ homeDir: home, realBin: "/usr/bin/claude", pathDirs: ["/usr/bin"] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("D9");
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toContain("not on PATH");
  });

  test("shim but no real claude binary → D9 warning", () => {
    writeShim();
    const issues = checkActivation({ homeDir: home, realBin: null, pathDirs: [binDir] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("D9");
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain("not found");
  });
});

describe("missingMcpIssue (D2)", () => {
  test("registered MCPs are healthy", () => {
    expect(missingMcpIssue("commerce", "github", new Set(["github"]), home)).toBeNull();
  });

  test("local-only MCP sources are warnings, not CI-blocking errors", () => {
    const sources = join(home, "mcp-sources");
    mkdirSync(join(sources, "envoult"), { recursive: true });
    const issue = missingMcpIssue("commerce", "envoult", new Set(), sources);
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("local-only");
  });

  test("unknown MCPs remain errors", () => {
    const issue = missingMcpIssue("commerce", "missing", new Set(), home);
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("not in any registry");
  });
});

describe("applyRuntimeFix (D5/D6)", () => {
  test("D6 removes only the broken symlink and preserves Claude auth files", async () => {
    const runtimeRoot = join(home, "runtime");
    const runtimeDir = join(runtimeRoot, "gstack+ros2", "claude");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, ".credentials.json"), "token");
    writeFileSync(join(runtimeDir, ".cue-hash"), "hash");
    const cacheLink = join(runtimeDir, "cache");
    symlinkSync(cacheLink, cacheLink);

    const ok = await applyRuntimeFix({
      code: "D6",
      severity: "error",
      profile: "gstack+ros2",
      message: "Broken symlink: cache",
      fix: "Remove broken symlink",
      runtimeDir,
      path: cacheLink,
    }, runtimeRoot);

    expect(ok).toBe(true);
    expect(() => lstatSync(cacheLink)).toThrow();
    expect(readFileSync(join(runtimeDir, ".credentials.json"), "utf8")).toBe("token");
    expect(existsSync(join(runtimeDir, ".cue-hash"))).toBe(false);
  });

  test("D5 removes only the stale hash and preserves the runtime directory", async () => {
    const runtimeRoot = join(home, "runtime");
    const runtimeDir = join(runtimeRoot, "core", "claude");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, ".credentials.json"), "token");
    const hashPath = join(runtimeDir, ".cue-hash");
    writeFileSync(hashPath, "hash");

    const ok = await applyRuntimeFix({
      code: "D5",
      severity: "warning",
      profile: "core",
      message: "stale",
      fix: "Remove stale hash",
      runtimeDir,
      path: hashPath,
    }, runtimeRoot);

    expect(ok).toBe(true);
    expect(existsSync(hashPath)).toBe(false);
    expect(lstatSync(runtimeDir).isDirectory()).toBe(true);
    expect(readFileSync(join(runtimeDir, ".credentials.json"), "utf8")).toBe("token");
  });
});
