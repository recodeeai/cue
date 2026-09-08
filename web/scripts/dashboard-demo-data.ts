/**
 * Generate demo-data.json for the Vercel-deployed dashboard.
 *
 * The Vercel build serves a static React app. There's no live `~/.config/cue/`
 * to read from, so every endpoint `/api/v1/*` is rewritten to /demo-data.json
 * (see web/vercel.json). This script produces that file: realistic sample
 * payloads keyed by the endpoint path the React fetcher requests.
 *
 * Usage:
 *   bun scripts/dashboard-demo-data.ts > public/demo-data.json
 *
 * The realistic shape comes from a hand-picked snapshot, NOT from running the
 * commands against the maintainer's machine — that would leak local prompts
 * and skill activations. Marketing demo data lives separately.
 */

import type { ProfileDetail, TimelineData } from "../src/studio/api.js";

interface Envelope { ok: true; data: unknown }
function env<T>(data: T): Envelope { return { ok: true, data: data as unknown as unknown }; }

const demo = {
  "/status": env({
    profile: {
      name: "medusa-vite+backend",
      description: "Medusa v2 + Vite + TanStack storefront, with backend conventions",
      // Totals reflect post-dedupe merge.
      skills: 47,
      mcps: 3,
      plugins: 1,
    },
    // Composite parts: pre-dedupe per-part contribution. Helps users see
    // what each layer brings to the merge.
    parts: [
      { name: "medusa-vite", description: "Medusa v2 + Vite + TanStack storefront", skills: 31, mcps: 2, plugins: 1 },
      { name: "backend",     description: "Server-side conventions, APIs, deploys",  skills: 22, mcps: 1, plugins: 0 },
    ],
    source: "pin-file",
    warnings: [],
    gates: {
      ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      overall: "pass",
      failed: [],
    },
    totalProfiles: 53,
    totalSessions: 128,
    telemetryEnabled: true,
  }),

  "/profiles": env([
    { name: "medusa-vite+backend",                claudeMdBytes: 6_812 },
    { name: "designer+medusa-vite",               claudeMdBytes: 9_104 },
    { name: "postizz+blog-writer+trendradar",     claudeMdBytes: 18_634 },
    { name: "google-ads+marketing+blog-writer",   claudeMdBytes: 20_503 },
    { name: "skill-writer+core+ecc",              claudeMdBytes: 13_160 },
    { name: "coolify+backend+hostinger",          claudeMdBytes: 11_492 },
    { name: "rust+rust-core",                     claudeMdBytes: 7_812 },
    { name: "nextjs",                             claudeMdBytes: 5_322 },
    { name: "frontend",                           claudeMdBytes: 4_905 },
    { name: "core",                               claudeMdBytes: 3_201 },
  ]),

  "/skill-report": env({
    profile: "medusa-vite+backend",
    windowDays: 30,
    rows: [
      { id: "design/screenshot",          hits: 47, lastUsed: new Date(Date.now() - 60 * 60 * 1000).toISOString(), zombie: false },
      { id: "design/design-taste-frontend", hits: 31, lastUsed: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), zombie: false },
      { id: "browser/playwright",         hits: 22, lastUsed: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), zombie: false },
      { id: "medusa/db-migrate",          hits: 15, lastUsed: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), zombie: false },
      { id: "design/image-to-code",       hits: 9,  lastUsed: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), zombie: false },
      // Zombies — the value prop
      { id: "design/ui-ux-pro-max",       hits: 0, lastUsed: null, zombie: true },
      { id: "design/minimalist-ui",       hits: 0, lastUsed: null, zombie: true },
      { id: "medusa/woocommerce-to-medusa-import", hits: 0, lastUsed: null, zombie: true },
      { id: "medusa/new-admin-via-api",   hits: 0, lastUsed: null, zombie: true },
      { id: "medusa/gh-submodule-publish", hits: 0, lastUsed: null, zombie: true },
      { id: "medusa/db-generate",         hits: 0, lastUsed: null, zombie: true },
      { id: "medusa/new-user",            hits: 0, lastUsed: null, zombie: true },
    ],
  }),

  "/pairs": env([
    { profile: "designer",   partners: [{ name: "medusa-vite", count: 12, affinity: 0.86 }, { name: "backend", count: 9, affinity: 0.64 }] },
    { profile: "medusa-vite", partners: [{ name: "backend",     count: 11, affinity: 0.79 }, { name: "designer", count: 8, affinity: 0.57 }] },
    { profile: "blog-writer", partners: [{ name: "postizz",     count: 7,  affinity: 0.70 }] },
    { profile: "rust",        partners: [{ name: "rust-core",   count: 6,  affinity: 1.00 }] },
  ]),

  "/gates?all=1": env([
    {
      ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      profile: "medusa-vite+backend",
      overall: "pass",
      results: [
        { name: "tests-pass.sh", ok: true, exit: 0, stderr: "" },
        { name: "typecheck-pass.sh", ok: true, exit: 0, stderr: "" },
        { name: "git-clean.sh", ok: true, exit: 0, stderr: "" },
      ],
    },
    {
      ts: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      profile: "skill-writer",
      overall: "fail",
      results: [
        { name: "lint-skill-pass.sh", ok: false, exit: 2, stderr: "WARNING R009 — em dash found in prose." },
        { name: "skill-overlap-check.sh", ok: true, exit: 0, stderr: "" },
      ],
    },
    {
      ts: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      profile: "designer",
      overall: "pass",
      results: [{ name: "tests-pass.sh", ok: true, exit: 0, stderr: "" }],
    },
  ]),

  "/trigger-gaps": env({
    profile: "medusa-vite+backend",
    windowDays: 30,
    promptsScanned: 412,
    rows: [
      { id: "design/awwwards-clone", name: "awwwards-clone", matchedPrompts: 18, recordedHits: 0, gap: 18, sampleTriggers: ["clone this design", "awwwards"] },
      { id: "medusa/db-migrate",     name: "db-migrate",     matchedPrompts: 14, recordedHits: 6,  gap: 8,  sampleTriggers: ["run migration", "db migrate"] },
      { id: "browser/playwright",    name: "playwright",     matchedPrompts: 31, recordedHits: 28, gap: 3,  sampleTriggers: ["take a screenshot", "open in browser"] },
    ],
  }),

  "/active-sessions": env({
    supported: true,
    sessions: [
      { pid: 38291, profile: "medusa-vite+backend", agent: "claude", cwd: "/home/jane/code/lifted-shop",   startedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString() },
      { pid: 38540, profile: "medusa-vite+backend", agent: "claude", cwd: "/home/jane/code/brand-2-shop", startedAt: new Date(Date.now() - 8 * 60 * 1000).toISOString() },
      { pid: 41552, profile: "designer",            agent: "claude", cwd: "/home/jane/design/landing-v3",  startedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString() },
      { pid: 43001, profile: "skill-writer",        agent: "claude", cwd: "/home/jane/Documents/cue",      startedAt: new Date(Date.now() - 30 * 1000).toISOString() },
    ],
  }),

  "/telemetry/timeline": env({
    windowDays: 30,
    profiles: [
      { profile: "medusa-vite+backend", sessions: 47, lastUsed: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      { profile: "skill-writer",         sessions: 31, lastUsed: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() },
      { profile: "designer",             sessions: 18, lastUsed: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    ],
  }),

  // Merge Studio: full source list (counts + bundle/conflict hints).
  "/profiles/full": env([
    { name: "medusa-dev", icon: "🦊", description: "Medusa v2 backend, storefront, admin, migration", skills: 15, npx: 2, mcps: 2, plugins: 1, bundles: [], conflicts: [], inheritsCore: true, error: null },
    { name: "medusa-vite", icon: "⚡", description: "Medusa v2 + Vite + TanStack storefront", skills: 22, npx: 1, mcps: 2, plugins: 1, bundles: [], conflicts: ["medusa-next"], inheritsCore: true, error: null },
    { name: "medusa-next", icon: "▲", description: "Medusa v2 + Next.js storefront", skills: 21, npx: 1, mcps: 2, plugins: 1, bundles: [], conflicts: ["medusa-vite"], inheritsCore: true, error: null },
    { name: "designer", icon: "🎨", description: "Premium UI/UX design, brand kits, image-to-code", skills: 18, npx: 2, mcps: 1, plugins: 2, bundles: [], conflicts: [], inheritsCore: true, error: null },
    { name: "backend", icon: "🐻", description: "APIs, webhooks, security review, CI, deploy", skills: 14, npx: 0, mcps: 1, plugins: 0, bundles: [], conflicts: [], inheritsCore: true, error: null },
    { name: "stripe", icon: "💳", description: "Stripe payments, Checkout, webhooks", skills: 4, npx: 1, mcps: 0, plugins: 0, bundles: [], conflicts: [], inheritsCore: true, error: null },
    { name: "marketing", icon: "📣", description: "Copywriting, SEO, CRO, growth, channels", skills: 12, npx: 0, mcps: 0, plugins: 0, bundles: [], conflicts: [], inheritsCore: true, error: null },
    { name: "core", icon: "🐣", description: "Always-on baseline", skills: 22, npx: 0, mcps: 1, plugins: 1, bundles: [], conflicts: [], inheritsCore: true, error: null },
  ]),

  // Merge Studio preview (medusa-dev + designer, deduped). Keyed `POST <path>`
  // because the fetcher's demo branch looks it up that way.
  "POST /merge/preview": env({
    preview: {
      names: ["medusa-dev", "designer"],
      name: "commerce",
      icon: "🦊",
      description: "Merged loadout — medusa-dev + designer (33 skills, 5 MCPs)",
      skills: ["medusa/medusa-reference", "medusa/db-migrate", "design/brandkit", "design/redesign-skill", "design/minimalist-skill"],
      dropped: [],
      mcps: ["medusadocs", "gbrain", "Higgsfield"],
      plugins: ["frontend-design@claude-plugins-official"],
      profileConflicts: [],
      skillConflicts: [],
      usage: [
        { id: "design/brandkit", references: 31, lastSeen: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
        { id: "medusa/db-migrate", references: 6, lastSeen: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
      ],
      estTokens: 40000,
      appliedOptimizations: ["dedupe", "router"],
    },
    yaml: {
      static: "name: commerce\nicon: \"🦊\"\ndescription: \"Merged loadout — medusa-dev + designer\"\ninherits: core\nbundles:\n  - medusa-dev\n  - designer\nskills:\n  local:\n    - medusa/medusa-reference\n    - design/brandkit\n",
      alias: "name: commerce\nicon: \"🦊\"\ndescription: \"Merged loadout — medusa-dev + designer\"\ninherits:\n  - medusa-dev\n  - designer\nbundles:\n  - medusa-dev\n  - designer\n",
    },
  }),
};

// Keep the legacy cards above, but generate the Studio's full read contract.
// Never read the host's profiles, sessions or credentials to populate a demo.
const output: Record<string, Envelope> = { ...demo };
const rows = demo["/profiles/full"].data as { name: string; description: string; [key: string]: unknown }[];
const details = new Map<string, ProfileDetail>();
for (const row of rows) {
  const ids = row.name === "core" ? ["core/getting-started"] : ["core/getting-started", `${row.name}/sample-workflow`];
  const skills = ids.map((id) => {
    const [ns, name] = id.split("/") as [string, string];
    const body = `# ${name}\n\nDemo skill for the Studio preview, not an installed skill.\n\n## Workflow\n\n1. Inspect the task.\n2. Make a focused change.\n3. Verify the result.\n`;
    return { id, ns, name, desc: "Demo workflow — sample content only.", body, sizeK: body.length / 1024, uses: ["context7"], missing: false };
  });
  const detail: ProfileDetail = {
    profile: row.name, parts: [row.name], skills,
    mcps: [{ id: "context7", status: "demo" }],
    plugins: [], commands: [], subagents: [], clis: [], recommends: [],
    playbooks: [{
      id: `demo-${row.name}`, name: `demo-${row.name}`, title: "Demo verification workflow",
      emoji: "🧪", trigger: "demo", est: "3 steps", desc: "Sample workflow; does not execute commands.",
      steps: ["Inspect", "Implement", "Verify"].map((name) => ({ name, detail: "Demo step — illustration only." })),
    }],
    counts: { skills: skills.length, mcps: 1, plugins: 0, commands: 0, subagents: 0, clis: 0 },
  };
  details.set(row.name, detail);
  Object.assign(row, { ...detail.counts, npx: 0, iconImage: null });
}

const activeName = "medusa-vite+backend";
const parts = ["medusa-vite", "backend"];
const activeSkills = [...new Map(parts.flatMap((part) => details.get(part)!.skills).map((skill) => [skill.id, skill])).values()];
const active: ProfileDetail = {
  ...details.get("medusa-vite")!, profile: activeName, parts, skills: activeSkills,
  counts: { ...details.get("medusa-vite")!.counts, skills: activeSkills.length },
};
details.set(activeName, active);

// Exact keys match the query strings produced by the Studio hooks. Distinct
// profiles/ranges must not silently receive another profile's canned response.
for (const [name, detail] of details) {
  const selectors = [`?profile=${encodeURIComponent(name)}`, ...(name === activeName ? [""] : [])];
  for (const selector of selectors) {
    output[`/profile-detail${selector}`] = env(detail);
    output[`/hooks${selector}`] = env({ profile: name, total: 0, events: [] });
    output[`/repos${selector}`] = env({ profile: name, repos: [] });
    for (const range of [7, 30, 90]) {
      const report = env({
        profile: name, windowDays: range,
        rows: detail.skills.map((skill, i) => ({ id: skill.id, hits: i + range, lastUsed: new Date().toISOString(), zombie: false })),
      });
      output[`/skill-report${selector}${selector ? "&" : "?"}since=${range}`] = report;
      if (range === 30) output[`/skill-report${selector}`] = report;
    }
  }
}

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const history = Array.from({ length: 90 }, (_, i) => ({
  date: new Date(today.getTime() - (89 - i) * 86400000).toISOString().slice(0, 10),
  sessions: [2, 5, 1, 8, 3, 0, 4][i % 7]!,
  profile: rows[i % rows.length]!.name,
}));
for (const range of [7, 30, 90]) {
  const days = history.slice(-range);
  const timeline: TimelineData = {
    windowDays: range,
    daily: days.map(({ date, sessions }) => ({ date, sessions })),
    profiles: rows.map((row) => {
      const matching = days.filter((day) => day.profile === row.name && day.sessions > 0);
      return { profile: row.name, sessions: matching.reduce((n, day) => n + day.sessions, 0), lastUsed: matching.at(-1)?.date ?? null };
    }).filter((row) => row.sessions > 0),
  };
  output[`/telemetry/timeline?since=${range}`] = env(timeline);
  if (range === 30) output["/telemetry/timeline"] = env(timeline);
}
const totalSessions = history.reduce((n, day) => n + day.sessions, 0);
const status = demo["/status"].data as Record<string, unknown>;
Object.assign(status, {
  profile: { name: activeName, description: "Demo composite — Medusa storefront and backend workflows.", ...active.counts },
  parts: parts.map((name) => ({ name, description: rows.find((row) => row.name === name)!.description, ...details.get(name)!.counts })),
  totalProfiles: rows.length, totalSessions,
  durations: { avgS: 720, totalS: totalSessions * 720, ended: totalSessions },
});
output["/version"] = env({ current: "demo", latest: null, updateAvailable: false, notice: null });
output["/mcps/catalog"] = env([{
  id: "context7", description: "Demo documentation server.", transport: "stdio", install: "cue mcp add context7",
  usedBy: rows.map((row) => ({ name: row.name, icon: null, iconImage: null })),
}]);
output["/plugins/discovered"] = env({ plugins: [] });
output["/permissions"] = env({ rules: [], counts: { allow: 0, ask: 0, deny: 0 }, defaultMode: null, sources: [] });
output["/env/folders"] = env({ folders: [] });
output["/market"] = env({ items: [], counts: {} });

process.stdout.write(JSON.stringify(output, null, 2) + "\n");
