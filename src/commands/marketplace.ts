/**
 * `cue marketplace` — search and install MCPs (via Smithery) and skills (via npx skills find).
 *
 * Subcommands:
 *   search <query>           — search both MCPs and skills
 *   search-mcps <query>      — search MCPs only (Smithery)
 *   search-skills <query>    — search skills only (npx skills find)
 *   install-mcp <id>         — install MCP via Smithery + add to active profile
 *   install-skill <repo>     — install skill via npx skills add + add to active profile
 *   list-mcps                — list connected MCPs (Smithery)
 *   list-tools [connection]  — list tools from connected MCPs
 */

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

import { resolveActiveProfile } from "../lib/cwd-resolver";
import { fetchCompanionFiles, detectSkillPath } from "../lib/companion-fetch";
import { gateFreshSkill, resolveSkillDir } from "./security";
import { unavailableNote, formatVerdict } from "../lib/skillspector";
import type { FileChange } from "../lib/pr-poster";
import { repoRoot } from "../lib/repo-root";

const PROFILES_DIR = process.env.CUE_PROFILES_DIR ?? join(repoRoot(), "profiles");
const REGISTRY_PATH = join(repoRoot(), "docs", "registry", "index.json");
const REGISTRY_URL = "https://opencue.github.io/cue/registry/index.json";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface RegistrySkill {
  id: string; name: string; description: string;
  repo: string; path: string; tags: string[];
  requires: string[]; profile: string;
}
interface RegistryMcp {
  id: string; name: string; description: string;
  repo: string; install: string; tags: string[];
}
interface Registry {
  version: number; skills: RegistrySkill[]; mcps: RegistryMcp[];
}

