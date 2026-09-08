import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InventoryItem, LocalInventoryData } from "../../../src/lib/local-inventory-types";
import { fetcher } from "../lib/fetcher";
import s from "./LocalInventory.module.css";

type Kind = InventoryItem["kind"] | "all";
type State = InventoryItem["state"] | "all" | "local";
const kinds = [["all", "Everything", "◈"], ["profile", "Profiles", "▦"], ["skill", "Skills", "◇"], ["mcp", "MCPs", "⇄"]] as const;
const states: State[] = ["local", "all", "installed", "configured", "available", "referenced", "unreadable"];
const labels = { local: "Local files & configs", all: "All states", installed: "On disk", configured: "Configured", available: "Catalog", referenced: "Reference only", unreadable: "Unreadable" };

export function selectInventoryItems(items: InventoryItem[], kind: Kind, query: string, state: State) {
  const search = query.trim().toLocaleLowerCase();
  return items.filter(item => (kind === "all" || item.kind === kind) && (state === "all" || (state === "local" ? item.state === "installed" || item.state === "configured" || item.state === "unreadable" : item.state === state)) &&
    (!search || [item.name, item.description, item.path ?? "", ...item.sources].some(value => value.toLocaleLowerCase().includes(search))))
    .sort((a, b) => Number(a.state === "referenced") - Number(b.state === "referenced") ||
      ["profile", "skill", "mcp"].indexOf(a.kind) - ["profile", "skill", "mcp"].indexOf(b.kind) || a.name.localeCompare(b.name));
}

export function LocalInventory({ onAdvanced }: { onAdvanced: () => void }) {
  const result = useQuery({ queryKey: ["local-inventory"], queryFn: () => fetcher<LocalInventoryData>("/inventory"), staleTime: 60_000, retry: false });
  if (!result.data) return <main className={s.loading}>
    <span className={s.wordmark}>cue <b>studio</b></span>
    <h1>{result.isError ? "Local inventory unavailable" : "Reading your local toolkit…"}</h1>
    <p>{result.isError ? "The local server must support /api/v1/inventory. Start the updated cue dashboard and retry." : "Reading profiles, skill metadata and MCP names. No servers are started."}</p>
    {result.isError && <button onClick={() => void result.refetch()}>Retry</button>}
    <button onClick={onAdvanced}>Advanced tools</button>
  </main>;
  return <InventoryContent data={result.data} refreshing={result.isFetching} refreshFailed={result.isError} onRefresh={() => void result.refetch()} onAdvanced={onAdvanced} />;
}

