/**
 * E2e test for `cue launch` — tests the full resolve → materialize → exec flow.
 * Uses --rematerialize to avoid actually exec'ing claude/codex.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadProfile } from "../lib/profile-loader";
import { cacheKey } from "../lib/resolver-npx";

const CUE_BIN = join(import.meta.dir, "../index.ts");

// These e2e tests shell out to `bun run`. In some sandboxes (and odd PATH
// setups) a spawned child can't find `bun`, which would hard-fail the suite
// with "Executable not found in $PATH: bun" — unrelated to what's under test.
// Skip the whole describe when a child `bun` can't be spawned. CI installs bun
// via setup-bun, so this only skips in constrained local/sandbox runs.
const BUN_SPAWNABLE = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
// `resources/skills` is a git submodule. On a fresh clone without
// `git submodule update --init --recursive` it's an empty tree, so the
// materializer has no skills to symlink and `cue launch` exits non-zero — a
// setup gap, not a regression. Skip rather than fail spuriously.
const SKILLS_PRESENT = existsSync(join(import.meta.dir, "../../resources/skills/skills"));

async function seedNpxCache(cacheHome: string, profileNames: string[]): Promise<void> {
  for (const profileName of profileNames) {
    const profile = await loadProfile(profileName);
    for (const entry of profile.skills.npx) {
      const slot = join(cacheHome, "cue", "npx", cacheKey(entry.repo, entry.pin));
      for (const skill of entry.skills) {
        const skillDir = join(slot, skill);
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), `# ${skill}\n`);
      }
    }
  }
}

function cue(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { status: number; stdout: string; stderr: string } {
  // Strip env vars set when the test runner itself is running inside a cue
  // session — they propagate to the child cue invocation and break it in
  // ways that have nothing to do with the test:
  //   CUE_LAUNCHING=1       → triggers the shim-recursion guard
  //   CLAUDE_CONFIG_DIR=... → triggers isAccountAlias → forces picker → fails on non-TTY
  //   CUE_BYPASS=1          → short-circuits straight to exec, so nothing below
  //                           would resolve or materialize anything
  // Order matters: strip from the inherited env FIRST, then layer opts.env on
  // top, so a test that wants one of these can still set it.
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  delete cleanEnv.CUE_LAUNCHING;
  delete cleanEnv.CLAUDE_CONFIG_DIR;
  delete cleanEnv.CUE_BYPASS;
  Object.assign(cleanEnv, opts.env);
  const res = spawnSync("bun", ["run", CUE_BIN, ...args], {
    encoding: "utf8",
    timeout: 15000,
    cwd: opts.cwd ?? process.cwd(),
    env: cleanEnv,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe.skipIf(!BUN_SPAWNABLE || !SKILLS_PRESENT)("cue launch e2e", () => {
  let tmpDir: string;
  let oldXdgConfigHome: string | undefined;
  let oldXdgCacheHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cue-e2e-launch-"));
    oldXdgConfigHome = process.env.XDG_CONFIG_HOME;
    oldXdgCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CONFIG_HOME = join(tmpDir, "xdg");
    process.env.XDG_CACHE_HOME = join(tmpDir, "cache");
    // Launch now resolves pinned npx skills before materializing. Keep this
    // e2e hermetic: exercise the real cache-hit path without relying on the
    // network or mutating the developer's shared cache.
    await seedNpxCache(process.env.XDG_CACHE_HOME, ["core", "ponytail", "caveman-quick", "rust", "backend"]);
  });

  afterEach(async () => {
    if (oldXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdgConfigHome;
    if (oldXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldXdgCacheHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("launch --rematerialize with .cue.profile resolves and builds runtime", async () => {
    // Create a .cue.profile pointing to a real profile
    await writeFile(join(tmpDir, ".cue.profile"), "caveman-quick\n");

    const res = cue(["launch", "claude", "--rematerialize"], { cwd: tmpDir });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("caveman-quick");
    expect(res.stdout).toContain("runtimeDir");

    // Parse the JSON output
    const jsonMatch = res.stdout.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const output = JSON.parse(jsonMatch![0]);
    expect(output.profile).toBe("caveman-quick");
    expect(output.agent).toBe("claude-code");
    expect(output.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("launch --rematerialize second call is cache hit (rebuilt=false)", async () => {
    await writeFile(join(tmpDir, ".cue.profile"), "core\n");

    const first = cue(["launch", "claude", "--rematerialize"], { cwd: tmpDir });
    expect(first.status).toBe(0);
    const firstJson = JSON.parse(first.stdout.match(/\{[\s\S]*\}/)![0]);
    expect(firstJson.rebuilt).toBe(true);

    // Second call with same profile — may or may not be cache hit depending
    // on whether CLAUDE.md includes dynamic content (timestamps, session summary).
    // At minimum, it should succeed.
    const second = cue(["launch", "claude", "--rematerialize"], { cwd: tmpDir });
    expect(second.status).toBe(0);
    const secondJson = JSON.parse(second.stdout.match(/\{[\s\S]*\}/)![0]);
    expect(secondJson.profile).toBe("core");
  });

  test("launch resolves profile from .cue.profile in parent directory", async () => {
    // Create a subdirectory and put .cue.profile in parent
    const { mkdir } = await import("node:fs/promises");
    const subDir = join(tmpDir, "src", "lib");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(tmpDir, ".cue.profile"), "rust\n");

    const res = cue(["launch", "claude", "--rematerialize"], { cwd: subDir });
    expect(res.status).toBe(0);
    const output = JSON.parse(res.stdout.match(/\{[\s\S]*\}/)![0]);
    expect(output.profile).toBe("rust");
  });

  test("launch produces CLAUDE.md with profile stamp in runtime dir", async () => {
    await writeFile(join(tmpDir, ".cue.profile"), "backend\n");

    const res = cue(["launch", "claude", "--rematerialize"], { cwd: tmpDir });
    expect(res.status).toBe(0);

    const output = JSON.parse(res.stdout.match(/\{[\s\S]*\}/)![0]);
    const claudeMd = await readFile(join(output.runtimeDir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("profile=backend");
    expect(claudeMd).toContain("Active Profile:");
  });

  test("launch produces settings.json with MCPs and plugins", async () => {
    await writeFile(join(tmpDir, ".cue.profile"), "backend\n");

    const res = cue(["launch", "claude", "--rematerialize"], { cwd: tmpDir });
    expect(res.status).toBe(0);

    const output = JSON.parse(res.stdout.match(/\{[\s\S]*\}/)![0]);
    const settings = JSON.parse(await readFile(join(output.runtimeDir, "settings.json"), "utf8"));
    expect(settings).toHaveProperty("mcpServers");
    expect(settings).toHaveProperty("enabledPlugins");
  });

  test("launch creates skills/ symlinks in runtime dir", async () => {
    await writeFile(join(tmpDir, ".cue.profile"), "backend\n");

    const res = cue(["launch", "claude", "--rematerialize"], { cwd: tmpDir });
    expect(res.status).toBe(0);

    const output = JSON.parse(res.stdout.match(/\{[\s\S]*\}/)![0]);
    const skillsDir = join(output.runtimeDir, "skills");
    const entries = await readdir(skillsDir);
    expect(entries.length).toBeGreaterThan(0);
  });

  // CUE_BYPASS=1 is documented in docs/launch.md and docs/shell-install.md as
  // "exec the real binary directly; no resolve, no materialize, no profile".
  // For a long time nothing implemented that: the flag only suppressed the
  // loader spinner and (after #133) the CUE_SMART_SUBSET fold, while the full
  // pipeline still ran. Both arms below run the SAME argv against a fake
  // `claude` first on PATH — the only variable is the flag.
  test("CUE_BYPASS=1 execs the real binary instead of resolving/materializing", async () => {
    const { mkdir } = await import("node:fs/promises");
    const binDir = join(tmpDir, "fakebin");
    await mkdir(binDir, { recursive: true });
    // Must not read as a cue shim, or findRealAgentBin() skips it by content.
    await writeFile(join(binDir, "claude"), '#!/usr/bin/env bash\necho "FAKE-CLAUDE $*"\n', { mode: 0o755 });
    await writeFile(join(tmpDir, ".cue.profile"), "core\n");
    const fakePath = `${binDir}:${process.env.PATH}`;

    // Control: cue resolves the pin and reports the runtime it built.
    const normal = cue(["launch", "claude", "--rematerialize"], {
      cwd: tmpDir,
      env: { PATH: fakePath },
    });
    expect(normal.status).toBe(0);
    expect(normal.stdout).toContain("runtimeDir");
    expect(normal.stdout).not.toContain("FAKE-CLAUDE");

    // Bypassed: straight to exec. No profile line, no runtime JSON — and the
    // cue-only flag is stripped rather than forwarded to the agent.
    const bypassed = cue(["launch", "claude", "--rematerialize"], {
      cwd: tmpDir,
      env: { PATH: fakePath, CUE_BYPASS: "1" },
    });
    expect(bypassed.status).toBe(0);
    expect(bypassed.stdout).toContain("FAKE-CLAUDE");
    expect(bypassed.stdout).not.toContain("--rematerialize");
    expect(bypassed.stdout).not.toContain("runtimeDir");
    expect(bypassed.stdout).not.toContain("core");
  });

  test("CUE_BYPASS=1 forwards passthrough args and the exit code verbatim", async () => {
    const { mkdir } = await import("node:fs/promises");
    const binDir = join(tmpDir, "fakebin");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "claude"),
      '#!/usr/bin/env bash\necho "FAKE-CLAUDE $*"\nexit 42\n',
      { mode: 0o755 },
    );

    // No .cue.profile anywhere and stdin is not a TTY, so the normal path would
    // bail with "no profile resolved" long before exec.
    const res = cue(["launch", "claude", "--print", "-p", "hello"], {
      cwd: tmpDir,
      env: { PATH: `${binDir}:${process.env.PATH}`, CUE_BYPASS: "1" },
    });

    expect(res.status).toBe(42);
    expect(res.stdout.trim()).toBe("FAKE-CLAUDE --print -p hello");
  });
});