function loadRegistry(): Registry | null {
  // Try local first, then fetch remote
  if (existsSync(REGISTRY_PATH)) {
    try { return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")); } catch {}
  }
  // Try fetching remote (sync via spawnSync curl)
  const res = spawnSync("curl", ["-sfL", "--max-time", "5", REGISTRY_URL], { encoding: "utf8" });
  if (res.status === 0 && res.stdout) {
    try { return JSON.parse(res.stdout); } catch {}
  }
  return null;
}

function searchRegistry(query: string, registry: Registry): { skills: RegistrySkill[]; mcps: RegistryMcp[] } {
  const q = query.toLowerCase();
  const skills = registry.skills.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.tags.some(t => t.includes(q)) ||
    s.id.includes(q)
  );
  const mcps = registry.mcps.filter(m =>
    m.name.toLowerCase().includes(q) ||
    m.description.toLowerCase().includes(q) ||
    m.tags.some(t => t.includes(q)) ||
    m.id.includes(q)
  );
  return { skills, mcps };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasSmithery(): boolean {
  const res = spawnSync("smithery", ["--help"], { encoding: "utf8", timeout: 5000 });
  return res.status === 0;
}

function smithery(args: string[], json = false): { ok: boolean; stdout: string; stderr: string } {
  const fullArgs = json ? ["--json", ...args] : args;
  const res = spawnSync("smithery", fullArgs, { encoding: "utf8", timeout: 30000 });
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function npxSkills(args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync("npx", ["skills", ...args], { encoding: "utf8", timeout: 30000 });
  return { ok: res.status === 0, stdout: res.stdout ?? "" };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdSearchMcps(query: string, json: boolean): Promise<number> {
  if (!hasSmithery()) {
    process.stderr.write("Smithery CLI not installed. Run: npm install -g @smithery/cli\n");
    return 1;
  }

  const res = smithery(["mcp", "search", query], json);
  if (!res.ok) {
    process.stderr.write(`Smithery search failed: ${res.stderr}\n`);
    return 1;
  }
  process.stdout.write(res.stdout);
  if (!json && res.stdout.trim()) {
    process.stdout.write("\nInstall with: cue marketplace install-mcp <id>\n");
  }
  return 0;
}

async function cmdSearchSkills(query: string, json: boolean): Promise<number> {
  // Try smithery skill search first
  if (hasSmithery()) {
    const res = smithery(["skill", "search", query], json);
    if (res.ok && res.stdout.trim()) {
      process.stdout.write(res.stdout);
      if (!json) process.stdout.write("\nInstall with: cue marketplace install-skill <repo>\n");
      return 0;
    }
  }

  // Fallback to npx skills find
  const res = npxSkills(["find", query]);
  if (res.ok && res.stdout.trim()) {
    process.stdout.write(res.stdout);
    if (!json) process.stdout.write("\nInstall with: cue marketplace install-skill <repo>\n");
  } else {
    process.stdout.write(`No skills found for "${query}"\n`);
  }
  return 0;
}

async function cmdSearch(query: string, json: boolean): Promise<number> {
  if (!query) {
    process.stderr.write("Usage: cue marketplace search <query>\n");
    return 1;
  }

  // Search built-in registry first
  const registry = loadRegistry();
  if (registry) {
    const results = searchRegistry(query, registry);
    if (json) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
      return 0;
    }
    if (results.skills.length > 0) {
      process.stdout.write("── Skills ──\n\n");
      for (const s of results.skills) {
        process.stdout.write(`  ${s.name}  (${s.repo})\n`);
        process.stdout.write(`    ${s.description}\n`);
        process.stdout.write(`    tags: ${s.tags.join(", ")}${s.requires.length ? `  requires: ${s.requires.join(", ")}` : ""}\n\n`);
      }
    }
    if (results.mcps.length > 0) {
      process.stdout.write("── MCPs ──\n\n");
      for (const m of results.mcps) {
        process.stdout.write(`  ${m.name}  (${m.install})\n`);
        process.stdout.write(`    ${m.description}\n`);
        process.stdout.write(`    tags: ${m.tags.join(", ")}\n\n`);
      }
    }
    if (results.skills.length === 0 && results.mcps.length === 0) {
      process.stdout.write(`No results for "${query}" in the registry.\n`);
    } else {
      process.stdout.write(`Install with: cue marketplace install-skill <repo>\n`);
    }
    return 0;
  }

  // Fallback to Smithery + npx
  if (!json) process.stdout.write(`🔍 Searching MCPs and skills for "${query}"...\n\n`);
  if (!json) process.stdout.write("── MCPs (Smithery) ──\n\n");
  await cmdSearchMcps(query, json);
  if (!json) process.stdout.write("\n── Skills ──\n\n");
  await cmdSearchSkills(query, json);
  return 0;
}

async function cmdInstallMcp(id: string): Promise<number> {
  if (!hasSmithery()) {
    process.stderr.write("Smithery CLI not installed. Run: npm install -g @smithery/cli\n");
    return 1;
  }

  process.stdout.write(`Installing MCP "${id}" via Smithery...\n`);

  // Install to Claude Code via Smithery
  const res = smithery(["mcp", "add", id, "--client", "claude"]);
  if (!res.ok) {
    // Try without --client flag (remote connection)
    const res2 = smithery(["mcp", "add", id]);
    if (!res2.ok) {
      process.stderr.write(`Failed to install: ${res.stderr || res2.stderr}\n`);
      return 1;
    }
    process.stdout.write(res2.stdout);
  } else {
    process.stdout.write(res.stdout);
  }

  // Add to active profile
  let profileName: string | null = null;
  try { profileName = await resolveActiveProfile(); } catch { /* no profile */ }

  if (profileName) {
    const { readFile, writeFile } = await import("node:fs/promises");
    const yamlPath = join(PROFILES_DIR, profileName, "profile.yaml");
    try {
      let content = await readFile(yamlPath, "utf8");
      if (!content.includes(`- ${id}`)) {
        if (content.includes("mcps:")) {
          const lines = content.split("\n");
          const mcpsIdx = lines.findIndex(l => l.match(/^mcps:/));
          let insertIdx = mcpsIdx + 1;
          while (insertIdx < lines.length && lines[insertIdx]?.match(/^\s+-\s/)) insertIdx++;
          lines.splice(insertIdx, 0, `  - ${id}`);
          content = lines.join("\n");
        } else {
          content = content.trimEnd() + `\nmcps:\n  - ${id}\n`;
        }
        await writeFile(yamlPath, content);
        process.stdout.write(`✅ Added "${id}" to profile "${profileName}"\n`);
      }
    } catch { /* skip profile update */ }
  }

  process.stdout.write(`\n⚠️  Restart Claude Code to connect the new MCP.\n`);
  return 0;
}

/**
 * Post-install security gate for `install-skill`. Unlike `cue skills add` there
 * is no profile registration to withhold here — the files are already on disk —
 * so a block reports the findings, leaves the files for review, and exits
 * non-zero rather than deleting anything.
 */
function gateInstalledSkill(skillName: string, allowUnsafe: boolean): number {
  process.stdout.write(`🔍 Scanning "${skillName}" with NVIDIA SkillSpector…\n`);
  const gate = gateFreshSkill(skillName, { allowUnsafe });
  const note = unavailableNote(gate.skillspector);
  if (note) process.stderr.write(`   ${note}\n`);

  if (!gate.ok) {
    process.stderr.write(`🔴 BLOCKED "${skillName}": ${gate.critical.length} critical security finding(s)\n`);
    for (const c of gate.critical) {
      process.stderr.write(`   [${c.code}] ${c.message}${c.line ? ` (line ${c.line})` : ""}\n`);
    }
    const dir = resolveSkillDir(skillName);
    if (dir) process.stderr.write(`   Files left for review at ${dir} — remove them or re-run with --allow-unsafe.\n`);
    return 1;
  }
  if (!gate.scanned) {
    process.stderr.write(`⚠️  ${skillName}: no SKILL.md found to scan — review manually.\n`);
  } else if (gate.skillspector.recommendation === "CAUTION") {
    process.stderr.write(`🟡 ${formatVerdict(gate.skillspector)} — installed, review it.\n`);
  } else if (gate.skillspector.recommendation === "SAFE") {
    process.stdout.write(`🟢 SkillSpector SAFE\n`);
  }
  return 0;
}

async function cmdInstallSkill(repo: string, allowUnsafe = false): Promise<number> {
  const installedName = repo.split("/").pop() ?? repo;

  // Try smithery first
  if (hasSmithery()) {
    process.stdout.write(`Installing skill "${repo}" via Smithery...\n`);
    const res = smithery(["skill", "add", repo, "--agent", "claude-code"]);
    if (res.ok) {
      process.stdout.write(res.stdout);
      const gated = gateInstalledSkill(installedName, allowUnsafe);
      if (gated !== 0) return gated;
      process.stdout.write(`✅ Skill installed.\n`);
      return 0;
    }
  }

  // Fallback to npx skills add
  process.stdout.write(`Installing skill "${repo}" via npx skills...\n`);
  const res = spawnSync("npx", ["skills", "add", repo, "-a", "claude-code", "-y"], {
    stdio: "inherit",
    encoding: "utf8",
  });

  if (res.status !== 0) {
    process.stderr.write(`Failed to install skill.\n`);
    return 1;
  }

  // Fetch companion files (scripts/, forms.md, reference.md, etc.)
  const { homedir } = await import("node:os");
  const skillName = installedName;
  const skillsDir = join(homedir(), ".claude", "skills");
  const localDir = join(skillsDir, skillName);
  if (existsSync(localDir)) {
    const skillPath = detectSkillPath(repo, skillName);
    if (skillPath) {
      const { fetched } = fetchCompanionFiles(repo, skillPath, localDir, { quiet: true });
      if (fetched.length > 0) {
        process.stdout.write(`📂 Fetched companion files: ${fetched.join(", ")}\n`);
      }
    }
  }

  // Scan after companion files land so scripts/ is covered by the same pass.
  const gated = gateInstalledSkill(skillName, allowUnsafe);
  if (gated !== 0) return gated;

  process.stdout.write(`✅ Skill installed.\n`);
  return 0;
}

async function cmdListMcps(json: boolean): Promise<number> {
  if (!hasSmithery()) {
    process.stderr.write("Smithery CLI not installed. Run: npm install -g @smithery/cli\n");
    return 1;
  }
  const res = smithery(["mcp", "list"], json);
  process.stdout.write(res.stdout);
  return res.ok ? 0 : 1;
}

async function cmdListTools(connection: string, json: boolean): Promise<number> {
  if (!hasSmithery()) {
    process.stderr.write("Smithery CLI not installed. Run: npm install -g @smithery/cli\n");
    return 1;
  }
  const args = connection ? ["tool", "list", connection] : ["tool", "list"];
  const res = smithery(args, json);
  process.stdout.write(res.stdout);
  return res.ok ? 0 : 1;
}

async function cmdFindTools(query: string, json: boolean): Promise<number> {
  if (!hasSmithery()) {
    process.stderr.write("Smithery CLI not installed. Run: npm install -g @smithery/cli\n");
    return 1;
  }
  const res = smithery(["tool", "find", query], json);
  process.stdout.write(res.stdout);
  return res.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// discover — uses GitHub Code Search to find repos containing SKILL.md files.
// Previously used loose text search ("claude skill agent"), which surfaced
// awesome-lists and meta-repos that don't actually contain SKILL.md.
// ---------------------------------------------------------------------------

interface SkillRepo {
  repo: string;                 // owner/name
  paths: string[];              // SKILL.md paths inside the repo (from code search)
  stars: number;                // populated by enrichStars
  description: string;          // populated by enrichStars
  // populated when --cli-aware fetches body content
  meta?: { description: string; domain: string; tags: string[]; categories: string[]; name: string };
}

// Words that aren't useful as profile-match keywords.
const STOPWORDS = new Set([
  "the","a","an","and","or","but","for","with","of","to","in","on","by","from",
  "is","are","was","were","be","been","being","this","that","these","those",
  "it","its","as","at","if","not","no","do","does","cli","tool","tools",
  "skill","skills","claude","anthropic","code","using","run","runs","make",
  "your","you","get","one","two","three","new","use","build","build-",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Categories inferred from SKILL.md paths inside the repo. The directory
 * name immediately containing the SKILL.md file is usually a category tag
 * (e.g. `skills/marketing/seo-audit/SKILL.md` → "marketing", "seo-audit").
 */
function categoriesFromPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === "skill.md" || lower === "skills" || lower === "src" || lower === "docs") continue;
      if (!STOPWORDS.has(lower)) seen.add(lower);
    }
  }
  return [...seen];
}

/**
 * Build a keyword index for each cue profile. The keywords come from the
 * profile name, its `inherits` ancestor names, and the first path-segment
 * of every local skill (e.g. "security", "marketing", "medusa").
 */
async function buildProfileKeywordIndex(): Promise<Map<string, Set<string>>> {
  const { loadProfile, listProfiles } = await import("../lib/profile-loader");
  const out = new Map<string, Set<string>>();
  for (const name of await listProfiles()) {
    try {
      const p = await loadProfile(name);
      const kw = new Set<string>();
      kw.add(name.toLowerCase());
      for (const t of tokenize(p.description ?? "")) kw.add(t);
      for (const s of p.skills.local) {
        const seg = s.id.split("/")[0];
        if (seg && seg !== "*") kw.add(seg.toLowerCase());
      }
      for (const m of p.mcps) kw.add(m.id.toLowerCase());
      out.set(name, kw);
    } catch {}
  }
  return out;
}

interface ProfileFit { profile: string; score: number }

/** Score a repo's keyword set against each profile; return top matches. */
function findBestProfiles(repoKeywords: Set<string>, index: Map<string, Set<string>>, top = 2): ProfileFit[] {
  const fits: ProfileFit[] = [];
  for (const [profile, kw] of index) {
    let score = 0;
    for (const w of repoKeywords) if (kw.has(w)) score++;
    if (score > 0) fits.push({ profile, score });
  }
  fits.sort((a, b) => b.score - a.score);
  return fits.slice(0, top);
}

/** Async spawn → Promise<{ stdout, status }>. Lets us run gh calls in parallel. */
function ghAsync(args: string[], timeoutMs = 8000): Promise<{ stdout: string; status: number }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let resolved = false;
    const done = (status: number) => { if (!resolved) { resolved = true; resolve({ stdout, status }); } };
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.on("close", (code) => done(code ?? 1));
    child.on("error", () => done(1));
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done(124); }, timeoutMs);
  });
}

