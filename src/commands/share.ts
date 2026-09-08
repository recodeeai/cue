/**
 * `cue share` — install, list, and remove community profiles.
 *
 * v1 subcommands (this turn):
 *   cue share install <user>/<repo>[@ref][:subpath]
 *   cue share list
 *   cue share remove <user>/<repo>
 *
 * Stubbed for the next turn (advertised here so users know they're coming):
 *   cue share push <name>     — opens PR against opencue/claude-code-skills-profiles
 *   cue share search <query>  — needs the central registry to exist
 *   cue share update          — re-pull installed profiles
 *
 * Installed profiles land under `~/.config/cue/shared/<user>/<repo>/`
 * and are namespaced as `<user>-<repo>` (kebab-case so the existing
 * profile-name schema pattern still validates). The profile loader was
 * patched to fall back to this dir, so `cue use jane-medusa-shop`
 * resolves shared profiles transparently.
 *
 * Trust posture: install prompts for confirmation in a TTY (`--yes` to
 * skip). The profile.yaml is shown via path in the success output so the
 * user can audit hooks/qualityGates before `cue use`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import * as p from "@clack/prompts";

import {
  fetchProfileYaml,
  indexCachePath,
  listInstalled,
  parseShareRef,
  readCachedIndex,
  registryIndexUrl,
  removeInstall,
  searchIndex,
  sharedProfileDir,
  sharedProfileName,
  sharedRoot,
  writeIndexCache,
  writeInstall,
  type RegistryEntry,
} from "../lib/shared-profiles";

const REPO_ROOT = resolve(new URL(import.meta.url).pathname, "..", "..", "..");
const PROFILES_DIR = process.env.CUE_PROFILES_DIR ?? join(REPO_ROOT, "profiles");

/** GitHub repo the push flow targets. Overridable for forks / dev mirrors. */
function registryRepoSlug(): string {
  return process.env.CUE_REGISTRY_REPO ?? "opencue/claude-code-skills-profiles";
}

interface ParsedArgs {
  sub: "install" | "list" | "remove" | "push" | "search" | "update" | "help";
  positional: string[];
  json: boolean;
  yes: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    sub: "help",
    positional: [],
    json: false,
    yes: false,
  };
  if (argv.length === 0) return out;
  const first = argv[0]!;
  if (first === "--help" || first === "-h") return out;
  switch (first) {
    case "install":
    case "list":
    case "remove":
    case "push":
    case "search":
    case "update":
      out.sub = first;
      break;
    default:
      return out;
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (!a.startsWith("-")) out.positional.push(a);
  }
  return out;
}

function helpText(): string {
  return [
    "cue share — install, push, and discover community profiles",
    "",
    "Usage:",
    "  cue share install <user>/<repo>[@ref][:subpath] [--yes]",
    "  cue share install https://github.com/<user>/<repo>",
    "  cue share list    [--json]",
    "  cue share remove  <user>/<repo>",
    "  cue share push    <profile-name>     [-y]",
    "  cue share search  [<query>]          [--json]",
    "  cue share update  [<user>/<repo>]",
    "",
    "Examples:",
    "  cue share install jane/medusa-shop",
    "  cue share install jane/medusa-shop@v1.2",
    "  cue share install jane/dotfiles:profiles/storefront",
    "  cue share push my-shop",
    "  cue share search medusa",
    "  cue share update",
    "",
    "Installed shared profiles are namespaced as `<user>-<repo>` so they",
    "can never silently shadow a builtin. Use them like any other profile:",
    "  cue use jane-medusa-shop",
    "  cue use jane-medusa-shop+backend",
    "",
    "Install only downloads and validates YAML; it does not activate profiles or run hooks.",
    "Review the source first. Non-interactive installs require --yes.",
    "",
    "Env overrides:",
    "  CUE_REGISTRY_URL   index.json source for `search` (default opencue/claude-code-skills-profiles)",
    "  CUE_REGISTRY_REPO  target repo for `push`        (default opencue/claude-code-skills-profiles)",
    "",
  ].join("\n");
}

