import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProfileRow } from "./src/lib/fetcher";
import type { ProfileDetail, StatusData, TimelineData } from "./src/studio/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "./src/studio/views/Dashboard";

const generated = spawnSync("bun", ["scripts/dashboard-demo-data.ts"], {
  cwd: fileURLToPath(new URL(".", import.meta.url)),
  encoding: "utf8",
});

describe("Dashboard loading states", () => {
  function render(options: { timeline?: TimelineData; errors?: boolean; demo?: boolean } = {}) {
    const originalWindow = globalThis.window;
    globalThis.window = {
      __CUE_MODE__: options.demo ? "demo" : "local",
      location: { hostname: "127.0.0.1" },
    } as Window & typeof globalThis;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } } });
    const status = { ...data<StatusData>("/status"), gates: null };
    client.setQueryData(["profile-detail", status.profile!.name], data<ProfileDetail>("/profile-detail"));
    if (options.timeline) client.setQueryData(["timeline", 30], options.timeline);
    if (options.demo) client.setQueryData(["active-sessions"], demo["/active-sessions"].data);
    if (options.errors) {
      for (const queryKey of [["timeline", 30], ["active-sessions"]]) {
        client.getQueryCache().build(client, { queryKey }).setState({
          status: "error", fetchStatus: "idle", error: new Error("fixture-unavailable"),
        });
      }
    }
    try {
      return renderToStaticMarkup(createElement(QueryClientProvider, { client },
        createElement(Dashboard, { profile: status.profile!.name, status })));
    } finally {
      client.clear();
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else globalThis.window = originalWindow;
    }
  }

  test("pending data is not presented as zero activity or no sessions", () => {
    const html = render();
    expect(html).toContain("Loading activity");
    expect(html).toContain("Loading sessions");
    expect(html).not.toContain("No live cue-launched sessions");
    expect(html).not.toContain("passed");
  });

  test("failed queries offer retry instead of a misleading empty state", () => {
    const html = render({ errors: true });
    expect(html).toContain("Retry activity");
    expect(html).toContain("Retry sessions");
    expect(html).toContain("fixture-unavailable");
    expect(html).not.toContain("No live cue-launched sessions");
  });

  test("a one-day series keeps its date label and uses the selected window total", () => {
    const html = render({ timeline: { windowDays: 30, daily: [{ date: "2026-09-08", sessions: 5 }], profiles: [] } });
    expect(html).toContain("09-08");
    expect(html).toContain('<div class="mt-n">5</div>');
    expect(html).not.toContain("NaN");
  });

  test("demo sessions cannot be stopped and sample activity is labelled", () => {
    const html = render({ demo: true, timeline: data<TimelineData>("/telemetry/timeline") });
    expect(html).toContain("Sample data");
    expect(html).toContain("Sample agent sessions");
    expect(html).toMatch(/class="sr-stop"[^>]*disabled/);
    expect(html).not.toContain("pause live updates");
  });
});
if (generated.status !== 0) throw new Error(generated.stderr);
const demo = JSON.parse(generated.stdout);

function data<T>(path: string): T {
  expect(demo[path], path).toBeDefined();
  expect(demo[path].ok, path).toBe(true);
  return demo[path].data as T;
}

describe("Studio demo loading contract", () => {
  test("loads the active profile and every selectable profile with matching counts", () => {
    const status = data<StatusData>("/status");
    const rows = data<ProfileRow[]>("/profiles/full");
    const active = data<ProfileDetail>("/profile-detail");
    expect(active.profile).toBe(status.profile!.name);
    expect(status.totalProfiles).toBe(rows.length);
    for (const name of [active.profile, ...rows.map((row) => row.name)]) {
      const detail = data<ProfileDetail>(`/profile-detail?profile=${encodeURIComponent(name)}`);
      expect(detail.profile).toBe(name);
      for (const key of ["skills", "mcps", "plugins", "commands", "subagents", "clis"] as const) {
        expect(detail.counts[key]).toBe(detail[key].length);
      }
      expect(detail.skills.length).toBeGreaterThan(0);
      expect(Array.isArray(detail.playbooks)).toBe(true);
      expect(Array.isArray(detail.recommends)).toBe(true);
      for (const skill of detail.skills) {
        expect(skill.body).toContain("Demo");
        expect(skill.missing).toBe(false);
      }
      for (const endpoint of ["hooks", "repos"]) data(`/${endpoint}?profile=${encodeURIComponent(name)}`);
      data(`/skill-report?profile=${encodeURIComponent(name)}&since=30`);
    }
    for (const row of rows) {
      const detail = data<ProfileDetail>(`/profile-detail?profile=${encodeURIComponent(row.name)}`);
      expect(row.skills).toBe(detail.counts.skills);
      expect(row.mcps).toBe(detail.counts.mcps);
      expect(row.plugins).toBe(detail.counts.plugins);
    }
  });

  test("every chart range has daily samples, correct totals and query-specific data", () => {
    for (const range of [7, 30, 90]) {
      const timeline = data<TimelineData>(`/telemetry/timeline?since=${range}`);
      expect(timeline.windowDays).toBe(range);
      expect(timeline.daily.length).toBe(range);
      expect(new Set(timeline.daily.map((day) => day.date)).size).toBe(range);
      const total = timeline.daily.reduce((sum, day) => sum + day.sessions, 0);
      expect(total).toBeGreaterThan(0);
      expect(timeline.profiles.reduce((sum, row) => sum + row.sessions, 0)).toBe(total);
      data(`/skill-report?since=${range}`);
    }
    expect(data<TimelineData>("/telemetry/timeline").windowDays).toBe(30);
  });

  test("secondary views have safe static payloads rather than missing endpoints", () => {
    for (const path of ["/version", "/mcps/catalog", "/plugins/discovered", "/hooks", "/permissions", "/repos", "/env/folders", "/market"]) {
      data(path);
    }
    expect(data<{ folders: unknown[] }>("/env/folders").folders).toEqual([]);
    expect(data<StatusData>("/status").durations.avgS).toBeGreaterThan(0);
    // Demo data must not enable mutation endpoints.
    expect(Object.keys(demo).filter((path) => path.startsWith("POST "))).toEqual(["POST /merge/preview"]);
  });
});
