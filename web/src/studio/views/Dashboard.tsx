/**
 * Dashboard — the redesigned overview. SCALE / USAGE / HEALTH bands, an
 * activity area chart, the active-profiles composite table, and the live
 * agent-sessions list with stop buttons. Ported from studio-dashboard.jsx;
 * every number is live from /status, /telemetry/timeline, /active-sessions.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useProfileDetail, useTimeline, useActiveSessions, postJson, type StatusData, type TimelineData } from "../api";
import { partEmoji, fmtDuration, fmtAge, abbrev } from "../curated";
import { isDemoMode } from "../../lib/fetcher";

/** Honor the OS "reduce motion" setting: no pulsing dot, no radar ping. */
const REDUCED_MOTION =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

/**
 * Linear-interpolate a series to exactly `n` points. The design resamples the
 * raw daily counts up to a fixed resolution (64 for 30d) before drawing, so the
 * midpoint-cubic below flows smoothly instead of zig-zagging between ~30 daily
 * samples. Empty → empty; single point → flat line.
 */
function resample(arr: number[], n: number): number[] {
  if (arr.length === 0) return [];
  if (arr.length === 1) return Array(n).fill(arr[0]!);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (arr.length - 1);
    const a = Math.floor(t), b = Math.min(arr.length - 1, a + 1), f = t - a;
    out.push(arr[a]! + (arr[b]! - arr[a]!) * f);
  }
  return out;
}

function areaPath(data: number[], w: number, h: number, pad: number) {
  // ×1.12 headroom (per the design): keeps the peak off the ceiling so a spiky
  // day reads as a rounded crest, not a needle pinned to the top edge.
  const max = Math.max(1, ...data) * 1.12;
  const n = Math.max(2, data.length);
  const x = (i: number) => pad + (i / (n - 1)) * (w - pad * 2);
  const y = (v: number) => (h - pad) - (v / max) * (h - pad * 1.42);
  const pts = data.map((v, i) => [x(i), y(v)] as const);
  if (!pts.length) return { line: "", area: "", last: [pad, h - pad] as const };
  let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[i + 1]!;
    const mx = (x0 + x1) / 2;
    d += ` C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}`;
  }
  const area = `${d} L ${pts[n - 1]?.[0] ?? pts[pts.length - 1]![0]} ${h - pad} L ${pts[0]![0]} ${h - pad} Z`;
  return { line: d, area, last: pts[pts.length - 1]! };
}

