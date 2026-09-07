/**
 * `cue doctor` — detect drift between declared profiles and disk state.
 *
 * Checks:
 *   D1: Skill in profile but not on disk
 *   D2: MCP in profile but not in registry
 *   D3: Orphan skill (on disk, not in any profile)
 *   D4: Skill requires MCP not in profile
 *   D5: Stale runtime hash
 *   D6: Broken symlink in materialized runtime
 *
 * Flags:
 *   --fix     Apply safe repairs
 *   --json    Output as JSON
 *   --profile <name>  Check only one profile (default: all)
 */

import { readFileSync, existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { listProfiles, loadProfile } from "../lib/profile-loader";
import { listAllSkillIds } from "../lib/resolver-local";
import { findIncompleteSkills, fetchCompanionFiles, readSourceFile } from "../lib/companion-fetch";
import { detectMissingDependencies } from "../lib/skill-dependencies";
import { shimInstalled, runInstall } from "./shell";
import { shimDir, shimDirPosition } from "../lib/shim-dir";
import { findRealClaudeBin } from "../lib/claude-binary";
import { repoRoot } from "../lib/repo-root";
import { cacheKey, suppressionRemainingMs } from "../lib/resolver-npx";
import { clearFetchFailure, readFetchFailure } from "../lib/cache";

const PROFILES_DIR = process.env.CUE_PROFILES_DIR ?? join(repoRoot(), "profiles");
const SKILLS_ROOT = join(repoRoot(), "resources", "skills", "skills");
const MCP_CONFIGS_DIR = join(repoRoot(), "resources", "mcps", "configs");
const MCP_SOURCES_DIR = join(repoRoot(), "resources", "mcps", "mcps");
const QUALITY_GATES_DIR = join(repoRoot(), "resources", "quality-gates");
const RUNTIME_ROOT = join(process.env.HOME ?? "~", ".config", "cue", "runtime");

export interface Issue {
  code: string;
  severity: "error" | "warning";
  profile: string;
  message: string;
  fix?: string;
  runtimeDir?: string;
  path?: string;
  /**
   * Cache slot this issue is about (D10). Carried rather than re-derived: a
   * profile may reference the same repo at two pins, and those are different
   * slots — looking the entry back up by repo alone would clear the wrong one.
   */
  cacheKey?: string;
}

function loadAllMcpIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of ["claude.sanitized.json", "claude_runtime.sanitized.json", "codex.sanitized.json"]) {
    try {
      const raw = JSON.parse(readFileSync(join(MCP_CONFIGS_DIR, file), "utf8"));
      if (raw.servers) for (const id of Object.keys(raw.servers)) ids.add(id);
    } catch { /* skip */ }
  }
  return ids;
}

export function missingMcpIssue(
  profile: string,
  id: string,
  registeredIds: ReadonlySet<string>,
  sourcesDir = MCP_SOURCES_DIR,
): Issue | null {
  if (registeredIds.has(id)) return null;
  const hasLocalSource =
    /^[A-Za-z0-9._-]+$/.test(id) && existsSync(join(sourcesDir, id));
  if (hasLocalSource) {
    return {
      code: "D2",
      severity: "warning",
      profile,
      message: `MCP "${id}" is local-only and absent from the sanitized registry`,
      fix: `Configure "${id}" in the user's agent MCP settings`,
    };
  }
  return {
    code: "D2",
    severity: "error",
    profile,
    message: `MCP "${id}" declared but not in any registry config`,
    fix: `Remove "${id}" from ${profile}/profile.yaml mcps section`,
  };
}