/** Run async tasks with a concurrency cap. */
async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

/**
 * Find repos that demonstrably contain at least one SKILL.md file. Returns
 * a map keyed by `owner/name` with the file paths discovered per repo.
 * Higher `searchLimit` = more raw file matches = more unique repos found.
 */
async function discoverSkillReposViaCodeSearch(searchLimit: number): Promise<Map<string, SkillRepo>> {
  const queries = [
    ["--filename", "SKILL.md"],
    ["claude", "--filename", "SKILL.md"],
    ["anthropic", "--filename", "SKILL.md"],
  ];

  const byRepo = new Map<string, SkillRepo>();
  for (const extra of queries) {
    const res = await ghAsync(
      ["search", "code", ...extra, "--limit", String(searchLimit), "--json", "path,repository"],
      30000,
    );
    if (res.status !== 0 || !res.stdout) continue;
    try {
      const matches = JSON.parse(res.stdout) as Array<{ path: string; repository: { nameWithOwner: string } }>;
      for (const m of matches) {
        const repo = m.repository?.nameWithOwner;
        if (!repo) continue;
        const entry = byRepo.get(repo) ?? { repo, paths: [], stars: 0, description: "" };
        if (m.path.endsWith("SKILL.md") && !entry.paths.includes(m.path)) entry.paths.push(m.path);
        byRepo.set(repo, entry);
      }
    } catch { /* skip */ }
  }
  return byRepo;
}

/** Fill in stars + description via repo metadata API. Concurrent. */
async function enrichStars(repos: SkillRepo[], concurrency = 6): Promise<void> {
  await pMap(repos, concurrency, async (r) => {
    const res = await ghAsync(
      ["api", `repos/${r.repo}`, "--jq", "{stars: .stargazers_count, description}"],
      5000,
    );
    if (res.status === 0) {
      try {
        const meta = JSON.parse(res.stdout) as { stars?: number; description?: string };
        r.stars = meta.stars ?? 0;
        r.description = meta.description ?? "";
      } catch {}
    }
  });
}

