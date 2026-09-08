/**
 * Data layer adapter. Switches between the local Bun dashboard server
 * (`/api/v1/*` endpoints, real data from `~/.config/cue/`) and a static
 * `demo-data.json` blob shipped with the Vercel deploy.
 *
 * Every API call goes through `fetcher(path)` which returns the parsed
 * `data` payload OR throws a typed error so `useQuery` can render
 * appropriate empty / error states.
 */

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

type Mode = "local" | "demo";

export function resolveCueMode(hostname: string, requested?: Mode): Mode {
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  return loopback && requested !== "demo" ? "local" : "demo";
}

export function getCueMode(): Mode {
  return resolveCueMode(window.location.hostname, window.__CUE_MODE__ ?? import.meta.env.VITE_CUE_MODE);
}

/** True on the static demo deploy (no local server → no SSE / live push). */
export function isDemoMode(): boolean {
  return getCueMode() === "demo";
}

let demoCache: Record<string, unknown> | null = null;
async function loadDemoData(): Promise<Record<string, unknown>> {
  if (demoCache) return demoCache;
  const res = await fetch("/demo-data.json");
  if (!res.ok) throw new Error(`demo-data.json fetch failed (${res.status})`);
  demoCache = await res.json();
  return demoCache!;
}

/**
 * Fetch a single API path. Returns the unwrapped `data` payload.
 * Throws on transport errors and on `{ok:false}` envelopes — the error
 * message is set to the envelope's `error` field so React Query's
 * `error.message` surfaces the cause directly (e.g. "telemetry-disabled").
 *
 * Special-cases the "dashboard server not running" path so UI components
 * can render a clear CTA instead of a useless "non-JSON 500" message.
 * The vite config maps proxy errors → `dashboard-server-unreachable`;
 * a true network-level fetch failure surfaces the same code so both
 * paths render identically.
 */
export async function fetcher<T>(path: string): Promise<T> {
  const mode = getCueMode();

  if (mode === "demo") {
    const demo = await loadDemoData();
    const env = demo[path] as ApiEnvelope<T> | undefined;
    if (!env) throw new Error(`demo-data has no entry for ${path}`);
    if (!env.ok) throw new Error(env.error);
    return env.data;
  }

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`);
  } catch (err) {
    // fetch() itself blew up — no response. Almost always means the
    // dashboard server isn't running on the proxied port.
    throw new Error(`dashboard-server-unreachable: ${(err as Error).message}`);
  }

  let env: ApiEnvelope<T>;
  try {
    env = (await res.json()) as ApiEnvelope<T>;
  } catch {
    // Vite's stock proxy-error page is HTML; the proxy `configure` hook
    // in vite.config.ts converts it to a JSON envelope so this branch is
    // rare. When it does fire (5xx from the cue dashboard server itself,
    // for instance), surface the status code with the path.
    throw new Error(`${path}: server returned non-JSON (HTTP ${res.status})`);
  }
  if (!env.ok) throw new Error(env.error);
  return env.data;
}

/**
 * POST a JSON body to an API path and unwrap the `data` payload. Used by the
 * Merge Studio's write-side endpoints (`/merge/preview`, `/merge/save`).
 *
 * Demo mode has no server: `preview` falls back to a canned entry in
 * demo-data keyed `POST <path>`; `save` is rejected with a clear message so
 * the Vercel demo doesn't pretend to write files.
 */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const mode = getCueMode();

  if (mode === "demo") {
    if (path.startsWith("/merge/save")) {
      throw new Error("Saving is disabled in the demo — run cue locally to write profiles.");
    }
    if (path.startsWith("/sessions/")) {
      throw new Error("Stopping sessions is disabled in the demo — run cue locally.");
    }
    const demo = await loadDemoData();
    const env = demo[`POST ${path}`] as ApiEnvelope<T> | undefined;
    if (!env) throw new Error(`demo-data has no entry for POST ${path}`);
    if (!env.ok) throw new Error(env.error);
    return env.data;
  }

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`dashboard-server-unreachable: ${(err as Error).message}`);
  }

  let env: ApiEnvelope<T>;
  try {
    env = (await res.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(`${path}: server returned non-JSON (HTTP ${res.status})`);
  }
  if (!env.ok) throw new Error(env.error);
  return env.data;
}

// ---------------------------------------------------------------------------
// Shared API shapes for the Merge Studio (mirror src/lib/profile-merge.ts +
// the dashboard handlers). Kept here so components import one source of truth.
// ---------------------------------------------------------------------------

export interface ProfileRow {
  name: string;
  icon: string | null;
  /** Logo filename (served at /api/v1/profile-icon?profile=<name>), or null. */
  iconImage: string | null;
  description: string;
  skills: number;
  npx: number;
  mcps: number;
  plugins: number;
  subagents: number;
  bundles: string[];
  conflicts: string[];
  inheritsCore: boolean;
  error: string | null;
}

export type OptimizeAction = "prune" | "dedupe" | "budget" | "router";

export interface MergePreview {
  names: string[];
  name: string;
  icon: string;
  description: string;
  skills: string[];
  dropped: { id: string; reason: "prune" | "budget" }[];
  mcps: string[];
  plugins: string[];
  profileConflicts: { a: string; b: string }[];
  skillConflicts: { skillA: string; skillB: string; domain: string }[];
  usage: { id: string; references: number; lastSeen: string | null }[];
  estTokens: number;
  appliedOptimizations: OptimizeAction[];
}

export interface PreviewResponse {
  preview: MergePreview;
  yaml: { static: string; alias: string };
}

export interface SaveResponse {
  path: string;
  mode: "static" | "alias";
  created: boolean;
  yaml: string;
  previousYaml: string | null;
}
