/**
 * cue studio shell — title bar + activity rail + status bar + view switching,
 * ported from the design's studio-app.jsx. The explorer stays mounted (hidden
 * when inactive) so open editor tabs survive view switches, exactly like the
 * prototype. All chrome (crumb, status-bar metrics, host pill) reads live data
 * from the proxy via the hooks in ./api.
 */

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { LocalInventory } from "./LocalInventory";

import { useStatus, useProfileDetail, useVersion } from "./api";
import { Explorer } from "./views/Explorer";
import { Dashboard } from "./views/Dashboard";
import { SearchView } from "./views/Search";
import { MergeView } from "./views/Merge";
import { WorkflowsView } from "./views/Workflows";
import { McpsView } from "./views/Mcps";
import { PluginsView } from "./views/Plugins";
import { MarketView } from "./views/Market";
import { HooksView } from "./views/Hooks";
import { PermissionsView } from "./views/Permissions";
import { EnvView } from "./views/Env";
import { SettingsView } from "./views/Settings";
import { ProfilesView } from "./views/Profiles";
import { ApiView } from "./views/Api";
import { OfflineBanner } from "./views/OfflineBanner";
import { Welcome } from "./views/Welcome";
import welcomeStyles from "./views/Welcome.module.css";
import { isDemoMode } from "../lib/fetcher";

export type View =
  | "inventory"
  | "welcome" | "explorer" | "dashboard" | "profiles" | "search" | "merge"
  | "workflows" | "mcps" | "plugins" | "market" | "hooks" | "permissions" | "env" | "api" | "settings";

export interface OpenTarget { kind: "skill" | "mcp" | "plugin" | "command"; key: string; ts: number; highlightCli?: string }

const RAIL_ICONS: Record<string, string> = {
  dashboard: "M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z",
  explorer: "M4 3h7l2 3h7v15H4z",
  search: "M11 4a7 7 0 105 12 7 7 0 00-5-12zm9 16l-4-4",
  plug: "M9 3v5M15 3v5M7 8h10v3a5 5 0 01-10 0zM12 16v5",
  puzzle: "M10 3h4v3a2 2 0 104 0V6h3v4h-2a2 2 0 100 4h2v4h-4v-2a2 2 0 10-4 0v2H6v-4h2a2 2 0 100-4H6V6h4z",
  merge: "M7 21V8M7 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM7 18.5a2.5 2.5 0 100 .01zM17 11a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM17 11c0 4-10 1.5-10 7.5",
  flow: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  profiles: "M12 2 3 7v10l9 5 9-5V7l-9-5z M12 2v20 M3 7l9 5 9-5",
  market: "M4 4h16l-1 5H5L4 4z M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9 M9 13h6",
  hook: "M18 7v6a6 6 0 01-12 0V7 M18 7a2 2 0 100-4 2 2 0 000 4z M12 19v2",
  lock: "M5 11h14v10H5z M8 11V7a4 4 0 018 0v4 M12 15v3",
  panel: "M4 4h16v16H4z M9 4v16",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM19 12a7 7 0 00-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 00-1.7-1L14.4 2H9.6L9.2 4.6a7 7 0 00-1.7 1l-2.4-1-2 3.4L5.1 11a7 7 0 000 2l-2 1.6 2 3.4 2.4-1a7 7 0 001.7 1l.4 2.6h4.8l.4-2.6a7 7 0 001.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z",
  key: "M7 18a3 3 0 100-6 3 3 0 000 6z M9.2 13.8 19 4 M16 5l2 2 M18.5 5.5l1.5 1.5",
  api: "M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12",
};

function Ico({ name }: { name: string }) {
  const fill = name === "dashboard";
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={RAIL_ICONS[name]} />
    </svg>
  );
}

/** Apply the persisted accent colour from Settings on first paint. */
function shade(hex: string, pct: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = pct / 100;
  r = Math.round(r + (pct < 0 ? r : 255 - r) * f);
  g = Math.round(g + (pct < 0 ? g : 255 - g) * f);
  b = Math.round(b + (pct < 0 ? b : 255 - b) * f);
  return "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
}

/**
 * Title-bar "update available" pill + maintainer broadcast. Shows when the npm
 * registry reports a newer cue-ai, or when the published package.json carries a
 * `cue.notice`. The popover gives the version delta, the message, and a
 * copy-to-clipboard install command. Renders nothing when up to date + no notice.
 */