async function runInstall(args: ParsedArgs): Promise<number> {
  const target = args.positional[0];
  if (!target) {
    process.stderr.write("cue share install: missing <user>/<repo> argument\n");
    return 1;
  }
  const ref = parseShareRef(target);
  if (!ref) {
    process.stderr.write(
      `cue share install: cannot parse "${target}".\n` +
      "Supported forms:\n" +
      "  <user>/<repo>\n" +
      "  <user>/<repo>@<ref>\n" +
      "  <user>/<repo>:<subpath>\n" +
      "  https://github.com/<user>/<repo>\n",
    );
    return 1;
  }

  if (!args.yes && !process.stdin.isTTY) {
    process.stderr.write("cue share install: non-interactive installs require --yes. Review the GitHub profile source before opting in; installation does not activate it or approve hooks.\n");
    return 1;
  }

  const spinner = p.spinner();
  spinner.start(`Fetching ${ref.user}/${ref.repo}…`);
  let result;
  try {
    result = await fetchProfileYaml(ref);
  } catch (err) {
    spinner.stop(`Failed: ${(err as Error).message}`);
    return 1;
  }
  const sourceShort = result.source.replace("https://raw.githubusercontent.com/", "");
  spinner.stop(`Found profile.yaml at ${sourceShort}`);

  // Confirm before writing — shared profiles can declare hooks that fire
  // on every Stop / PreToolUse. Showing the user the source they're about
  // to install is the v1 trust model.
  if (!args.yes && process.stdin.isTTY) {
    const ok = await p.confirm({
      message: `Install ${ref.user}/${ref.repo} as "${sharedProfileName(ref)}"?`,
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel("Cancelled.");
      return 130;
    }
  }

  let installed: ReturnType<typeof writeInstall>;
  try {
    installed = writeInstall(ref, result.body, {
      source_url: result.source,
      installed_at: new Date().toISOString(),
      sha: result.sha,
    });
  } catch (error) {
    process.stderr.write(`cue share install: ${(error as Error).message}\n`);
    return 1;
  }
  const { dir, namespacedName } = installed;

  process.stdout.write(`\n✓ Installed ${namespacedName}\n`);
  process.stdout.write(`  Source: ${result.source}\n`);
  process.stdout.write(`  Local:  ${dir}\n`);
  process.stdout.write(`\n  Audit before launch:\n`);
  process.stdout.write(`    cat ${JSON.stringify(join(dir, "profile.yaml"))}\n`);
  process.stdout.write(`    cue validate ${namespacedName}\n`);
  process.stdout.write(`\n  After reviewing hooks, MCPs, and dependencies, use it:\n`);
  process.stdout.write(`    cue use ${namespacedName}\n`);
  process.stdout.write(`    cue launch codex\n`);
  process.stdout.write(`  Installed only: no agent started and no hooks approved or executed.\n`);
  return 0;
}

async function runList(args: ParsedArgs): Promise<number> {
  const installed = listInstalled();
  if (args.json) {
    process.stdout.write(JSON.stringify(installed, null, 2) + "\n");
    return 0;
  }
  if (installed.length === 0) {
    process.stdout.write(`No shared profiles installed under ${sharedRoot()}\n`);
    process.stdout.write(`\nInstall one with:\n  cue share install <user>/<repo>\n`);
    return 0;
  }
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  process.stdout.write(`Installed shared profiles (${installed.length}):\n\n`);
  for (const e of installed) {
    const age = e.meta?.installed_at
      ? ` ${dim(`installed ${e.meta.installed_at.slice(0, 10)}`)}`
      : "";
    process.stdout.write(`  ${bold(e.namespacedName)}${age}\n`);
    if (e.meta?.source_url) {
      process.stdout.write(`    ${dim(e.meta.source_url)}\n`);
    }
  }
  return 0;
}

async function runRemove(args: ParsedArgs): Promise<number> {
  const target = args.positional[0];
  if (!target) {
    process.stderr.write("cue share remove: missing <user>/<repo> argument\n");
    return 1;
  }
  const ref = parseShareRef(target);
  if (!ref) {
    process.stderr.write(`cue share remove: cannot parse "${target}".\n`);
    return 1;
  }
  const dir = sharedProfileDir(ref);
  const removed = removeInstall(ref);
  if (!removed) {
    process.stderr.write(`Not installed: ${sharedProfileName(ref)} (would have been at ${dir})\n`);
    return 1;
  }
  process.stdout.write(`✓ Removed ${sharedProfileName(ref)}\n`);
  return 0;
}

async function runPush(args: ParsedArgs): Promise<number> {
  const profileName = args.positional[0];
  if (!profileName) {
    process.stderr.write("cue share push: missing <profile-name> argument\n");
    return 1;
  }

  const profileYaml = join(PROFILES_DIR, profileName, "profile.yaml");
  if (!existsSync(profileYaml)) {
    process.stderr.write(`cue share push: profile not found at ${profileYaml}\n`);
    return 1;
  }

  // Auth + identity via gh CLI. Fail with a clear pointer when missing.
  const ghCheck = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  if (ghCheck.status !== 0) {
    process.stderr.write(
      "cue share push: GitHub CLI not authenticated.\n" +
      "Install + log in: https://cli.github.com  →  gh auth login\n",
    );
    return 1;
  }
  const whoami = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" });
  const ghUser = whoami.stdout.trim();
  if (!ghUser) {
    process.stderr.write("cue share push: could not resolve GitHub login.\n");
    return 1;
  }

  const registry = registryRepoSlug();
  const branchName = `share/${ghUser}-${profileName}-${Date.now()}`;
  const remotePath = `profiles/${ghUser}/${profileName}/profile.yaml`;
  const profileBody = readFileSync(profileYaml, "utf8");

  process.stdout.write(`\nPushing ${profileName} to ${registry} as ${ghUser}/${profileName}…\n`);

  if (!args.yes && process.stdin.isTTY) {
    const ok = await p.confirm({
      message: `Open a PR adding ${remotePath} to ${registry}?`,
      initialValue: true,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel("Cancelled.");
      return 130;
    }
  }

  // Stage the file in a single API call via `gh api`. Uses the GitHub
  // contents endpoint so we don't need a local checkout of the registry.
  const fileContentB64 = Buffer.from(profileBody, "utf8").toString("base64");

  // 1. Ensure the user has forked the registry. `gh repo fork --remote=false`
  //    is idempotent and silent on already-forked.
  const forkRes = spawnSync("gh", ["repo", "fork", registry, "--clone=false", "--remote=false"], {
    encoding: "utf8",
  });
  if (forkRes.status !== 0 && !/already exists/i.test(forkRes.stderr ?? "")) {
    process.stderr.write(`cue share push: fork failed:\n${forkRes.stderr}\n`);
    return 1;
  }

  // 2. Get default branch of the registry to base the PR branch off.
  const defaultBranchRes = spawnSync(
    "gh",
    ["api", `repos/${registry}`, "--jq", ".default_branch"],
    { encoding: "utf8" },
  );
  const baseBranch = (defaultBranchRes.stdout || "main").trim();

  // 3. Get the base branch's tip sha from the fork.
  const fork = `${ghUser}/${registry.split("/")[1]}`;
  const baseShaRes = spawnSync(
    "gh",
    ["api", `repos/${fork}/git/ref/heads/${baseBranch}`, "--jq", ".object.sha"],
    { encoding: "utf8" },
  );
  const baseSha = baseShaRes.stdout.trim();
  if (!baseSha) {
    process.stderr.write(
      `cue share push: could not resolve base sha on the fork. Sync your fork first: gh repo sync ${fork}\n`,
    );
    return 1;
  }

  // 4. Create the PR branch on the fork.
  const createBranchRes = spawnSync(
    "gh",
    [
      "api", "-X", "POST", `repos/${fork}/git/refs`,
      "-f", `ref=refs/heads/${branchName}`,
      "-f", `sha=${baseSha}`,
    ],
    { encoding: "utf8" },
  );
  if (createBranchRes.status !== 0) {
    process.stderr.write(`cue share push: branch create failed:\n${createBranchRes.stderr}\n`);
    return 1;
  }

  // 5. PUT the profile.yaml on that branch.
  const putRes = spawnSync(
    "gh",
    [
      "api", "-X", "PUT", `repos/${fork}/contents/${remotePath}`,
      "-f", `message=share: add ${ghUser}/${profileName}`,
      "-f", `content=${fileContentB64}`,
      "-f", `branch=${branchName}`,
    ],
    { encoding: "utf8" },
  );
  if (putRes.status !== 0) {
    process.stderr.write(`cue share push: file write failed:\n${putRes.stderr}\n`);
    return 1;
  }

  // 6. Open the PR.
  const prRes = spawnSync(
    "gh",
    [
      "pr", "create",
      "--repo", registry,
      "--head", `${ghUser}:${branchName}`,
      "--base", baseBranch,
      "--title", `share: add ${ghUser}/${profileName}`,
      "--body",
      [
        `Profile contributed by @${ghUser} via \`cue share push\`.`,
        "",
        "**Reviewer checklist:**",
        "- [ ] profile.yaml validates against the cue schema",
        "- [ ] `description:` is meaningful (not a placeholder)",
        "- [ ] no embedded secrets",
        "- [ ] inherits chain resolves to public profiles",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  if (prRes.status !== 0) {
    process.stderr.write(`cue share push: PR create failed:\n${prRes.stderr}\n`);
    return 1;
  }
  const prUrl = prRes.stdout.trim();
  process.stdout.write(`\n✓ Opened PR: ${prUrl}\n`);
  process.stdout.write(
    `  Once merged, anyone can install with:\n    cue share install ${registry}@${baseBranch}:profiles/${ghUser}/${profileName}\n`,
  );
  return 0;
}

async function runSearch(args: ParsedArgs): Promise<number> {
  const query = args.positional.join(" ");

  // Try cache first; refresh on miss or stale.
  let cache = readCachedIndex();
  if (!cache) {
    const url = registryIndexUrl();
    const spinner = p.spinner();
    spinner.start(`Fetching registry index (${url})…`);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        spinner.stop(`Registry index unreachable (HTTP ${res.status}).`);
        process.stderr.write(
          `\nThe central registry hasn't been published yet, or the URL has moved.\n` +
          `You can still install directly: cue share install <user>/<repo>\n` +
          `Override the index URL: CUE_REGISTRY_URL=https://… cue share search …\n`,
        );
        return 1;
      }
      const entries = (await res.json()) as RegistryEntry[];
      if (!Array.isArray(entries)) {
        spinner.stop(`Registry index malformed (expected JSON array).`);
        return 1;
      }
      writeIndexCache(entries, url);
      cache = { fetched_at: new Date().toISOString(), source: url, entries };
      spinner.stop(`Cached ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`);
    } catch (err) {
      spinner.stop(`Network error: ${(err as Error).message}`);
      return 1;
    }
  }

  const matches = searchIndex(cache.entries, query);

  if (args.json) {
    process.stdout.write(JSON.stringify({ query, count: matches.length, results: matches }, null, 2) + "\n");
    return 0;
  }
  if (matches.length === 0) {
    process.stdout.write(`No matches${query ? ` for "${query}"` : ""}.\n`);
    return 0;
  }
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  process.stdout.write(
    `${matches.length} match${matches.length === 1 ? "" : "es"}${query ? ` for "${query}"` : ""}:\n\n`,
  );
  for (const e of matches.slice(0, 30)) {
    const slug = `${e.author}/${e.name}`;
    const stars = e.stars != null ? dim(`  ★${e.stars}`) : "";
    process.stdout.write(`  ${bold(slug)}${stars}\n`);
    if (e.description) process.stdout.write(`    ${dim(e.description)}\n`);
  }
  if (matches.length > 30) {
    process.stdout.write(`\n  …and ${matches.length - 30} more. Refine with more search terms.\n`);
  }
  process.stdout.write(`\nInstall any: cue share install <user>/<repo>\n`);
  return 0;
}

async function runUpdate(args: ParsedArgs): Promise<number> {
  const installed = listInstalled();
  if (installed.length === 0) {
    process.stdout.write(`Nothing to update — no shared profiles installed.\n`);
    return 0;
  }
  const target = args.positional[0]; // optional: limit to a single ref
  const targetRef = target ? parseShareRef(target) : null;
  if (target && !targetRef) {
    process.stderr.write(`cue share update: cannot parse "${target}".\n`);
    return 1;
  }
  const targetName = targetRef ? sharedProfileName(targetRef) : null;

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const entry of installed) {
    if (targetName && entry.namespacedName !== targetName) continue;
    const ref = { user: entry.user, repo: entry.repo };
    process.stdout.write(`→ ${entry.namespacedName}\n`);
    let result;
    try {
      result = await fetchProfileYaml(ref);
    } catch (err) {
      process.stderr.write(`  ✗ ${(err as Error).message}\n`);
      failed++;
      continue;
    }
    const localPath = join(entry.dir, "profile.yaml");
    let same = false;
    try {
      const local = readFileSync(localPath, "utf8");
      // Compare ignoring the locally-rewritten `name:` line so unchanged
      // upstream content doesn't show as "updated" each run.
      const stripName = (s: string) => s.replace(/^(\s*)name\s*:\s*.+$/m, "");
      same = stripName(local) === stripName(result.body);
    } catch { /* ignore — treat as updated */ }
    if (same) {
      process.stdout.write(`  · no change\n`);
      unchanged++;
      continue;
    }
    writeInstall(ref, result.body, {
      source_url: result.source,
      installed_at: new Date().toISOString(),
      sha: result.sha,
    });
    process.stdout.write(`  ✓ updated\n`);
    updated++;
  }

  process.stdout.write(
    `\nDone: ${updated} updated, ${unchanged} unchanged${failed > 0 ? `, ${failed} failed` : ""}.\n`,
  );
  return failed > 0 ? 1 : 0;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  switch (args.sub) {
    case "install": return runInstall(args);
    case "list":    return runList(args);
    case "remove":  return runRemove(args);
    case "push":    return runPush(args);
    case "search":  return runSearch(args);
    case "update":  return runUpdate(args);
    case "help":
    default:
      process.stdout.write(helpText());
      return 0;
  }
}

// Re-export for tests/integrations that want to point at a custom cache path.
export { indexCachePath };