function Stat({ n, label, accent }: { n: React.ReactNode; label: string; accent?: string }) {
  return (
    <div className="stat">
      <div className={"stat-n" + (accent ? " " + accent : "")}>{n}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}

function BandIco({ type }: { type: "scale" | "usage" | "health" }) {
  const p = {
    scale: "M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z",
    usage: "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z",
    health: "M3 12h4l2 6 4-14 2 8h6",
  }[type];
  return <span className="band-ic"><svg width="14" height="14" viewBox="0 0 24 24" fill={type === "scale" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={p} /></svg></span>;
}

function MiniSpark({ data }: { data: number[] }) {
  const d = data.slice(-16), w = 128, h = 44, max = Math.max(1, ...d);
  if (d.length < 2) return <svg className="mini-spark" viewBox={`0 0 ${w} ${h}`} />;
  const pts = d.map((v, i) => [(i / (d.length - 1)) * w, h - 3 - (v / max) * (h - 8)] as const);
  let path = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) { const mx = (pts[i]![0] + pts[i + 1]![0]) / 2; path += ` C ${mx} ${pts[i]![1]}, ${mx} ${pts[i + 1]![1]}, ${pts[i + 1]![0]} ${pts[i + 1]![1]}`; }
  return (
    <svg className="mini-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--violet)" stopOpacity=".32" /><stop offset="100%" stopColor="var(--violet)" stopOpacity="0" /></linearGradient></defs>
      <path d={`${path} L ${w} ${h} L 0 ${h} Z`} fill="url(#mg)" />
      <path d={path} fill="none" stroke="var(--violet)" strokeWidth="1.7" />
    </svg>
  );
}

export function Dashboard({ profile, status }: { profile: string | null; status?: StatusData }) {
  const qc = useQueryClient();
  const demo = isDemoMode();
  const [range, setRange] = useState<7 | 30 | 90>(30);
  // Reduced-motion users retain live data and the pause control, without animation.
  const [paused, setPaused] = useState(false);
  const chartLive = !demo && !paused && !REDUCED_MOTION;
  const [stopError, setStopError] = useState<string | null>(null);
  const detail = useProfileDetail(profile ?? undefined);
  // SSE drives live updates; the poll is just a slow safety net (and the only
  // source in demo mode / if EventSource is unavailable). Frozen when paused.
  const timeline = useTimeline(range, paused ? false : 30000);
  const sessions = useActiveSessions();

  // Live activity push: stream timeline updates over SSE straight into the query
  // cache. The "live"/"paused" pill opens/closes the socket. EventSource
  // auto-reconnects on transient errors; the 30s poll above covers a hard drop.
  useEffect(() => {
    if (paused || isDemoMode() || typeof EventSource === "undefined") return;
    const es = new EventSource(`/api/v1/telemetry/stream?since=${range}`);
    es.addEventListener("timeline", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as TimelineData;
        qc.setQueryData(["timeline", range], data);
      } catch { /* ignore a malformed frame; the next one replaces it */ }
    });
    return () => es.close();
  }, [paused, range, qc]);

  const counts = detail.data?.counts;
  const daily = timeline.data?.daily ?? [];
  const activity = daily.map((d) => d.sessions);
  const W = 1000, H = 260, P = 24;
  // Resample to the design's per-range resolution for a smooth curve. Only the
  // *chart* uses this — counts/spark stay on the raw daily series so the
  // "N sessions" total is the real sum, not a resampling artefact.
  const COUNT = range === 7 ? 28 : range === 90 ? 120 : 64;
  const chartData = activity.length >= 2 ? resample(activity, COUNT) : activity;
  const p = areaPath(chartData, W, H, P);

  // ~8 evenly-spaced day labels (MM-DD).
  const labelCount = Math.min(8, daily.length);
  const dayLabels = labelCount
    ? Array.from({ length: labelCount }, (_, i) => {
        const idx = labelCount === 1 ? 0 : Math.round((i / (labelCount - 1)) * (daily.length - 1));
        return daily[idx]?.date.slice(5) ?? "";
      })
    : [];

  const durations = status?.durations;
  const totalSessions = status?.totalSessions ?? 0;
  const windowSessions = activity.reduce((a, v) => a + v, 0);
  const gate = status?.gates?.overall;
  const gateColor = gate === "pass" ? "var(--green)" : gate === "fail" ? "var(--red)" : "var(--fg3)";
  const gateMark = gate === "pass" ? "✓" : gate === "fail" ? "!" : "—";

  // Leaderboard: sessions-per-profile from the telemetry window, ranked.
  const leaderboard = [...(timeline.data?.profiles ?? [])].sort((a, b) => b.sessions - a.sessions).slice(0, 7);
  const lbMax = Math.max(1, ...leaderboard.map((l) => l.sessions));

  const live = sessions.data?.supported ? sessions.data.sessions : [];

  const stop = async (pid: number) => {
    setStopError(null);
    try { await postJson("/sessions/kill", { pid }); await qc.invalidateQueries({ queryKey: ["active-sessions"] }); }
    catch (error) { setStopError(error instanceof Error ? error.message : "Could not stop the session."); }
  };

  return (
    <div className="dash">
      {demo && <div className="ap-note" role="status">Sample data — demo profiles and activity, not your local workspace.</div>}
      {/* top metric bands */}
      <div className="bands">
        <div className="band">
          <div className="band-top"><BandIco type="scale" /><span className="band-h">Scale</span><span className="band-tag">workspace</span></div>
          <div className="scale-grid">
            <div className="mtile"><div className="mt-n">{status?.totalProfiles ?? "—"}</div><div className="mt-l">profiles</div></div>
            <div className="mtile"><div className="mt-n violet">{counts?.skills ?? "—"}</div><div className="mt-l">skills</div></div>
            <div className="mtile"><div className="mt-n">{counts?.mcps ?? "—"}</div><div className="mt-l">mcps</div></div>
            <div className="mtile"><div className="mt-n">{counts?.plugins ?? "—"}</div><div className="mt-l">plugins</div></div>
          </div>
        </div>
        <div className="band">
          <div className="band-top"><BandIco type="usage" /><span className="band-h">Usage</span><span className="band-tag">{range}d</span></div>
          <div className="usage-main">
            <div className="usage-hero"><div className="mt-n">{timeline.data ? abbrev(windowSessions) : "—"}</div><div className="mt-l">sessions</div></div>
            <MiniSpark data={activity} />
          </div>
          <div className="usage-sub">
            <span><b>{durations ? fmtDuration(durations.avgS) : "—"}</b> all-time avg</span><span className="dotsep">·</span>
            <span><b>{durations ? fmtDuration(durations.totalS) : "—"}</b> all-time tracked</span>
          </div>
        </div>
        <div className="band">
          <div className="band-top"><BandIco type="health" /><span className="band-h">Health</span><span className={"band-tag" + (gate === "pass" ? " ok" : "")}>{gate === "pass" ? "● pass" : gate === "fail" ? "● fail" : "not checked"}</span></div>
          <div className="health-main">
            <div className="ring-wrap">
              <svg className="ring" viewBox="0 0 74 74">
                <circle className="ring-bg" cx="37" cy="37" r="31" />
                <circle className="ring-fg" cx="37" cy="37" r="31" strokeDasharray="194.8" strokeDashoffset="0" transform="rotate(-90 37 37)" style={{ stroke: gateColor }} />
              </svg>
              <div className="ring-check" style={{ color: gateColor }}>{gateMark}</div>
            </div>
            <div className="health-rows">
              <div className="hrow"><span className="hdot" style={{ background: gateColor }}></span>Gates <b>{gate === "pass" ? "passed" : gate === "fail" ? "failing" : "not checked"}</b></div>
              <div className="hrow"><span className="hdot"></span><b>{status?.warnings?.length ?? "—"}</b> warnings</div>
              <div className="hrow"><span className="hdot"></span>Telemetry <b>{status ? (status.telemetryEnabled ? "on" : "off") : "—"}</b></div>
            </div>
          </div>
        </div>
      </div>

      {/* activity chart */}
      <div className="card chart-card">
        <div className="card-head">
          <div>
            <div className="card-title">
              Activity over time
              {!demo && (
                <button type="button"
                  className={"chart-live" + (paused ? " off" : "")}
                  onClick={() => setPaused((v) => !v)}
                  aria-pressed={!paused}
                  title={paused ? "resume live updates" : "pause live updates"}
                >
                  <span className="cl-dot" />{paused ? "paused" : "live"}
                </button>
              )}
            </div>
            <div className="card-sub">{timeline.data ? <><b>{windowSessions}</b> sessions · last {range}d</> : timeline.isError ? "Activity unavailable" : "Loading activity…"}</div>
          </div>
          <div className="seg">
            {([7, 30, 90] as const).map((r) => <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}d</button>)}
            <span className="seg-link">cue stats</span>
          </div>
        </div>
        {timeline.isError && <div className="ap-note" role="alert">Could not load activity: {timeline.error.message} <button type="button" onClick={() => void timeline.refetch()}>Retry activity</button></div>}
        {timeline.data && daily.length === 0 && <div className="ap-note">No activity recorded in this period.</div>}
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--violet)" stopOpacity="0.34" />
              <stop offset="100%" stopColor="var(--violet)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={P} x2={W - P} y1={(H - P) - f * (H - P * 1.4)} y2={(H - P) - f * (H - P * 1.4)} className="grid" />)}
          {p.area && <path d={p.area} fill="url(#g)" />}
          {p.line && <path d={p.line} className="chart-line" />}
          {p.line && chartLive && <circle cx={p.last[0]} cy={p.last[1]} r="3.5" className="chart-pulse" />}
          {p.line && <circle cx={p.last[0]} cy={p.last[1]} r="3.5" className="chart-dot" />}
        </svg>
        <div className="chart-x">{dayLabels.map((d, i) => <span key={i}>{d}</span>)}</div>
      </div>

      {/* active profiles */}
      <div className="card">
        <div className="card-head">
          <div className="card-title"><span className="live-dot"></span>Active profile <span className="ct-muted">({status?.parts?.length || 1})</span></div>
          <span className="seg-link">cue status</span>
        </div>
        <div className="ap-name">{status?.profile?.name ?? profile ?? "—"}</div>
        <div className="ap-blurb">{status?.profile?.description ?? ""}</div>
        {status?.parts && status.parts.length > 0 && (
          <table className="ap-table">
            <thead><tr><th>profile</th><th>skills</th><th>mcps</th><th>plugins</th></tr></thead>
            <tbody>
              {status.parts.map((pt) => (
                <tr key={pt.name}><td className="mono">{pt.name}</td><td>{pt.skills}</td><td>{pt.mcps}</td><td>{pt.plugins}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="ap-note">Per-part counts are pre-dedupe. Totals below reflect the merged composite.</div>
        <div className="ap-totals">
          <Stat n={counts?.skills ?? status?.profile?.skills ?? "—"} label="total skills" accent="violet" />
          <Stat n={counts?.mcps ?? status?.profile?.mcps ?? "—"} label="total mcps" />
          <Stat n={counts?.plugins ?? status?.profile?.plugins ?? "—"} label="plugins" />
          <Stat n={abbrev(totalSessions)} label="sessions" />
          <Stat n={status?.warnings?.length ?? 0} label="warnings" accent="green" />
          <Stat n={<span style={{ color: gateColor }}>{gateMark}</span>} label="gates" />
        </div>
      </div>

      {/* sessions */}
      <div className="card">
        <div className="card-head">
          <div className="card-title"><span className="live-dot"></span>{demo ? "Sample agent sessions" : "Active agent sessions"} <span className="ct-muted">({sessions.data ? live.length : "—"})</span></div>
          <span className="seg-link">cue dashboard</span>
        </div>
        {leaderboard.length > 0 && (
          <div className="sessboard">
            {leaderboard.map((row, i) => {
              const parts = row.profile.split("+");
              const rank = ["🥇", "🥈", "🥉"][i] || "▸";
              return (
                <div className="sb-row" key={row.profile}>
                  <div className="sb-rank">{rank}</div>
                  <div className="sb-parts">
                    {parts.slice(0, 4).map((pt, j) => <span className="sb-chip" key={j}><span className="sb-emoji">{partEmoji(pt)}</span>{pt}</span>)}
                    {parts.length > 4 && <span className="sb-more">+ more</span>}
                  </div>
                  <div className="sb-bar"><span style={{ width: (row.sessions / lbMax * 100) + "%" }}></span></div>
                  <div className="sb-count">×{row.sessions}</div>
                </div>
              );
            })}
          </div>
        )}
        {stopError && <div className="ap-note" role="alert">{stopError}</div>}
        {sessions.isError && <div className="ap-note" role="alert">Could not load sessions: {sessions.error.message} <button type="button" onClick={() => void sessions.refetch()}>Retry sessions</button></div>}
        {!sessions.data ? (
          !sessions.isError && <div className="ap-note" role="status">Loading sessions…</div>
        ) : !sessions.data.supported ? (
          <div className="ap-note">Live session scan needs Linux /proc — not available on this platform.</div>
        ) : live.length === 0 ? (
          <div className="ap-note">No live cue-launched sessions right now.</div>
        ) : (
          <div className="sess-list">
            <div className="sess-head">
              <span>profile</span><span>working dir</span><span>pid</span><span>uptime</span><span></span>
            </div>
            {live.map((s) => {
              const cwd = s.cwd ?? "";
              const folder = cwd.split("/").pop() ?? "";
              const base = cwd.slice(0, cwd.length - folder.length);
              const up = fmtAge(s.startedAt);
              // green only for sub-30-minute sessions; the "^\d+m$" guard keeps
              // "1h 04m" out (parseInt would otherwise read the leading hour as <30).
              const fresh = up.includes("now") || (/^\d+m$/.test(up) && parseInt(up) < 30);
              return (
                <div className="srow" key={s.pid}>
                  <div className="sr-prof"><span className="sr-pulse"></span><span className="sr-pname" title={s.profile}>{s.profile}</span></div>
                  <div className="sr-cwd" title={cwd || undefined}>
                    {cwd
                      ? <><span className="sr-base">{base}</span><span className="sr-folder">{folder}</span></>
                      : <span className="sr-base">—</span>}
                  </div>
                  <div className="sr-pid">{s.pid}</div>
                  <div className="sr-up"><span className={"sr-upbadge" + (fresh ? " fresh" : "")}>{up}</span></div>
                  <div className="sr-act"><button className="sr-stop" disabled={demo} title={demo ? "Run cue locally to manage sessions" : undefined} onClick={() => stop(s.pid)}>stop</button></div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