async function checkProfile(profileName: string, allSkillIds: Set<string>, allMcpIds: Set<string>): Promise<Issue[]> {
  const issues: Issue[] = [];

  let profile;
  try {
    profile = await loadProfile(profileName);
  } catch (err) {
    issues.push({ code: "D0", severity: "error", profile: profileName, message: `Cannot load: ${err}` });
    return issues;
  }

  const profileSkillIds = profile.skills.local.map(s => s.id);
  const profileMcpIds = profile.mcps.map(m => m.id);

  // D1: Skill in profile but not on disk. The "*/*" wildcard is a materialize-
  // time glob (loads every skill), not a literal slug — skip it.
  for (const id of profileSkillIds) {
    if (id === "*/*") continue;
    if (!allSkillIds.has(id)) {
      issues.push({
        code: "D1",
        severity: "error",
        profile: profileName,
        message: `Skill "${id}" declared but not found on disk`,
        fix: `Remove "${id}" from ${profileName}/profile.yaml`,
      });
    }
  }

  // D2: MCP in profile but not in registry
  for (const id of profileMcpIds) {
    const issue = missingMcpIssue(profileName, id, allMcpIds);
    if (issue) issues.push(issue);
  }

  // D10: a remote skill repo whose fetch failed and is now cooling down. The
  // launch path degrades silently-ish here — it prints one line and moves on —
  // so without this check a skill can stay missing for days with no obvious
  // reason. Reconstructing the cache key from the profile means the marker
  // needs to store nothing but the failure itself.
  for (const entry of profile.skills.npx) {
    const key = cacheKey(entry.repo, entry.pin);
    const mark = readFetchFailure({}, key);
    if (!mark) continue;
    // A marker outlives its own cooldown, and it may be about other skills
    // entirely — so its existence alone would report a repo as suppressed when
    // the very next launch is going to retry it. Ask the resolver's own
    // predicate rather than re-deriving the rule here.
    const remaining = suppressionRemainingMs(mark, entry.skills);
    if (remaining <= 0) continue;
    const ago = Math.max(0, Date.now() - mark.at);
    issues.push({
      code: "D10",
      severity: "warning",
      profile: profileName,
      message:
        `Remote skills from "${entry.repo}" are cooling down after ` +
        `${mark.strikes} failed fetch${mark.strikes === 1 ? "" : "es"} ` +
        `(last ${formatAgo(ago)}: ${mark.reason}); retries in ${formatAgo(remaining).replace(" ago", "")}`,
      fix: "cue doctor --fix, or CUE_NPX_FORCE=1 cue launch, to retry now",
      path: entry.repo,
      cacheKey: key,
    });
  }

  // D4: Skill requires MCP not in profile (explicit requires_mcps + implicit
  // mcp__server__ refs). Implicit deps are regex-scanned from skill prose, so
  // only surface them when the server is a real, wirable MCP in the registry —
  // otherwise a server name used only as an example would false-positive.
  // Mirrors the launch banner's quickDiagnose logic.
  for (const m of detectMissingDependencies(profileName, profileSkillIds, profileMcpIds)) {
    if (m.source === "implicit" && !allMcpIds.has(m.mcpId)) continue;
    issues.push({
      code: "D4",
      severity: "warning",
      profile: profileName,
      message: `Skill "${m.skillId}" requires MCP "${m.mcpId}" (${m.source}) which is not in profile`,
      fix: `Add "${m.mcpId}" to ${profileName}/profile.yaml mcps section`,
    });
  }

  // D5: Stale runtime hash
  for (const agent of ["claude", "codex"]) {
    const hashFile = join(RUNTIME_ROOT, profileName, agent, ".cue-hash");
    if (existsSync(hashFile)) {
      // We can't easily recompute the exact hash without the full materialize
      // input, but we can check if the profile.yaml mtime is newer than the hash file
      try {
        const hashStat = lstatSync(hashFile);
        const yamlPath = join(PROFILES_DIR, profileName, "profile.yaml");
        if (existsSync(yamlPath)) {
          const yamlStat = lstatSync(yamlPath);
          if (yamlStat.mtimeMs > hashStat.mtimeMs) {
            issues.push({
              code: "D5",
              severity: "warning",
              profile: profileName,
              message: `Runtime for ${agent} may be stale (profile.yaml newer than hash)`,
              fix: `Remove stale .cue-hash; next launch will rebuild`,
              runtimeDir: dirname(hashFile),
              path: hashFile,
            });
          }
        }
      } catch { /* skip */ }
    }
  }

  // D6: Broken symlinks in materialized runtime
  for (const agent of ["claude", "codex"]) {
    const runtimeDir = join(RUNTIME_ROOT, profileName, agent);
    if (!existsSync(runtimeDir)) continue;
    try {
      const entries = readdirSync(runtimeDir);
      for (const entry of entries) {
        const entryPath = join(runtimeDir, entry);
        try {
          const st = lstatSync(entryPath);
          if (st.isSymbolicLink()) {
            const target = readlinkSync(entryPath);
            const resolvedTarget = resolve(dirname(entryPath), target);
            if (!existsSync(resolvedTarget)) {
              issues.push({
                code: "D6",
                severity: "error",
                profile: profileName,
                message: `Broken symlink: ${entry} → ${target} (in ${agent} runtime)`,
                fix: `Remove broken symlink and stale hash; next launch will rebuild`,
                runtimeDir,
                path: entryPath,
              });
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* runtime dir unreadable */ }
  }

  // D7: Incomplete skill installs (SKILL.md declares companions but they're missing)
  const incomplete = findIncompleteSkills(SKILLS_ROOT);
  const profileSkillSlugs = new Set(profileSkillIds.map(id => id.split("/").pop()));
  for (const skill of incomplete) {
    // Only report if this skill belongs to the current profile
    const slug = skill.id.split("/").pop();
    if (!profileSkillSlugs.has(slug)) continue;
    issues.push({
      code: "D7",
      severity: "warning",
      profile: profileName,
      message: `Skill "${skill.id}" missing companions: ${skill.missing.join(", ")}`,
      fix: `Fetch missing companions for "${skill.id}"`,
    });
  }

  // D8: Quality gates declared but the underlying script doesn't exist on
  // disk. The materializer silently skips missing gates, so without this
  // check a typo in qualityGates would just make the gate disappear at
  // Stop time — visibly broken contract, no error.
  const declaredGates = (profile as { qualityGates?: string[] }).qualityGates ?? [];
  for (const ref of declaredGates) {
    const fname = ref.endsWith(".sh") ? ref : `${ref}.sh`;
    const gatePath = join(QUALITY_GATES_DIR, fname);
    if (!existsSync(gatePath)) {
      issues.push({
        code: "D8",
        severity: "warning",
        profile: profileName,
        message: `Quality gate "${ref}" declared but resources/quality-gates/${fname} doesn't exist`,
        fix: `Add the script or remove "${ref}" from profile.yaml qualityGates`,
      });
    }
  }

  return issues;
}

/**
 * D9 — Activation health (environment-scoped, runs once, not per profile).
 * Verifies the claude shim is installed, the real binary resolves, and cue's
 * shim dir precedes it on PATH. Injectable for testing.
 */
export function checkActivation(
  opts: { homeDir?: string; pathDirs?: string[]; realBin?: string | null } = {},
): Issue[] {
  const issues: Issue[] = [];
  const PROF = "(activation)";

  // 1. The claude shim must be installed (and be a cue shim). Gating check —
  //    the rest is moot without it.
  if (!shimInstalled(opts.homeDir)) {
    // Warning, not error: a user may legitimately not have run `cue shell
    // install` yet (or use `cue launch` directly). Surfacing it shouldn't flip
    // `cue doctor`'s exit code, which should track actual profile breakage.
    issues.push({
      code: "D9",
      severity: "warning",
      profile: PROF,
      message: "claude shim missing or not a cue shim — `claude` won't load profiles (run `cue shell install`)",
      fix: "cue shell install",
    });
    return issues;
  }

  // 2. The real claude binary must resolve.
  const realBin = opts.realBin !== undefined ? opts.realBin : findRealClaudeBin();
  if (!realBin) {
    issues.push({
      code: "D9",
      severity: "warning",
      profile: PROF,
      message: "Real claude binary not found on PATH (only the cue shim resolves)",
      fix: "Install Claude Code, or set CUE_REAL_CLAUDE",
    });
    return issues;
  }

  // 3. cue's shim dir must be on PATH, ahead of the real binary's dir.
  //    "Absent" is its own failure now that the shims live in a directory
  //    nothing else puts on PATH: the shim exists but never runs.
  const dir = shimDir(opts.homeDir);
  const pathDirs = opts.pathDirs ?? (process.env.PATH ?? "").split(":");
  const position = shimDirPosition(pathDirs, realBin, dir);
  if (position === "absent") {
    issues.push({
      code: "D9",
      severity: "error",
      profile: PROF,
      message: `${dir} is not on PATH — the shim is installed but never runs`,
      fix: `Add ${dir} to the front of PATH (cue shell install writes the line for you)`,
    });
  } else if (position === "after") {
    issues.push({
      code: "D9",
      severity: "error",
      profile: PROF,
      message: `Real binary dir ${resolve(realBin, "..")} precedes ${dir} on PATH — the shim is shadowed`,
      fix: `Reorder PATH so ${dir} comes before the real claude/codex`,
    });
  }

  return issues;
}

/** "3h ago" / "12m ago" — coarse; this is context, not a timestamp. */
function formatAgo(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export async function applyRuntimeFix(issue: Issue, runtimeRoot = RUNTIME_ROOT): Promise<boolean> {
  if (issue.code === "D5") {
    const hashPath = issue.path ?? join(runtimeRoot, issue.profile, "claude", ".cue-hash");
    try {
      await rm(hashPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  if (issue.code === "D6") {
    if (!issue.path) return false;
    try {
      const st = lstatSync(issue.path);
      if (!st.isSymbolicLink()) return false;
      await rm(issue.path, { recursive: true, force: true });
      const runtimeDir = issue.runtimeDir ?? dirname(issue.path);
      await rm(join(runtimeDir, ".cue-hash"), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

async function applyFix(issue: Issue): Promise<boolean> {
  const yamlPath = join(PROFILES_DIR, issue.profile, "profile.yaml");

  switch (issue.code) {
    case "D1": {
      // Remove skill from profile
      const idMatch = issue.message.match(/Skill "([^"]+)"/);
      if (!idMatch) return false;
      const id = idMatch[1]!;
      try {
        const content = await readFile(yamlPath, "utf8");
        const lines = content.split("\n");
        const filtered = lines.filter(l => !l.includes(`- ${id}`));
        if (filtered.length < lines.length) {
          await writeFile(yamlPath, filtered.join("\n"));
          return true;
        }
      } catch { /* skip */ }
      return false;
    }
    case "D2": {
      // Remove MCP from profile
      const idMatch = issue.message.match(/MCP "([^"]+)"/);
      if (!idMatch) return false;
      const id = idMatch[1]!;
      try {
        const content = await readFile(yamlPath, "utf8");
        const lines = content.split("\n");
        const filtered = lines.filter(l => !l.includes(`- ${id}`));
        if (filtered.length < lines.length) {
          await writeFile(yamlPath, filtered.join("\n"));
          return true;
        }
      } catch { /* skip */ }
      return false;
    }
    case "D4": {
      // Add required MCP to profile
      const mcpMatch = issue.message.match(/requires MCP "([^"]+)"/);
      if (!mcpMatch) return false;
      const mcp = mcpMatch[1]!;
      try {
        let content = await readFile(yamlPath, "utf8");
        if (content.includes("mcps:")) {
          const lines = content.split("\n");
          const mcpsIdx = lines.findIndex(l => l.match(/^mcps:/));
          let insertIdx = mcpsIdx + 1;
          while (insertIdx < lines.length && lines[insertIdx]?.match(/^\s+-\s/)) insertIdx++;
          lines.splice(insertIdx, 0, `  - ${mcp}`);
          content = lines.join("\n");
        } else {
          content = content.trimEnd() + `\nmcps:\n  - ${mcp}\n`;
        }
        await writeFile(yamlPath, content);
        return true;
      } catch { /* skip */ }
      return false;
    }
    case "D5":
    case "D6":
      return applyRuntimeFix(issue);
    case "D7": {
      // Fetch missing companion files for incomplete skill
      const idMatch = issue.message.match(/Skill "([^"]+)"/);
      if (!idMatch) return false;
      const skillId = idMatch[1]!;
      const skillDir = join(SKILLS_ROOT, skillId);
      if (!existsSync(skillDir)) return false;

      const source = readSourceFile(skillDir);
      if (!source) return false;
      const { fetched } = fetchCompanionFiles(source.repo, source.skillPath, skillDir, {
        ref: source.ref,
        writeSource: true,
      });
      return fetched.length > 0;
    }
    case "D10": {
      // Forget the failure so the next launch fetches for real. The fix is
      // deliberately not a fetch of its own: doctor should stay fast and
      // offline-safe, and the retry belongs to the launch that needs the skill.
      if (!issue.cacheKey) return false;
      clearFetchFailure({}, issue.cacheKey);
      return true;
    }

    case "D9": {
      // Install/repair the shim. runInstall returns 1 (no throw) when PATH
      // ordering is wrong — that case can't be auto-fixed (user must reorder
      // their shell PATH), so success is keyed on rc === 0.
      const realBin = findRealClaudeBin();
      const rc = await runInstall({ realClaude: realBin ?? undefined });
      return rc === 0;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(`cue doctor — detect and fix profile drift

Usage: cue doctor [profile] [--fix] [--clis] [--json]

Checks:
  D1  Skill in profile but not on disk
  D2  MCP in profile but not in registry
  D3  Orphan skill (on disk, not in any profile)
  D4  Skill requires MCP not in profile
  D5  Stale runtime hash
  D6  Broken symlink in runtime
  D7  Incomplete skill (companions declared but missing)
  D8  Quality gate declared but the .sh under resources/quality-gates/ is missing
  D9  Activation: claude shim installed, real claude resolves, shim dir precedes it on PATH
  D10 Remote skill repo cooling down after failed fetches

Flags:
  --fix             Auto-repair issues
  --clis            Check if required CLIs are installed
  --profile <name>  Check one profile only
  --json            Machine-readable output

Examples:
  cue doctor                    # check all profiles
  cue doctor --fix              # auto-repair
  cue doctor --clis backend     # check CLI deps for backend
  cue doctor --clis cybersecurity
`);
    return 0;
  }

  const fix = args.includes("--fix");
  const json = args.includes("--json");
  const cliCheck = args.includes("--clis");
  const profileFlag = args.indexOf("--profile");
  const targetProfile = profileFlag >= 0 ? args[profileFlag + 1] : (args.find(a => !a.startsWith("-")) ?? null);

  // CLI doctor mode: check if required CLIs are installed
  if (cliCheck) {
    return runCliDoctor(targetProfile, json);
  }

  const allSkillIds = new Set(await listAllSkillIds());
  const allMcpIds = loadAllMcpIds();

  // D3: Orphan skills (on disk, not in any profile)
  const profileNames = targetProfile ? [targetProfile] : await listProfiles();
  const allProfileSkillIds = new Set<string>();
  // A profile carrying the "*/*" wildcard (e.g. `full`) loads every skill at
  // materialize time, so it homes all of them — nothing is orphaned.
  let hasGlobAll = false;

  const issues: Issue[] = [];

  for (const name of profileNames) {
    const profileIssues = await checkProfile(name, allSkillIds, allMcpIds);
    issues.push(...profileIssues);

    try {
      const profile = await loadProfile(name);
      for (const s of profile.skills.local) {
        if (s.id === "*/*") hasGlobAll = true;
        else allProfileSkillIds.add(s.id);
      }
    } catch { /* skip */ }
  }

  // D9: activation health (shim + real binary + PATH order). Environment-
  // scoped, so run once regardless of --profile.
  issues.push(...checkActivation());

  // D3 only when checking all profiles, and only if no profile globs everything.
  if (!targetProfile && !hasGlobAll) {
    for (const id of allSkillIds) {
      if (!allProfileSkillIds.has(id)) {
        issues.push({
          code: "D3",
          severity: "warning",
          profile: "(none)",
          message: `Orphan skill "${id}" — on disk but not in any profile`,
        });
      }
    }
  }

  // Security scan — check for prompt injection in profile skills
  if (!json) process.stdout.write("\n🔒 Running security scan...\n");
  const { run: runSecurity } = await import("./security");
  const secArgs = targetProfile ? [targetProfile, "--json"] : ["--all", "--json"];
  // Capture security output
  const origWrite = process.stdout.write.bind(process.stdout);
  let secOutput = "";
  process.stdout.write = ((chunk: string) => { secOutput += chunk; return true; }) as typeof process.stdout.write;
  await runSecurity(secArgs);
  process.stdout.write = origWrite;

  try {
    const secData = JSON.parse(secOutput) as { scanned: number; issues: { code: string; severity: string; skill: string; message: string }[] };
    const secCritical = secData.issues.filter(i => i.severity === "critical");
    if (secCritical.length > 0) {
      for (const i of secCritical) {
        issues.push({ code: i.code, severity: "error", profile: "(security)", message: `${i.skill}: ${i.message}` });
      }
      if (!json) process.stdout.write(`  🔴 ${secCritical.length} critical security issue(s) found!\n`);
    } else {
      if (!json) process.stdout.write(`  ✅ No critical security issues.\n`);
    }
  } catch { /* security scan failed — non-fatal */ }

  // Output
  if (json) {
    process.stdout.write(JSON.stringify({ healthy: issues.length === 0, issues }, null, 2) + "\n");
  } else {
    if (issues.length === 0) {
      process.stdout.write("\n✅ All profiles healthy. No issues found.\n");
      return 0;
    }

    const errors = issues.filter(i => i.severity === "error");
    const warnings = issues.filter(i => i.severity === "warning");
    process.stdout.write(`\nFound ${issues.length} issue(s): ${errors.length} error(s), ${warnings.length} warning(s)\n\n`);

    for (const issue of issues) {
      const icon = issue.severity === "error" ? "❌" : "⚠️";
      process.stdout.write(`  ${icon} [${issue.code}] ${issue.profile}: ${issue.message}\n`);
      if (issue.fix) process.stdout.write(`         fix: ${issue.fix}\n`);
    }
  }

  // Apply fixes
  if (fix && issues.length > 0) {
    process.stdout.write("\nApplying fixes...\n");
    let fixed = 0;
    for (const issue of issues) {
      if (!issue.fix) continue;
      const ok = await applyFix(issue);
      if (ok) {
        fixed++;
        process.stdout.write(`  ✅ Fixed [${issue.code}] ${issue.profile}: ${issue.message}\n`);
      } else {
        process.stdout.write(`  ❌ Could not fix [${issue.code}] ${issue.profile}\n`);
      }
    }
    process.stdout.write(`\n${fixed}/${issues.filter(i => i.fix).length} issues fixed.\n`);
  } else if (!fix && issues.length > 0) {
    process.stdout.write("\nRun with --fix to apply repairs.\n");
  }

  return issues.some(i => i.severity === "error") ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI Doctor — check if required CLIs are installed on the machine
// ---------------------------------------------------------------------------

// Install hints for common CLIs
const INSTALL_HINTS: Record<string, string> = {
  python: "apt install python3 / brew install python",
  pip: "apt install python3-pip / comes with python",
  docker: "curl -fsSL https://get.docker.com | sh",
  kubectl: "curl -LO https://dl.k8s.io/release/stable.txt && ...",
  helm: "curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash",
  terraform: "brew install terraform / apt install terraform",
  aws: "curl https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o aws.zip && ...",
  gcloud: "curl https://sdk.cloud.google.com | bash",
  node: "curl -fsSL https://bun.sh/install | bash (or nvm install 22)",
  npm: "comes with node",
  go: "apt install golang / brew install go",
  cargo: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
  nmap: "apt install nmap / brew install nmap",
  wireshark: "apt install wireshark / brew install wireshark",
  ghidra: "download from https://ghidra-sre.org",
  frida: "pip install frida-tools",
  splunk: "download from https://splunk.com",
  jq: "apt install jq / brew install jq",
  curl: "apt install curl / brew install curl",
  git: "apt install git / brew install git",
};

async function runCliDoctor(profileName: string | null, json: boolean): Promise<number> {
  if (!profileName) {
    process.stderr.write("Usage: cue doctor --clis --profile <name>\n");
    process.stderr.write("       cue doctor --clis <profile-name>\n");
    return 1;
  }

  // Load the optimizer's CLI extraction logic
  const SKILLS_ROOT_PATH = join(repoRoot(), "resources", "skills", "skills");
  const HOME_SKILLS_PATH = join(process.env.HOME ?? "~", ".claude", "skills");

  // Load profile to get skills
  let profile;
  try { profile = await loadProfile(profileName); } catch {
    process.stderr.write(`Profile "${profileName}" not found.\n`);
    return 1;
  }

  const skillIds = profile.skills.local.map(s => s.id);

  // Extract CLIs from skills (simplified version of optimizer logic)
  const KNOWN_CLIS = new Set([
    "nmap", "scapy", "wireshark", "tcpdump", "metasploit", "hydra",
    "nikto", "sqlmap", "gobuster", "ffuf", "hashcat", "john",
    "volatility", "autopsy", "binwalk", "ghidra", "radare2", "gdb",
    "apktool", "jadx", "androguard", "frida", "objection",
    "docker", "kubectl", "helm", "terraform", "ansible",
    "aws", "gcloud", "az", "curl", "wget", "jq",
    "git", "gh", "npm", "npx", "bun", "pnpm",
    "python", "pip", "uv", "node", "deno",
    "go", "cargo", "gcc", "make",
    "openssl", "ssh", "splunk", "elastic",
    "yara", "snort", "suricata", "zeek",
    "aircrack-ng", "kismet", "shodan", "censys", "amass", "subfinder",
    "nuclei", "zap", "testssl", "dd", "dcfldd", "foremost",
    "strings", "strace", "ltrace", "nmap", "httpx",
  ]);

  const cliNeeded = new Map<string, string[]>(); // cli → skills that need it

  for (const id of skillIds) {
    const slug = id.split("/").pop() ?? id;
    // Try to read SKILL.md
    let content = "";
    const paths = [
      join(HOME_SKILLS_PATH, slug, "SKILL.md"),
      ...(() => { try { return readdirSync(SKILLS_ROOT_PATH).map(cat => join(SKILLS_ROOT_PATH, cat, slug, "SKILL.md")); } catch { return []; } })(),
    ];
    for (const p of paths) { try { content = readFileSync(p, "utf8"); break; } catch {} }
    if (!content) continue;

    // Extract from allowed-tools and Prerequisites
    const lower = content.toLowerCase();
    for (const cli of KNOWN_CLIS) {
      if (new RegExp(`\\b${cli}\\b`).test(lower)) {
        const list = cliNeeded.get(cli) ?? [];
        list.push(slug);
        cliNeeded.set(cli, list);
      }
    }
  }

  if (cliNeeded.size === 0) {
    process.stdout.write(`✅ Profile "${profileName}" has no CLI dependencies.\n`);
    return 0;
  }

  // Check each CLI
  const results: { cli: string; installed: boolean; skills: number; hint?: string }[] = [];

  for (const [cli, skills] of [...cliNeeded.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const check = spawnSync("which", [cli], { encoding: "utf8", timeout: 2000 });
    const installed = check.status === 0;
    results.push({ cli, installed, skills: skills.length, hint: installed ? undefined : INSTALL_HINTS[cli] });
  }

  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return results.some(r => !r.installed) ? 1 : 0;
  }

  const installed = results.filter(r => r.installed);
  const missing = results.filter(r => !r.installed);

  process.stdout.write(`CLI Doctor for "${profileName}" (${results.length} tools required):\n\n`);

  if (missing.length) {
    process.stdout.write(`  ❌ Missing (${missing.length}):\n`);
    for (const r of missing) {
      process.stdout.write(`     ❌ ${r.cli.padEnd(20)} needed by ${r.skills} skill(s)\n`);
      if (r.hint) process.stdout.write(`        install: ${r.hint}\n`);
    }
    process.stdout.write("\n");
  }

  if (installed.length) {
    process.stdout.write(`  ✅ Installed (${installed.length}):\n`);
    for (const r of installed) {
      process.stdout.write(`     ✅ ${r.cli.padEnd(20)} needed by ${r.skills} skill(s)\n`);
    }
  }

  process.stdout.write(`\n  ${installed.length}/${results.length} CLIs available.\n`);
  return missing.length > 0 ? 1 : 0;
}