function UpdatePill() {
  const { data } = useVersion();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!data || (!data.updateAvailable && !data.notice)) return null;
  const cmd = data.notice?.command || "npm i -g cue-ai@latest";
  const msg = data.notice?.message
    || (data.updateAvailable && data.latest ? `Update available — ${data.current} → ${data.latest}` : "");
  const copy = () => {
    try { navigator.clipboard.writeText(cmd); } catch { /* ignore */ }
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="tb-update-wrap">
      <button className="tb-update" onClick={() => setOpen((o) => !o)} title={data.updateAvailable ? "update available" : "announcement"}>
        <span className="tb-update-dot"></span>
        {data.updateAvailable && data.latest ? <>update <b>{data.latest}</b></> : "notice"}
      </button>
      {open && (
        <>
          <div className="tb-update-scrim" onClick={() => setOpen(false)}></div>
          <div className="tb-update-pop">
            {data.updateAvailable && data.latest && (
              <div className="tup-ver">{data.current} <span className="tup-arrow">→</span> <b>{data.latest}</b></div>
            )}
            {msg && <div className="tup-msg">{msg}</div>}
            <div className="tup-cmd">
              <span className="tup-prompt">$</span>
              <span className="tup-cmd-tx" title={cmd}>{cmd}</span>
              <span className="tup-copy" onClick={copy}>{copied ? "copied ✓" : "copy"}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Account dropdown behind the title-bar avatar. Stat tiles + footer read live
 * data (profiles, skills, cue version, connected host); menu items route to the
 * real views. The identity header (name / handle / tier) and the "published"
 * count are design placeholders — cue has no auth/identity or publish-count
 * source — surfaced verbatim so the menu matches the mock; swap when a real one
 * exists.
 */
function AccountMenu({
  profiles, skills, mcps, offline, connection, go,
}: {
  profiles: number | string;
  skills: number | string;
  mcps: number | string;
  offline: boolean;
  connection: string;
  go: (v: View) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: version } = useVersion();
  const ver = version?.current ?? "—";
  const route = (v: View, label: string, icon: string) => (
    <button className="acct-item" onClick={() => { setOpen(false); go(v); }}>
      <span className="acct-ic"><Ico name={icon} /></span>{label}
    </button>
  );
  return (
    <div className="tb-acct-wrap">
      <button className="tb-avatar" title="account" onClick={() => setOpen((o) => !o)}>cue</button>
      {open && (
        <>
          <div className="tb-update-scrim" onClick={() => setOpen(false)}></div>
          <div className="acct-pop">
            <div className="acct-head">
              <div className="acct-av">cue</div>
              <div>
                <div className="acct-name">cue workspace</div>
                <div className="acct-handle">local · cue studio</div>
              </div>
            </div>
            <div className="acct-stats">
              <div><b>{profiles}</b><span>profiles</span></div>
              <div><b>{skills}</b><span>skills</span></div>
              <div><b>{mcps}</b><span>mcps</span></div>
            </div>
            <div className="acct-sep"></div>
            {route("profiles", "My profiles", "profiles")}
            {route("market", "My marketplace items", "market")}
            {route("dashboard", "Dashboard", "dashboard")}
            <div className="acct-sep"></div>
            {route("settings", "Settings", "gear")}
            <div className="acct-item acct-static">
              <span className="acct-ic">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 010 18z" fill="currentColor" /></svg>
              </span>
              Theme<span className="acct-badge">dark</span>
            </div>
            <button className="acct-item" onClick={() => { window.open("https://github.com/opencue/cuecards", "_blank", "noopener"); setOpen(false); }}>
              <span className="acct-ic">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M9 7h8v8" /></svg>
              </span>
              Documentation
            </button>
            <div className="acct-foot">
              <span className="acct-foot-dot" style={offline ? { background: "var(--red)", boxShadow: "0 0 6px var(--red)" } : undefined}></span>
              {connection}<span className="acct-foot-sep">·</span>cue {ver}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export interface StudioAppProps {
  view?: View;
  onViewChange?: (view: View) => void;
}

/** Optional controlled navigation lets the hosted router own the URL. */
export function StudioApp({ view: controlledView, onViewChange }: StudioAppProps = {}) {
  const [localView, setLocalView] = useState<View>(() => isDemoMode() ? "welcome" : "inventory");
  const view = controlledView ?? localView;
  const setView = useCallback<Dispatch<SetStateAction<View>>>((next) => {
    const value = typeof next === "function" ? next(view) : next;
    if (controlledView === undefined) setLocalView(value);
    onViewChange?.(value);
  }, [controlledView, onViewChange, view]);
  if (view === "inventory") return <LocalInventory onAdvanced={() => setView("explorer")} />;
  return <StudioWorkspace view={view} setView={setView} />;
}

function StudioWorkspace({ view, setView }: { view: View; setView: Dispatch<SetStateAction<View>> }) {
  const publicMode = isDemoMode();
  const [railOpen, setRailOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<OpenTarget | null>(null);
  // The selected profile selector (e.g. "gstack+core"); null until /status loads.
  const [profile, setProfile] = useState<string | null>(null);

  const status = useStatus();
  const offline = status.isError && (status.error as Error).message.startsWith("dashboard-server-unreachable");
  const connection = publicMode ? "public · demo" : status.isSuccess ? "live · 127.0.0.1" : status.isError ? "local server unavailable" : "connecting to local Studio";

  // Default the selected profile to the resolved active one, once.
  useEffect(() => {
    if (!profile && status.data?.profile?.name) setProfile(status.data.profile.name);
  }, [status.data, profile]);

  const detail = useProfileDetail(profile ?? undefined);

  // Persisted accent (from Settings) → recolor on load.
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("cue-studio-settings") || "{}");
      if (s.accent) {
        const r = document.documentElement;
        r.style.setProperty("--violet", s.accent);
        r.style.setProperty("--violet-d", shade(s.accent, -20));
      }
    } catch { /* ignore */ }
  }, []);

  // ⌘K toggles the search view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setView((v) => (v === "search" ? "explorer" : "search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  const handleOpen = (kind: OpenTarget["kind"], key: string, highlightCli?: string) => {
    setPendingOpen({ kind, key, ts: Date.now(), highlightCli });
    setView("explorer");
  };

  // Top rail mirrors the design's `rail` array. hooks + permissions live in the
  // bottom group (next to settings), not here — see the rail-sp block below.
  const rail: [string, View, string][] = [
    ...(!publicMode ? [["dashboard", "inventory", "Local inventory"] as [string, View, string]] : []),
    ["profiles", "welcome", "Getting started"],
    ["explorer", "explorer", "Explorer"], ["dashboard", "dashboard", "Dashboard"],
    ["profiles", "profiles", "Profiles"], ["search", "search", "Search"],
    ["merge", "merge", "Merge studio"], ["flow", "workflows", "Workflows"],
    ["plug", "mcps", "MCP servers"], ["puzzle", "plugins", "Plugins"],
    ["market", "market", "Marketplace"],
  ];

  const counts = detail.data?.counts;
  const profileLabel = profile ?? "—";
  const partLabel = useMemo(() => (profile ? profile.split("+").slice(0, 2).join("+") + (profile.split("+").length > 2 ? "…" : "") : "—"), [profile]);

  const crumb = (() => {
    switch (view) {
      case "welcome": return <>community · <b>getting started</b></>;
      case "explorer": return <>profile explorer · <b>{profileLabel}</b></>;
      case "profiles": return <>inspect · <b>profiles</b></>;
      case "mcps": return <>servers · <b>mcp</b></>;
      case "merge": return <>compose · <b>merge studio</b></>;
      case "workflows": return <>automate · <b>workflows</b></>;
      case "plugins": return <>extensions · <b>plugins</b></>;
      case "market": return <>community · <b>marketplace</b></>;
      case "hooks": return <>automation · <b>hooks</b></>;
      case "permissions": return <>security · <b>permissions</b></>;
      case "env": return <>secrets · <b>environment</b></>;
      case "api": return <>account · <b>API tokens</b></>;
      case "search": return <>search · <b>workspace</b></>;
      case "settings": return <>preferences · <b>settings</b></>;
      default: return <>workspace · <b>overview</b></>;
    }
  })();

  return (
    <div className={"app" + (publicMode ? ` ${welcomeStyles.publicShell}` : "")}>
      {/* ── title bar ── */}
      <div className="titlebar">
        <div className="tb-brand" onClick={() => setView("dashboard")} title="cue studio — overview">
          <span className="tb-mark">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M16.6 7.4 A6.5 6.5 0 1 0 16.6 16.6" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" />
              <circle cx="17" cy="12" r="1.7" fill="#fff" />
            </svg>
          </span>
          <span className="tb-logo"><b>cue</b><span>studio</span></span>
        </div>
        <span className="tb-vsep"></span>
        <div className="tb-crumb">{crumb}</div>
        <div className="tb-spacer"></div>
        <div className="tb-right">
          <UpdatePill />
          <div className="tb-host" title={publicMode ? "Public demo — not connected to your computer" : connection}>
            <span className="tb-host-live" style={publicMode || !status.isSuccess ? { background: "var(--violet)", boxShadow: "none" } : undefined}></span>
            {connection}
          </div>
          <button className="tb-iconbtn" title="settings" onClick={() => setView("settings")}><Ico name="gear" /></button>
          <AccountMenu
            profiles={status.data?.totalProfiles ?? "—"}
            skills={counts?.skills ?? "—"}
            mcps={counts?.mcps ?? "—"}
            offline={offline}
            connection={connection}
            go={setView}
          />
        </div>
      </div>

      {/* ── body: rail + view ── */}
      <div className="body">
        <div className={"rail" + (railOpen ? " open" : "")}>
          <div className="rail-toggle" data-label={railOpen ? "Collapse" : "Expand"} onClick={() => setRailOpen((o) => !o)}>
            <Ico name="panel" />
            <span className="rail-label">close</span>
          </div>
          {rail.map(([ico, v, label]) => (
            <button key={v} style={{ background: "transparent", borderTop: 0, borderRight: 0, borderBottom: 0 }} className={"rail-btn" + (view === v ? " on" : "")} aria-label={label} aria-current={view === v ? "page" : undefined} data-label={label} onClick={() => setView(v)}>
              <Ico name={ico} />
              <span className="rail-label">{label}</span>
              {v === "mcps" && counts?.mcps ? <span className="rail-badge">{counts.mcps}</span> : null}
            </button>
          ))}
          <div className="rail-sp"></div>
          <div className={"rail-btn" + (view === "hooks" ? " on" : "")} data-label="Hooks" onClick={() => setView("hooks")}><Ico name="hook" /><span className="rail-label">Hooks</span></div>
          <div className={"rail-btn" + (view === "permissions" ? " on" : "")} data-label="Permissions" onClick={() => setView("permissions")}><Ico name="lock" /><span className="rail-label">Permissions</span></div>
          <div className={"rail-btn" + (view === "env" ? " on" : "")} data-label="Environment" onClick={() => setView("env")}><Ico name="key" /><span className="rail-label">Environment</span></div>
          <div className={"rail-btn" + (view === "api" ? " on" : "")} data-label="API tokens" onClick={() => setView("api")}><Ico name="api" /><span className="rail-label">API tokens</span></div>
          <div className={"rail-btn" + (view === "settings" ? " on" : "")} data-label="Settings" onClick={() => setView("settings")}><Ico name="gear" /><span className="rail-label">Settings</span></div>
        </div>

        <div className="view">
          {view === "welcome" ? (
            <Welcome onBrowse={() => setView("market")} />
          ) : view === "market" && (publicMode || offline) ? (
            <MarketView />
          ) : view === "api" ? (
            // Auth/token management is independent of the local dashboard
            // server, so it stays available even when that server is offline.
            <ApiView />
          ) : offline ? (
            <OfflineBanner message={(status.error as Error).message} />
          ) : (
            <>
              <div className="exp-host" style={{ display: view === "explorer" ? "flex" : "none" }}>
                <Explorer profile={profile} setProfile={setProfile} pendingOpen={pendingOpen} />
              </div>
              {view === "dashboard" && <Dashboard profile={profile} status={status.data} />}
              {view === "profiles" && <ProfilesView active={profile} setProfile={setProfile} onOpen={handleOpen} />}
              {view === "merge" && <MergeView />}
              {view === "workflows" && <WorkflowsView profile={profile} />}
              {view === "mcps" && <McpsView profile={profile} />}
              {view === "plugins" && <PluginsView profile={profile} />}
              {view === "market" && <MarketView />}
              {view === "hooks" && <HooksView profile={profile} />}
              {view === "permissions" && <PermissionsView />}
              {view === "env" && <EnvView profile={profile} />}
              {view === "settings" && <SettingsView />}
              {view === "search" && <SearchView profile={profile} onOpen={handleOpen} setView={setView} />}
            </>
          )}
        </div>
      </div>

      {/* ── status bar ── */}
      <div className="statusbar">
        <div className="sb-seg accent">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM6 6a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9c0 6-12 2-12 8" /></svg>
          {publicMode ? "public site · Studio previews use sample data" : status.data?.source && status.data.source !== "none" ? status.data.source : "workspace"}
        </div>
        <div className="sb-seg ok-seg">
          <span className="sb-dot" style={{ background: status.data?.gates?.overall === "fail" ? "var(--red)" : "var(--green)", boxShadow: "0 0 5px rgba(62,207,142,.7)" }}></span>
          {status.data?.gates ? (status.data.gates.overall === "fail" ? `${status.data.gates.failed.length} gate fail` : "gates pass") : "gates —"}
        </div>
        <div className="sb-seg"><span className="sb-dot violet"></span>{partLabel}</div>
        <div className="sb-spacer"></div>
        <div className="sb-seg metrics">
          <b>{counts?.skills ?? "—"}</b>&nbsp;skills<span className="sb-dim">·</span>
          <b>{counts?.mcps ?? "—"}</b>&nbsp;mcps<span className="sb-dim">·</span>
          <b>{counts?.plugins ?? "—"}</b>&nbsp;plugins
        </div>
        <div className="sb-seg">UTF-8</div>
        <div className="sb-seg">Markdown</div>
        <div className="sb-seg ver"><span className="sb-live"></span>cue&nbsp;studio</div>
      </div>
    </div>
  );
}