export function InventoryContent({ data, refreshing, refreshFailed = false, onRefresh, onAdvanced }: {
  data: LocalInventoryData; refreshing: boolean; refreshFailed?: boolean; onRefresh: () => void; onAdvanced: () => void;
}) {
  const [kind, setKind] = useState<Kind>("all");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>("local");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [limit, setLimit] = useState(60);
  const [showSources, setShowSources] = useState(false);
  const matches = useMemo(() => selectInventoryItems(data.items, kind, query, state), [data.items, kind, query, state]);
  const selected = data.items.find(item => item.id === selectedId);
  const related = selected ? data.items.filter(item => selected.related.includes(item.id)) : [];
  const connectionGroups = new Map<string, InventoryItem[]>();
  for (const item of related) {
    const key = `${item.kind}:${item.name}`;
    connectionGroups.set(key, [...(connectionGroups.get(key) ?? []), item]);
  }
  const renderConnection = (item: InventoryItem) => <button key={item.id} onClick={() => setSelectedId(item.id)}><span aria-hidden="true">↳</span><span><strong>{item.name}</strong><small>{item.kind} · {labels[item.state]}</small>{item.kind === "mcp" && <small className={s.connectionSource} title={item.sources[0]}>{item.sources[0]}</small>}</span><span aria-hidden="true">↗</span></button>;
  const count = (k: Kind) => selectInventoryItems(data.items, k, "", state).length;
  const sourceIssues = data.sources.filter(source => source.state === "partial" || source.state === "unreadable").length;
  const chooseKind = (value: Kind) => { setKind(value); setLimit(60); };
  return <div className={s.shell}>
    <header className={s.header}>
      <span className={s.wordmark}>cue <b>studio</b><span className={s.local}>LOCAL INVENTORY</span></span>
      <div className={s.actions}><button onClick={onRefresh} disabled={refreshing}>{refreshing ? "Scanning…" : "↻ Refresh"}</button><button onClick={onAdvanced}>Advanced tools ↗</button></div>
    </header>
    <div className={s.layout}>
      <nav className={s.nav} aria-label="Local inventory categories">
        <p className={s.eyebrow}>YOUR MACHINE</p>
        {kinds.map(([value, label, icon]) => <button key={value} aria-current={kind === value ? "page" : undefined} onClick={() => chooseKind(value)}><span aria-hidden="true">{icon}</span>{label}<small>{count(value).toLocaleString()}</small></button>)}
        <div className={s.navFoot}><span className={s.dot} /> Read-only discovery<p>Local files, not a marketplace.<br />Nothing starts or installs here.</p><button onClick={() => setShowSources(x => !x)}>Scan coverage {sourceIssues > 0 ? `· ${sourceIssues} partial/issues` : "↗"}</button></div>
      </nav>
      <main className={s.main}>
        <div className={s.intro}><p className={s.eyebrow}>LESS NOISE. MORE CONTEXT.</p><h1>Your local toolkit<span>.</span></h1><p>See what is here, where it comes from, and how it connects.</p></div>
        <div className={s.cards}>
          {kinds.slice(1).map(([value, label, icon]) => <button key={value} onClick={() => chooseKind(value)} aria-pressed={kind === value}>
            <span className={s.cardLabel}>{label}<span aria-hidden="true">{icon}</span></span><strong>{count(value).toLocaleString()}</strong><small>{value === "profile" ? "Resolved Cue definitions" : value === "skill" ? "Skill files · filter to include references" : "MCP config occurrences · not live status"}</small>
          </button>)}
        </div>
        {refreshFailed && <p role="alert" className={s.warning}>Refresh failed. Showing the last successful scan; these results may be stale.</p>}
        {showSources && <section className={s.coverage} aria-label="Scan coverage"><h2>What this scan covers</h2><p>Cue's profile/library roots, Claude and Codex homes and plugin caches, Cue’s npx cache and generated runtimes, and this workspace's agent folders. Cursor MCP JSON is included. Not a full-disk scan.</p><p>TOML coverage is partial: standard MCP table declarations only. Inline tables, other apps, inline plugin MCPs and other projects' scoped configurations may be absent. Configured does not mean enabled, connected or healthy.</p><p>Symlinked skills are deduplicated by real file. Same-named MCPs in different files stay separate. Profile links match MCP names, not effective runtime selection. Remote skill references are not proof of installation.</p><ul>{data.sources.map((source, index) => <li key={`${source.path}:${index}`}><code>{source.path}</code><span>{source.state}</span></li>)}</ul></section>}
        <section className={s.catalog} aria-label="Inventory">
          <div className={s.toolbar}><label className={s.searchBox}><span aria-hidden="true">⌕</span><input aria-label="Search local inventory" placeholder="Search names, descriptions or paths…" value={query} onChange={e => { setQuery(e.target.value); setLimit(60); }} />{query && <button aria-label="Clear search" onClick={() => { setQuery(""); setLimit(60); }}>×</button>}</label><select aria-label="Filter inventory state" value={state} onChange={e => { setState(e.target.value as State); setLimit(60); }}>{states.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></div>
          <div className={s.resultHeader}><h2>{kinds.find(([value]) => value === kind)?.[1]}</h2><span role="status">{matches.length.toLocaleString()} results</span></div>
          <div className={`${s.browser} ${selected ? s.withDetail : ""}`}>
            <div className={s.results}>
              {matches.length === 0 ? <div className={s.empty}><h3>No matching items</h3><p>Try another name or clear the filters.</p><button onClick={() => { setQuery(""); setState("all"); chooseKind("all"); }}>Clear filters</button></div> : matches.slice(0, limit).map(item => <button className={s.row} key={item.id} aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)}>
                <span className={`${s.kindIcon} ${s[item.kind]}`} aria-hidden="true">{kinds.find(([value]) => value === item.kind)?.[2]}</span><span className={s.rowText}><strong>{item.name}</strong><small>{(item.kind === "mcp" ? item.sources[0] : item.description) || item.description || "No description"}</small></span><span className={s.badge}>{labels[item.state]}</span><span className={s.linkCount} title="Relationships">{item.related.length} ↗</span>
              </button>)}
              {matches.length > limit && <button className={s.more} onClick={() => setLimit(x => x + 60)}>Show more · {matches.length - limit} remaining</button>}
            </div>
            {selected && <aside className={s.detail} aria-label="Item details"><div className={s.detailTop}><span className={s.eyebrow}>{selected.kind} / {labels[selected.state]}</span><button aria-label="Close details" onClick={() => setSelectedId(null)}>×</button></div><h2>{selected.name}</h2><p>{selected.description || "No description provided."}</p><h3>Found in</h3>{selected.sources.length ? selected.sources.map(source => <code className={s.path} key={source}>{source}</code>) : <p>Reference only; no local source resolved.</p>}{selected.path && <code className={s.path}>{selected.path}</code>}<h3>Connections <small>{related.length}</small></h3><p className={s.hint}>{selected.kind === "profile" ? "Resolved skill references and matching MCP names." : "Profiles referring to this skill or MCP name."}</p>{related.length === 0 ? <p>No profile connections found.</p> : <div className={s.connections}>{[...connectionGroups.entries()].map(([key, group]) => group.length === 1 ? renderConnection(group[0]!) : <details key={key}><summary>{group[0]!.name} <small>{group.length} sources</small></summary>{group.map(renderConnection)}</details>)}</div>}</aside>}
          </div>
        </section>
        <footer className={s.footer}><span>Scanned {new Date(data.scannedAt).toLocaleString()} · {data.sources.filter(x => x.state !== "missing").length} sources found</span><button onClick={() => setShowSources(x => !x)}>{showSources ? "Hide" : "View"} scan coverage</button></footer>
      </main>
    </div>
  </div>;
}