/** Fetch and concatenate up to N SKILL.md bodies from a repo (paths already known). */
async function fetchSkillContents(repo: string, paths: string[], cap = 8): Promise<string> {
  const slice = paths.slice(0, cap);
  const results = await pMap(slice, 4, async (path) => {
    const res = await ghAsync(
      ["api", `repos/${repo}/contents/${path}`, "-H", "Accept: application/vnd.github.raw"],
      5000,
    );
    return res.status === 0 ? res.stdout : "";
  });
  return results.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// open-pr — actually post a meaningful PR to a target repo. Safe-by-default:
// dry-run unless --post, interactive confirmation unless --yes, and every
// preflight check (throttle, opt-out, daily cap) runs *before* any GitHub
// mutation. Caps at 1 repo per invocation so a typo can't mass-spam.
// ---------------------------------------------------------------------------

async function cmdOpenPr(repo: string, json: boolean, post: boolean, yes: boolean, optInOnly: boolean): Promise<number> {
  if (!repo) {
    process.stderr.write("Usage: cue marketplace open-pr <owner/name> [--post] [--yes] [--opt-in-only]\n");
    return 1;
  }

  const { lint, applyFixes, buildPrBody } = await import("../lib/skill-linter");
  const throttle = await import("../lib/pr-throttle");
  const poster = await import("../lib/pr-poster");

  // Preflight #0: gh CLI authenticated? Bail loudly before doing anything else.
  if (post) {
    const auth = await poster.defaultRunner.run("gh", ["auth", "status"], { timeoutMs: 5000 });
    if (auth.status !== 0) {
      process.stderr.write(`\n${red("✗ gh not authenticated")}\n`);
      process.stderr.write(`  Run ${bold("gh auth login")} first, then retry.\n\n`);
      return 1;
    }
  }

  let db = throttle.loadDb();

  // Preflight #1: per-repo cooldown / opt-out cache
  const throttleReason = throttle.isThrottled(db, repo);
  if (throttleReason) {
    if (json) process.stdout.write(JSON.stringify({ skipped: true, reason: throttleReason }) + "\n");
    else process.stderr.write(`\n${red("skipped:")} ${repo} — ${throttleReason}\n`);
    return 0;
  }

  // Preflight #2: daily cap
  const cap = throttle.canPostMore(db);
  if (!cap.ok) {
    process.stderr.write(`\n${red("daily cap reached")}: ${cap.cap - cap.remaining}/${cap.cap} PRs in last 24h\n`);
    return 1;
  }

  // Preflight #3: opt-out / opt-in marker check (network)
  // - Default: post unless README has the opt-out marker.
  // - --opt-in-only: only post if README has the opt-in marker. The opt-out
  //   marker still wins if present (a repo with both is treated as opted-out).
  process.stderr.write(`🔎 Checking ${repo} README for cue markers (mode=${optInOnly ? "opt-in-only" : "default"})...\n`);
  const optedOut = await poster.checkOptOutMarker(poster.defaultRunner, repo, throttle.OPT_OUT_MARKER);
  if (optedOut === true) {
    db = throttle.recordOptOut(db, repo);
    throttle.saveDb(db);
    if (json) process.stdout.write(JSON.stringify({ skipped: true, reason: "opt-out marker found" }) + "\n");
    else process.stderr.write(`  ${yellow("opted out")}: README has ${throttle.OPT_OUT_MARKER} — recorded permanently.\n`);
    return 0;
  }
  if (optInOnly) {
    const optedIn = await poster.checkOptOutMarker(poster.defaultRunner, repo, throttle.OPT_IN_MARKER);
    if (optedIn !== true) {
      db = throttle.recordSkipped(db, repo, `--opt-in-only mode: README missing ${throttle.OPT_IN_MARKER}`);
      throttle.saveDb(db);
      if (json) process.stdout.write(JSON.stringify({ skipped: true, reason: "no opt-in marker" }) + "\n");
      else process.stderr.write(`  ${dim("skipped")}: --opt-in-only is set and ${repo} hasn't opted in.\n`);
      return 0;
    }
  }
  if (optedOut === null) {
    process.stderr.write(`  ${dim("(could not fetch README — continuing)")}\n`);
  }

  // Fetch SKILL.md files
  process.stderr.write(`🔎 Fetching SKILL.md files from ${repo}...\n`);
  const tree = await ghAsync(
    ["api", `repos/${repo}/git/trees/HEAD?recursive=1`, "--jq", '.tree[] | select(.path | endswith("SKILL.md")) | .path'],
    10000,
  );
  if (tree.status !== 0) {
    process.stderr.write(`  could not list tree — is repo public + gh authed?\n`);
    return 1;
  }
  const paths = tree.stdout.split("\n").filter(Boolean).slice(0, 8);
  if (paths.length === 0) {
    process.stderr.write(`  no SKILL.md files found\n`);
    return 1;
  }

  // Lint + collect changes
  const changes: FileChange[] = [];
  const allFixedRules = new Set<string>();
  const allLeftover: Array<{ rule: string; severity: string; message: string }> = [];

  for (const path of paths) {
    const r = await ghAsync(["api", `repos/${repo}/contents/${path}`, "-H", "Accept: application/vnd.github.raw"], 5000);
    if (r.status !== 0) continue;
    const before = r.stdout;
    const { fixed, applied } = applyFixes(before);
    if (before !== fixed) {
      changes.push({ path, before, after: fixed });
      const beforeDiags = lint(before).diagnostics;
      for (const rule of applied) {
        if (beforeDiags.some((d) => d.rule === rule)) allFixedRules.add(rule);
      }
    }
    for (const d of lint(fixed).diagnostics) allLeftover.push({ rule: d.rule, severity: d.severity, message: d.message });
  }

  if (changes.length === 0) {
    db = throttle.recordSkipped(db, repo, "no auto-fixable issues found");
    throttle.saveDb(db);
    if (json) process.stdout.write(JSON.stringify({ skipped: true, reason: "no auto-fixable issues" }) + "\n");
    else process.stderr.write(`\n${dim("nothing to fix")} — every SKILL.md is already clean (or only has non-fixable flags). Recorded as skipped so we won't recheck soon.\n`);
    return 0;
  }

  // Build PR body using the first changed file as exemplar
  const primary = changes[0]!;
  const fixedDiags = lint(primary.before).diagnostics.filter((d) => [...allFixedRules].includes(d.rule));
  const leftoverDiags = lint(primary.after).diagnostics;
  const { title, body } = buildPrBody({
    repo,
    files: changes.map((c) => ({ path: c.path, before: c.before, after: c.after, fixedRules: [...allFixedRules] })),
    diagnosticsFixed: fixedDiags,
    diagnosticsLeft: leftoverDiags,
  });

  if (json && !post) {
    process.stdout.write(JSON.stringify({ dryRun: true, repo, title, body, files: changes.map((c) => c.path), fixedRules: [...allFixedRules] }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`\n${bold("Repo:")} ${repo}\n`);
  process.stdout.write(`${bold("Files cue would change:")} ${changes.length}/${paths.length}\n`);
  for (const c of changes) process.stdout.write(`  ${green("✓")} ${c.path}\n`);
  process.stdout.write(`${bold("Rules auto-fixed:")} ${[...allFixedRules].join(", ")}\n\n`);
  process.stdout.write(`${bold("PR title:")} ${title}\n`);
  process.stdout.write(`${bold("PR body preview (first 60 lines):")}\n${dim("─".repeat(72))}\n`);
  const bodyLines = body.split("\n").slice(0, 60);
  process.stdout.write(bodyLines.join("\n") + (body.split("\n").length > 60 ? "\n... [body truncated]" : "") + "\n");
  process.stdout.write(`${dim("─".repeat(72))}\n\n`);

  if (!post) {
    process.stdout.write(`${yellow("[dry-run]")} no PR posted. Re-run with ${bold("--post --yes")} to actually open it.\n`);
    process.stdout.write(`${dim(`Daily cap: ${cap.remaining}/${cap.cap} PRs remaining today.`)}\n\n`);
    return 0;
  }

  // Interactive confirm unless --yes
  if (!yes) {
    process.stdout.write(`Post this PR to ${bold(repo)}? [y/N] `);
    const answer = await readLine();
    if (!/^y(es)?$/i.test(answer.trim())) {
      process.stdout.write(`${dim("aborted (not recorded).")}\n`);
      return 0;
    }
  }

  process.stderr.write(`\n${bold("→")} Forking, branching, pushing, and opening PR...\n\n`);
  const result = await poster.postPrToRepo({
    upstream: repo,
    changes,
    prTitle: title,
    prBody: body,
  });

  if (!result.ok) {
    process.stderr.write(`${red("✗ failed at step:")} ${result.step} — ${result.error}\n`);
    if (result.fork) process.stderr.write(`  ${dim("(fork at " + result.fork + " left in place for inspection)")}\n`);
    return 1;
  }

  db = throttle.recordOpened(db, {
    repo,
    rulesFixed: [...allFixedRules],
    prNumber: result.prNumber,
    prUrl: result.prUrl,
    fork: result.fork,
    branch: result.branch,
  });
  throttle.saveDb(db);

  process.stdout.write(`\n${green("✓ PR opened:")} ${result.prUrl}\n`);
  process.stdout.write(`  fork: ${result.fork}\n  branch: ${result.branch}\n  files: ${result.filesChanged.join(", ")}\n`);
  process.stdout.write(`\n${dim(`Daily count: ${throttle.todayCount(db)}/${throttle.canPostMore(db).cap}.`)}\n\n`);
  return 0;
}

/** Minimal stdin line reader for the confirm prompt. */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.split("\n")[0]!);
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// cleanup-forks — poll PR state for everything we've ever opened; delete the
// fork once the PR is merged or closed.
// ---------------------------------------------------------------------------

async function cmdCleanupForks(json: boolean, dryRun: boolean): Promise<number> {
  const throttle = await import("../lib/pr-throttle");
  const poster = await import("../lib/pr-poster");

  let db = throttle.loadDb();
  // Candidates: entries we opened (have a prNumber) that still claim "open" state
  // OR were already marked merged/closed but still have a fork to delete.
  const candidates = db.history.filter((e) => e.fork && !e.cleanedAt && e.prNumber);

  if (candidates.length === 0) {
    if (json) process.stdout.write("[]\n");
    else process.stdout.write("  no forks to consider for cleanup.\n");
    return 0;
  }

  process.stderr.write(`🧹 Checking PR state for ${candidates.length} fork(s)...\n`);

  const results: Array<{ repo: string; fork: string; prNumber: number; state: string; action: string; error?: string }> = [];
  for (const e of candidates) {
    const state = await poster.fetchPrState(poster.defaultRunner, e.repo, e.prNumber!);
    let action = "skip";
    let error: string | undefined;
    if (state === "merged" || state === "closed") {
      if (dryRun) {
        action = "would-delete";
      } else {
        const del = await poster.deleteFork(poster.defaultRunner, e.fork!);
        if ("error" in del) {
          action = "delete-failed";
          error = del.error;
        } else {
          action = "deleted";
          db = throttle.updateEntryState(db, { repo: e.repo, prNumber: e.prNumber }, state, {
            fork: undefined,
            cleanedAt: new Date().toISOString(),
          });
        }
      }
    } else if (state === "open") {
      action = "still-open";
    } else {
      action = "unknown-state";
    }
    results.push({ repo: e.repo, fork: e.fork!, prNumber: e.prNumber!, state, action, error });
  }

  if (!dryRun) throttle.saveDb(db);

  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return 0;
  }

  const counts = { deleted: 0, wouldDelete: 0, stillOpen: 0, failed: 0, other: 0 };
  for (const r of results) {
    const col = r.action === "deleted" ? green : r.action === "delete-failed" ? red : r.action === "still-open" ? dim : yellow;
    process.stdout.write(`  ${col(r.action.padEnd(15))} ${r.repo.padEnd(40)} PR #${r.prNumber}  ${dim(`(${r.state})`)}\n`);
    if (r.error) process.stdout.write(`    ${red("error:")} ${r.error}\n`);
    if (r.action === "deleted") counts.deleted++;
    else if (r.action === "would-delete") counts.wouldDelete++;
    else if (r.action === "still-open") counts.stillOpen++;
    else if (r.action === "delete-failed") counts.failed++;
    else counts.other++;
  }
  process.stdout.write(`\n  ${bold("Summary:")} ${counts.deleted} deleted, ${counts.wouldDelete} would-delete, ${counts.stillOpen} still-open, ${counts.failed} failed.\n`);
  if (dryRun) process.stdout.write(`  ${dim("(--dry-run — no forks were actually deleted; rerun without --dry-run to clean up)")}\n`);
  process.stdout.write("\n");
  return 0;
}

/**
 * Preview the PR cue would open against `repo`. Fetches every SKILL.md from
 * the repo (tree-based, like discover does), lints + auto-fixes locally, and
 * emits the PR title + body without touching anything on GitHub.
 *
 * No fork. No branch. No push. No PR. Safe to run on strangers' repos.
 */
async function cmdPrPreview(repo: string, json: boolean): Promise<number> {
  const { lint, applyFixes, buildPrBody } = await import("../lib/skill-linter");

  process.stderr.write(`🔎 Fetching SKILL.md files from ${repo}...\n`);
  const tree = await ghAsync(
    ["api", `repos/${repo}/git/trees/HEAD?recursive=1`, "--jq", '.tree[] | select(.path | endswith("SKILL.md")) | .path'],
    10000,
  );
  if (tree.status !== 0) {
    process.stderr.write(`  Could not list ${repo} (is the repo public? is gh authed?)\n`);
    return 1;
  }
  const paths = tree.stdout.split("\n").filter(Boolean).slice(0, 8);
  if (paths.length === 0) {
    process.stderr.write(`  No SKILL.md files found in ${repo}.\n`);
    return 1;
  }
  process.stderr.write(`  Found ${paths.length} SKILL.md file(s). Linting + computing fixes locally...\n`);

  // Fetch + lint each file in parallel, collect diff + diagnostics
  interface FileReport {
    path: string;
    before: string;
    after: string;
    fixedRules: string[];
    leftover: ReturnType<typeof lint>["diagnostics"];
  }
  const reports: FileReport[] = await pMap(paths, 4, async (path): Promise<FileReport> => {
    const res = await ghAsync(
      ["api", `repos/${repo}/contents/${path}`, "-H", "Accept: application/vnd.github.raw"],
      5000,
    );
    const before = res.status === 0 ? res.stdout : "";
    const beforeDiags = lint(before).diagnostics;
    const { fixed, applied } = applyFixes(before);
    const afterDiags = lint(fixed).diagnostics;
    const fixedRules = [...new Set(applied)].filter((r) => beforeDiags.some((d) => d.rule === r));
    return { path, before, after: fixed, fixedRules, leftover: afterDiags };
  });

  // PR body: passes every file so the diff blocks come out per-file.
  const primary = reports.find((r) => r.fixedRules.length > 0) ?? reports[0]!;
  const allFixedRulesPrev = [...new Set(reports.flatMap((r) => r.fixedRules))];
  const { title, body } = buildPrBody({
    repo,
    files: reports.map((r) => ({ path: r.path, before: r.before, after: r.after, fixedRules: r.fixedRules })),
    diagnosticsFixed: lint(primary.before).diagnostics.filter((d) => allFixedRulesPrev.includes(d.rule)),
    diagnosticsLeft: primary.leftover,
  });

  if (json) {
    process.stdout.write(JSON.stringify({
      repo,
      paths,
      title,
      body,
      files: reports.map((r) => ({
        path: r.path,
        wouldChange: r.before !== r.after,
        fixedRules: r.fixedRules,
        leftover: r.leftover.map((d) => ({ rule: d.rule, severity: d.severity, message: d.message })),
      })),
    }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`\n${bold("Repo:")} ${repo}\n${bold("Files scanned:")} ${paths.length}\n\n`);

  // Per-file diff summary
  for (const r of reports) {
    const changed = r.before !== r.after;
    const marker = changed ? green("✓") : dim("·");
    process.stdout.write(`  ${marker} ${r.path}\n`);
    if (r.fixedRules.length > 0) {
      process.stdout.write(`     ${green(`would fix: ${r.fixedRules.join(", ")}`)}\n`);
    }
    for (const d of r.leftover.slice(0, 3)) {
      const sev = d.severity === "error" ? red(d.rule) : d.severity === "warning" ? yellow(d.rule) : dim(d.rule);
      process.stdout.write(`     ${dim("→")} ${sev} ${d.message.slice(0, 80)}${d.message.length > 80 ? "…" : ""}\n`);
    }
  }

  process.stdout.write(`\n${bold("PR title:")}\n  ${title}\n\n${bold("PR body preview:")}\n${"─".repeat(72)}\n${body}\n${"─".repeat(72)}\n`);
  process.stdout.write(`\n${yellow("[preview only]")} No fork, branch, push, or PR was created.\n`);
  process.stdout.write(`To actually post a PR you'd need: ${dim("gh repo fork " + repo + " --remote=false")}, then commit the after-text and ${dim("gh pr create")}.\n`);
  process.stdout.write(`That flow is deliberately not automated yet — auto-posting needs throttling + an opt-out registry.\n\n`);
  return 0;
}

// Small color helpers reused from earlier blocks (re-declared to keep
// cmdPrPreview self-contained at the top of the file).
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function cmdDiscover(
  profileFilter: string,
  json: boolean,
  cliAware: boolean,
  limit: number,
  includeEmpty: boolean,
): Promise<number> {
  void profileFilter; // currently unused; reserved for per-profile install hints

  process.stderr.write("🔍 Searching GitHub Code Search for repos containing SKILL.md...\n");

  // Cast a wide net via code search (per-query limit), then trim by sort + limit.
  const searchLimit = Math.max(100, limit * 4);
  const byRepo = await discoverSkillReposViaCodeSearch(searchLimit);
  if (byRepo.size === 0) {
    process.stderr.write("  No SKILL.md files found via code search. Is `gh` authed?\n");
    return 1;
  }

  // Filter to repos that have at least one direct SKILL.md path (drops noise
  // where code search matched a substring elsewhere).
  let candidates = [...byRepo.values()].filter((r) => includeEmpty || r.paths.length > 0);
  process.stderr.write(`  Found ${candidates.length} unique repos with SKILL.md files.\n`);

  // Sort first by # of SKILL.md files (lots = real skill collection), then truncate
  // before enriching stars so we don't fetch metadata for everything.
  candidates.sort((a, b) => b.paths.length - a.paths.length);
  candidates = candidates.slice(0, limit);

  process.stderr.write(`  Enriching star counts for top ${candidates.length}...\n`);
  await enrichStars(candidates);
  candidates.sort((a, b) => b.paths.length - a.paths.length || b.stars - a.stars);

  // Which ones do we already have wired into a profile?
  const { loadProfile, listProfiles } = await import("../lib/profile-loader");
  const allNpxRepos = new Set<string>();
  for (const name of await listProfiles()) {
    try {
      const p = await loadProfile(name);
      for (const n of p.skills.npx) allNpxRepos.add((n as any).source?.repo ?? n.repo ?? "");
    } catch {}
  }

  // Build profile keyword index for "best fit" matching (cheap, local).
  const profileIndex = await buildProfileKeywordIndex();
  const fitsByRepo = new Map<string, ProfileFit[]>();

  // --cli-aware: fetch each repo's SKILL.md content, parse CLIs + metadata.
  // Metadata (tags/domain/description) enriches the profile-match keyword set
  // and powers the "what it does" column.
  const cliInfo = new Map<string, { needed: string[]; missing: string[] }>();
  if (cliAware) {
    const { parseCLIsFromContent, parseMetadataFromContent } = await import("./optimizer");
    process.stderr.write(`  Fetching SKILL.md bodies from ${candidates.length} repos (concurrent)...\n`);
    let done = 0;
    await pMap(candidates, 5, async (r) => {
      const content = await fetchSkillContents(r.repo, r.paths);
      const needed = content ? parseCLIsFromContent(content) : [];
      const missing = needed.filter((cli) => spawnSync("which", [cli], { stdio: "ignore", timeout: 500 }).status !== 0);
      cliInfo.set(r.repo, { needed, missing });
      // Pull a description/tags/domain from the first parsed SKILL.md (best effort).
      const meta = content ? parseMetadataFromContent(content) : { description: "", domain: "", tags: [], category: "", name: "" };
      r.meta = {
        description: meta.description,
        domain: meta.domain,
        tags: meta.tags,
        categories: [...new Set([meta.domain, meta.category, ...meta.tags].filter(Boolean).map((s) => s.toLowerCase()))],
        name: meta.name,
      };
      done++;
      if (done % 5 === 0 || done === candidates.length) {
        process.stderr.write(`    [${done}/${candidates.length}] fetched\n`);
      }
    });
  }

  // Build the keyword set per repo: path-derived categories + (when present) metadata.
  for (const r of candidates) {
    const kw = new Set<string>(categoriesFromPaths(r.paths));
    // Also seed from the repo name itself ("openclaw-security-watchdog" → security, watchdog).
    for (const t of tokenize(r.repo.split("/").pop() ?? "")) kw.add(t);
    if (r.meta) {
      for (const t of r.meta.categories) kw.add(t);
      for (const t of tokenize(r.meta.description)) kw.add(t);
    }
    fitsByRepo.set(r.repo, findBestProfiles(kw, profileIndex, 2));
  }

  if (json) {
    const out = candidates.map((r) => ({
      repo: r.repo,
      stars: r.stars,
      description: r.description,
      skillCount: r.paths.length,
      paths: r.paths,
      installed: allNpxRepos.has(r.repo),
      bestFitProfiles: fitsByRepo.get(r.repo) ?? [],
      keywords: categoriesFromPaths(r.paths).slice(0, 6),
      meta: r.meta ?? null,
      ...(cliAware ? { cli: cliInfo.get(r.repo) ?? { needed: [], missing: [] } } : {}),
    }));
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`\n  ${candidates.length} repos with SKILL.md files (sorted by skill count, then stars)\n\n`);

  // Two-line-per-repo layout — the table got too wide once we added fit + keywords + CLI.
  // Line 1: status, skills, stars, repo, best-fit profiles
  // Line 2 (indented, dim): keywords (path-derived) and either CLI status or description
  for (const r of candidates) {
    const installed = allNpxRepos.has(r.repo) ? "\x1b[32madded\x1b[0m " : "      ";
    const skillCount = String(r.paths.length).padStart(3);
    const stars = String(r.stars).padStart(5);
    const name = r.repo.padEnd(42);
    const fits = fitsByRepo.get(r.repo) ?? [];
    const fitStr = fits.length > 0
      ? `\x1b[36m→ ${fits.map((f) => f.profile).join(", ")}\x1b[0m`
      : "\x1b[2m→ (no profile match)\x1b[0m";

    process.stdout.write(`  ${installed} ${skillCount} skills  ${stars} ★  ${name}  ${fitStr}\n`);

    // Second line: keywords + CLI status (or description in non-cli-aware mode).
    const keywords = [...new Set([...categoriesFromPaths(r.paths), ...(r.meta?.tags ?? [])])].slice(0, 5);
    const kwStr = keywords.length > 0 ? `\x1b[2mkeywords:\x1b[0m ${keywords.join(", ")}` : "";
    let info = "";
    if (cliAware) {
      const ci = cliInfo.get(r.repo) ?? { needed: [], missing: [] };
      if (ci.needed.length === 0) {
        info = ""; // no extra cli line; the metadata description below will show it
      } else if (ci.missing.length === 0) {
        info = `\x1b[32m✓ no new CLI installs\x1b[0m (${ci.needed.length})`;
      } else {
        info = `\x1b[33m⚠ ${ci.missing.length}/${ci.needed.length} CLIs missing\x1b[0m: ${ci.missing.slice(0, 4).join(", ")}${ci.missing.length > 4 ? "…" : ""}`;
      }
    }
    const desc = r.meta?.description || r.description || "";
    const descStr = desc ? `\x1b[2m"${desc.slice(0, 90)}${desc.length > 90 ? "…" : ""}"\x1b[0m` : "";

    if (kwStr || info || descStr) {
      const parts = [kwStr, info, descStr].filter(Boolean).join("  ·  ");
      process.stdout.write(`            ${parts}\n`);
    }
    process.stdout.write("\n");
  }

  process.stdout.write(`\n  Install: cue marketplace install-skill <repo>\n`);
  if (!cliAware) {
    process.stdout.write(`  ${"\x1b[2mAdd --cli-aware to flag repos whose CLIs you already have installed.\x1b[0m"}\n`);
  }
  process.stdout.write(`  ${"\x1b[2m--limit <n> (default 30) to fetch more results; --include-empty to keep edge cases.\x1b[0m"}\n\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Hosted marketplace: login / whoami / publish
//
// "Get an API token on cuecards.cc, then push your skills / profiles / mcps
// from your own machine." These talk to the hosted API (not Smithery), using
// the user's bearer token. Install commands are derived server-side, so a
// submission can never inject an arbitrary install string.
// ---------------------------------------------------------------------------

const PUBLISH_TYPES = ["profile", "workflow", "skill", "cli", "mcp", "plugin"] as const;
type PublishType = (typeof PUBLISH_TYPES)[number];

/** Pull the value of `--flag value` out of an arg list (returns null if absent). */
function flagValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : null;
}

async function apiFetch(
  url: string,
  token: string | null,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: any; error?: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  } catch (err) {
    return {
      status: 0,
      json: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** `cue marketplace login --token <t>` — save the token to ~/.config/cue. */
async function cmdLogin(args: string[]): Promise<number> {
  const { resolveApiUrl, saveCredentials, loadCredentials } = await import("../lib/cue-credentials");
  const token = flagValue(args, "--token") ?? process.env.CUE_API_TOKEN ?? null;
  if (!token) {
    process.stderr.write(
      "Usage: cue marketplace login --token <token>\n\n" +
      "Create a token in the cuecards.cc studio → API view, then paste it here.\n" +
      "(or set CUE_API_TOKEN in your environment.)\n",
    );
    return 1;
  }
  const apiUrl = resolveApiUrl(loadCredentials());

  // Verify the token works before persisting it.
  const me = await apiFetch(`${apiUrl}/api/v1/me`, token);
  if (me.status === 0) {
    process.stderr.write(`${red("✗")} cannot reach ${apiUrl}: ${me.error}\n`);
    return 1;
  }
  if (me.status !== 200 || !me.json?.ok) {
    process.stderr.write(`${red("✗")} token rejected by ${apiUrl} (HTTP ${me.status}). Not saved.\n`);
    return 1;
  }
  const path = saveCredentials({ apiUrl, token });
  process.stdout.write(`${green("✓")} logged in as ${bold(me.json.data.email)} — token saved to ${dim(path)}\n`);
  return 0;
}

/** `cue marketplace whoami` — print the authenticated account. */
async function cmdWhoami(args: string[]): Promise<number> {
  const { resolveApiUrl, resolveToken, loadCredentials } = await import("../lib/cue-credentials");
  const token = resolveToken(flagValue(args, "--token"));
  const apiUrl = resolveApiUrl(loadCredentials());
  if (!token) {
    process.stderr.write(`${yellow("not logged in")} — run ${bold("cue marketplace login --token <token>")}\n`);
    return 1;
  }
  const me = await apiFetch(`${apiUrl}/api/v1/me`, token);
  if (me.status === 0) {
    process.stderr.write(`${red("✗")} cannot reach ${apiUrl}: ${me.error}\n`);
    return 1;
  }
  if (me.status !== 200 || !me.json?.ok) {
    process.stderr.write(`${red("✗")} token invalid or expired (HTTP ${me.status}).\n`);
    return 1;
  }
  process.stdout.write(`${green("✓")} ${bold(me.json.data.email)} ${dim(`(${me.json.data.id})`)} @ ${apiUrl}\n`);
  return 0;
}

/** Best-effort description for a local profile (used when --desc is omitted). */
async function deriveProfileDescription(name: string): Promise<string> {
  try {
    const { loadProfile } = await import("../lib/profile-loader");
    const p = await loadProfile(name);
    return p.description ?? "";
  } catch { return ""; }
}

/**
 * `cue marketplace publish <type> <name>` — push one item to the marketplace.
 * Flags: --desc, --tags a,b,c, --source-url, --token, --api.
 */
async function cmdPublish(args: string[], json: boolean): Promise<number> {
  const { resolveApiUrl, resolveToken, loadCredentials } = await import("../lib/cue-credentials");

  // type + name are the first two non-flag args that aren't the value of a
  // preceding --flag.
  const flagsWithValues = new Set(["--desc", "--tags", "--source-url", "--token", "--api"]);
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) { if (flagsWithValues.has(a)) i++; continue; }
    pos.push(a);
  }

  const type = pos[0] as PublishType | undefined;
  const name = pos[1];
  if (!type || !PUBLISH_TYPES.includes(type) || !name) {
    process.stderr.write(
      "Usage: cue marketplace publish <type> <name> [--desc <text>] [--tags a,b,c] [--source-url <https://…>]\n\n" +
      `  <type>  one of: ${PUBLISH_TYPES.join(", ")}\n` +
      "  <name>  the profile / skill / mcp name to publish\n\n" +
      "Examples:\n" +
      "  cue marketplace publish profile ship-fast --source-url https://github.com/me/profiles/tree/main/ship-fast --tags build,review\n" +
      "  cue marketplace publish skill seo-audit --source-url https://github.com/me/skills\n",
    );
    return 1;
  }

  const sourceUrl = flagValue(args, "--source-url")?.trim() || undefined;
  if (type === "profile" && !sourceUrl) {
    process.stderr.write("Profiles need a public GitHub source: --source-url https://github.com/owner/repo/tree/ref/profile-directory\n");
    return 1;
  }

  const token = resolveToken(flagValue(args, "--token"));
  if (!token) {
    process.stderr.write(
      `${yellow("not logged in")} — run ${bold("cue marketplace login --token <token>")} first\n` +
      `(create the token in the cuecards.cc studio → API view, or set CUE_API_TOKEN).\n`,
    );
    return 1;
  }

  const apiUrl = (flagValue(args, "--api") ?? resolveApiUrl(loadCredentials())).replace(/\/+$/, "");
  let description = flagValue(args, "--desc") ?? "";
  if (!description && type === "profile") description = await deriveProfileDescription(name);
  const tags = (flagValue(args, "--tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);

  if (!json) process.stdout.write(`Publishing ${bold(type)} "${bold(name)}" to ${apiUrl}…\n`);

  const res = await apiFetch(`${apiUrl}/api/v1/community`, token, {
    method: "POST",
    body: { type, name, description, tags, sourceUrl },
  });

  if (res.status === 0) {
    const err = `cannot reach ${apiUrl}: ${res.error}`;
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: err }) + "\n");
    else process.stderr.write(`${red("✗ publish failed:")} ${err}\n`);
    return 1;
  }
  if (res.status !== 200 || !res.json?.ok) {
    const err = res.json?.error ?? `HTTP ${res.status}`;
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: err }) + "\n");
    else process.stderr.write(`${red("✗ publish failed:")} ${err}\n`);
    return 1;
  }

  if (json) { process.stdout.write(JSON.stringify(res.json.data, null, 2) + "\n"); return 0; }

  const item = res.json.data;
  process.stdout.write(`\n${green("✓ published")} as ${bold(item.handle + "/" + item.name)}\n`);
  process.stdout.write(`  install: ${dim(item.add)}\n`);
  process.stdout.write(`  it's now in the community marketplace — anyone running cue can find and install it.\n\n`);
  return 0;
}

export async function run(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(`cue marketplace — search and install MCPs + skills

Usage: cue marketplace <subcommand> [args]

Subcommands:
  search <query>         Search MCPs (Smithery) + skills
  search-mcps <query>    Search MCPs only
  search-skills <query>  Search skills only
  discover [profile]     Find GitHub repos with SKILL.md files via code search.
                         Flags: --limit N (default 30), --cli-aware (annotate
                         each with CLI requirements + missing-on-host),
                         --include-empty (keep candidates that lack direct
                         SKILL.md path matches), --pr-preview <repo> (show
                         the PR cue would post without touching GitHub)
  open-pr <repo>         Actually post a SKILL.md quality-fix PR. Safe by
                         default (dry-run); use --post --yes to execute.
                         Honors throttle DB, opt-out marker, and 25/day cap.
                         --opt-in-only: require <!-- cue: ok --> in README.
  cleanup-forks          Delete cue's forks for PRs that are merged/closed.
                         Use --dry-run to see what would be deleted.
  install-mcp <id>       Install MCP via Smithery
  install-skill <repo>   Install skill from GitHub. Scanned with NVIDIA
                         SkillSpector before it is accepted; a DO_NOT_INSTALL
                         verdict fails the command (--allow-unsafe overrides).
  list-mcps              List connected Smithery MCPs
  list-tools [conn]      List tools from connected MCPs
  find-tools <query>     Search tools by intent

Publish (push to the hosted marketplace at cuecards.cc):
  login --token <t>      Save your API token (create it in the studio → API view,
                         or set CUE_API_TOKEN). Verifies before saving.
  whoami                 Show the account your token authenticates as.
  publish <type> <name>  Push a profile / skill / mcp to the marketplace.
                         Flags: --desc <text>, --tags a,b,c, --source-url <url>,
                         --token <t>, --api <url>. Types: ${PUBLISH_TYPES.join(", ")}.

Examples:
  cue marketplace search "github"
  cue marketplace install-mcp exa
  cue marketplace search-skills "kubernetes"
  cue marketplace login --token cue_sk_…
  cue marketplace publish profile ship-fast --source-url https://github.com/me/profiles/tree/main/ship-fast --tags build,review
`);
    return 0;
  }

  const sub = args[0] ?? "search";
  const json = args.includes("--json");
  const rest = args.filter(a => a !== "--json");

  switch (sub) {
    case "search":
      return cmdSearch(rest.slice(1).join(" ") || "", json);
    case "search-mcps":
      return cmdSearchMcps(rest.slice(1).join(" ") || "", json);
    case "search-skills":
      return cmdSearchSkills(rest.slice(1).join(" ") || "", json);
    case "install-mcp":
      return cmdInstallMcp(rest[1] ?? "");
    case "install-skill": {
      // Take the first non-flag so `--allow-unsafe` can appear on either side.
      const repo = rest.slice(1).find((a) => !a.startsWith("-")) ?? "";
      return cmdInstallSkill(repo, args.includes("--allow-unsafe"));
    }
    case "list-mcps":
      return cmdListMcps(json);
    case "list-tools":
      return cmdListTools(rest[1] ?? "", json);
    case "find-tools":
      return cmdFindTools(rest.slice(1).join(" ") || "", json);
    case "login":
      return cmdLogin(rest.slice(1));
    case "whoami":
      return cmdWhoami(rest.slice(1));
    case "publish":
      return cmdPublish(rest.slice(1), json);
    case "discover": {
      const previewIdx = rest.indexOf("--pr-preview");
      if (previewIdx >= 0) {
        const repo = rest[previewIdx + 1];
        if (!repo || repo.startsWith("-")) {
          process.stderr.write("Usage: cue marketplace discover --pr-preview <owner/name>\n");
          return 1;
        }
        return cmdPrPreview(repo, json);
      }
      const positional = rest.slice(1).filter((a, i) => !a.startsWith("-") && rest[i] !== "--pr-preview");
      const cliAware = rest.includes("--cli-aware");
      const includeEmpty = rest.includes("--include-empty");
      const limitIdx = rest.indexOf("--limit");
      const limit = limitIdx >= 0 && rest[limitIdx + 1] ? Math.max(1, parseInt(rest[limitIdx + 1]!, 10) || 30) : 30;
      return cmdDiscover(positional[0] ?? "", json, cliAware, limit, includeEmpty);
    }
    case "open-pr": {
      const repo = rest[1] ?? "";
      const post = rest.includes("--post");
      const yes = rest.includes("--yes") || rest.includes("-y");
      const optInOnly = rest.includes("--opt-in-only");
      return cmdOpenPr(repo, json, post, yes, optInOnly);
    }
    case "cleanup-forks": {
      const dryRun = rest.includes("--dry-run");
      return cmdCleanupForks(json, dryRun);
    }
    default:
      // If no subcommand matches, treat as search query
      return cmdSearch(rest.join(" "), json);
  }
}
