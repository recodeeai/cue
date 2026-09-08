/**
 * Cue Marketplace — community registry of profiles, workflows, skills, CLIs,
 * MCPs & plugins. Star (persists to localStorage), install into one of your
 * profiles, and publish your own. The browse list is the locally-published
 * drafts (kept in localStorage) prepended onto the live /market catalog
 * (useMarket), so a fresh checkout shows the real registry, never a fixture.
 *
 * Ported faithfully from the design prototype studio-market.jsx — all of its
 * marketpage / mk-* class names are preserved so the studio CSS (ported
 * separately) applies. Publish is phase-1: it optimistically prepends a local
 * "yours" item and toasts that a registry PR will open later.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useMarket, useProfilesFull, installMarketItem, type MarketItem } from "../api";
import { useCommunityMarket, publishCommunity } from "../../lib/market-client";
import { useSession } from "../../lib/auth-client";
import { isDemoMode } from "../../lib/fetcher";
import { profileInstallCommand } from "../../../lib/profile-source";

// A locally-published draft is a MarketItem with the extra "yours" marker. Kept
// in localStorage and prepended to the browse list before the live catalog.
interface LocalMarketItem extends MarketItem {
  mine?: boolean;
}

type MarketType = MarketItem["type"];

const TYPE: Record<MarketType, { label: string; color: string; glyph: string }> = {
  profile: { label: "profile", color: "#8b7bf0", glyph: "⎇" },
  workflow: { label: "workflow", color: "#e0913a", glyph: "⚡" },
  skill: { label: "skill", color: "#3ecf8e", glyph: "◆" },
  cli: { label: "cli", color: "#56b6c2", glyph: "›_" },
  mcp: { label: "mcp", color: "#5b9cf0", glyph: "🔌" },
  plugin: { label: "plugin", color: "#c264c2", glyph: "🧩" },
};
const TYPE_KEYS = Object.keys(TYPE) as MarketType[];

const STARS_KEY = "cue-market-stars";
const PUB_KEY = "cue-market-pub";

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "") as T;
  } catch {
    return fallback;
  }
}

type SortKey = "trending" | "stars" | "new";
const SORT_OPTS: [SortKey, string, string][] = [
  ["trending", "Trending", "↗"],
  ["stars", "Most stars", "★"],
  ["new", "Newest", "✦"],
];

function daysAgo(when: string): number {
  if (when === "now") return 0;
  const n = parseInt(when, 10) || 0;
  if (when.includes("w")) return n * 7;
  if (when.includes("h")) return n / 24;
  return n;
}

export function MarketView() {
  const publicMode = isDemoMode();
  const qc = useQueryClient();
  const { data } = useMarket();
  const community = useCommunityMarket();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const profilesQ = useProfilesFull();

  const [q, setQ] = useState("");
  const [type, setType] = useState<MarketType | "all">("all");
  const [sort, setSort] = useState<SortKey>("trending");
  const [stars, setStars] = useState<string[]>(() => readJson<string[]>(STARS_KEY, []));
  const [published, setPublished] = useState<LocalMarketItem[]>(() => readJson<LocalMarketItem[]>(PUB_KEY, []));
  const [pubOpen, setPubOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [addFor, setAddFor] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);

  useEffect(() => { try { localStorage.setItem(STARS_KEY, JSON.stringify(stars)); } catch { /* ignore */ } }, [stars]);
  useEffect(() => { try { localStorage.setItem(PUB_KEY, JSON.stringify(published)); } catch { /* ignore */ } }, [published]);
  useEffect(() => {
    if (!addFor) return;
    const c = () => setAddFor(null);
    window.addEventListener("click", c);
    return () => window.removeEventListener("click", c);
  }, [addFor]);
  useEffect(() => {
    if (!sortOpen) return;
    const c = () => setSortOpen(false);
    window.addEventListener("click", c);
    return () => window.removeEventListener("click", c);
  }, [sortOpen]);

  const starred = new Set(stars);
  const toggleStar = (id: string) => setStars((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2600); };
  async function copyCommand(command: string) {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      flash("Copied — inspect the source before running this command locally.");
    } catch {
      flash("Clipboard unavailable. Select and copy the displayed command.");
    }
  }

  // Install an item into a real profile (edits profile.yaml server-side). A
  // bare CLI has no profile.yaml home — its `manual` command is copied instead.
  async function install(i: LocalMarketItem, profile: string) {
    if (i.mine) { flash("Local drafts can't be installed yet — publish opens a registry PR"); return; }
    const key = i.id + "→" + profile;
    setInstalling(key);
    try {
      const r = await installMarketItem(i, profile);
      if (r.manual) {
        try { await navigator.clipboard.writeText(r.manual.command); } catch { /* ignore */ }
        flash(`${i.name}: ${r.manual.command} — copied`);
      } else if (r.alreadyPresent) {
        flash(`${i.name} already in ${profile}`);
      } else {
        flash(`${i.name} → added to ${profile} · relaunch cue to load`);
      }
      // Reflect the new membership across the studio.
      qc.invalidateQueries({ queryKey: ["profiles-full"] });
      qc.invalidateQueries({ queryKey: ["profile-detail"] });
      qc.invalidateQueries({ queryKey: ["market"] });
    } catch (err) {
      flash(`Install failed: ${(err as Error).message}`);
    } finally {
      setInstalling(null);
    }
  }

  // Browse list: the user's local drafts on top, then the hosted community
  // submissions (what everyone pushed), then this checkout's live catalog.
  // Never the prototype SEED — a fresh checkout shows exactly what the APIs
  // return. Community items the signed-in user owns are flagged "yours".
  const myHandle = session?.user?.name || session?.user?.email?.split("@")[0] || null;
  const items: LocalMarketItem[] = useMemo(() => {
    const communityItems: LocalMarketItem[] = (community.data ?? []).map((i) => ({
      ...i,
      mine: myHandle != null && i.handle === myHandle,
    }));
    return [...published, ...communityItems, ...(publicMode ? [] : data?.items ?? [])];
  }, [published, community.data, data, myHandle, publicMode]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    TYPE_KEYS.forEach((t) => { c[t] = items.filter((i) => i.type === t).length; });
    return c;
  }, [items]);

  const shown = useMemo(() => {
    let list = items.filter((i) => type === "all" || i.type === type);
    const ql = q.trim().toLowerCase();
    if (ql) {
      list = list.filter(
        (i) =>
          i.name.toLowerCase().includes(ql) ||
          i.desc.toLowerCase().includes(ql) ||
          i.tags.some((t) => t.toLowerCase().includes(ql)) ||
          i.handle.toLowerCase().includes(ql),
      );
    }
    const eff = (i: LocalMarketItem) => i.stars + (starred.has(i.id) ? 1 : 0);
    if (sort === "stars") list = [...list].sort((a, b) => eff(b) - eff(a));
    else if (sort === "new") list = [...list].sort((a, b) => daysAgo(a.when) - daysAgo(b.when));
    else list = [...list].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || eff(b) - eff(a));
    return list;
    // starred is derived from stars; depend on stars for stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q, type, sort, stars]);

  const featured = items.filter((i) => i.featured).slice(0, 3);

  const fmtStars = (i: LocalMarketItem) => {
    const n = i.stars + (starred.has(i.id) ? 1 : 0);
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  };

  // The Install▾ picker lists the user's profiles. Fall back to nothing
  // (Copy-install-command still works) until /profiles/full resolves.
  const myProfiles = profilesQ.data ?? [];

  function Card({ i, where }: { i: LocalMarketItem; where: string }) {
    const draft = i.mine && i.source === "local";
    const command = i.type === "profile" && i.source === "registry"
      ? profileInstallCommand(i.sourceUrl) === i.add ? i.add : ""
      : i.add;
    const t = TYPE[i.type];
    const on = starred.has(i.id);
    const key = where + ":" + i.id;
    const openMenu = (e: React.MouseEvent) => { e.stopPropagation(); setAddFor(addFor === key ? null : key); };
    return (
      <div className={"mk-card" + (addFor === key ? " menu-open" : "")} style={{ "--tc": t.color } as React.CSSProperties}>
        <div className="mk-top">
          <span className="mk-typeicon" style={{ color: t.color, background: t.color + "1a", borderColor: t.color + "40" }}>{t.glyph}</span>
          <div className="mk-headtext">
            <div className="mk-name">{i.name}</div>
            <div className="mk-type" style={{ color: t.color }}>{t.label}{i.featured ? " · featured" : ""}{i.mine ? " · yours" : ""}</div>
          </div>
          <div className="mk-addwrap">
            {!command || draft ? <span className="mk-type">Source needed before install</span> : publicMode || i.source === "registry" && i.type === "profile" ? (
              <button className="de-btn" onClick={() => void copyCommand(command)}>Copy CLI command</button>
            ) : (
            <>
            <div className={"mk-install" + (addFor === key ? " open" : "")}>
              <button className="mk-install-main" onClick={openMenu}>Install</button>
              <button className="mk-install-caret" onClick={openMenu}>▾</button>
            </div>
            {addFor === key && (
              <div className="mk-addmenu" onClick={(e) => e.stopPropagation()}>
                <div className="mk-addmenu-h">Add to profile <span className="mk-addmenu-sub">choose one of yours</span></div>
                <div className="mk-addmenu-list">
                  {myProfiles.map((p) => {
                    const busy = installing === i.id + "→" + p.name;
                    return (
                      <button
                        key={p.name}
                        className="mk-addmenu-item"
                        disabled={!!installing}
                        onClick={() => { setAddFor(null); void install(i, p.name); }}
                      >
                        <span className="mk-am-branch">⎇</span>
                        <span className="mk-am-name">{p.name}</span>
                        <span className="mk-am-go">{busy ? "…" : "add →"}</span>
                      </button>
                    );
                  })}
                  {myProfiles.length === 0 && <div className="mk-addmenu-item" style={{ opacity: 0.6 }}>no profiles loaded</div>}
                </div>
                <button className="mk-addmenu-foot" onClick={() => {
                  setAddFor(null);
                  void copyCommand(i.add);
                }}>⧉ Copy install command</button>
              </div>
            )}
            </>
            )}
          </div>
        </div>
        <div className="mk-desc">{i.desc}</div>
        {i.sourceUrl?.startsWith("https://github.com/") && <p><a href={i.sourceUrl} target="_blank" rel="noopener noreferrer">Inspect profile source ↗</a></p>}
        {command && !draft && <code style={{ display: "block", overflowWrap: "anywhere", padding: "10px 0", fontSize: 12 }}>{command}</code>}
        <div className="mk-foot">
          <span className="mk-by">By <b>{i.handle}</b></span>
          <button className={"mk-star" + (on ? " on" : "")} onClick={() => toggleStar(i.id)} title={on ? "unstar" : "star"}>
            <span className="mk-star-ic">{on ? "★" : "☆"}</span>{fmtStars(i)}
          </button>
        </div>
      </div>
    );
  }

  const cur = SORT_OPTS.find((o) => o[0] === sort) ?? SORT_OPTS[0]!;

  return (
    <div className="marketpage">
      <div className="mk-hero">
        <div>
          <div className="page-title">🛍 Cue Marketplace</div>
          <div className="page-sub">Discover shared agent profiles. Review their source, then run the copied command with Cue on your machine. Stars and unsigned drafts are saved only in this browser.</div>
        </div>
        <button className="mk-publish" onClick={() => setPubOpen(true)}>＋ Publish</button>
      </div>
      <p className="page-sub">Community code is not automatically trusted. Inspect hooks, skills and MCP servers before installing. {publicMode && "This public catalog cannot install or launch anything on your computer."}</p>
      {community.isPending && <p role="status">Loading community profiles…</p>}
      {community.isError && <p role="alert">Community catalog unavailable. Try again later; local profiles are unchanged.</p>}

      <div className="mk-toolbar">
        <div className="mk-search">
          <span className="mk-search-ic">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search profiles, workflows, skills, CLIs…" spellCheck={false} />
          {q ? <span className="mk-search-clear" onClick={() => setQ("")}>×</span> : <kbd className="mk-search-kbd">/</kbd>}
        </div>
        <div className="mk-types">
          {(["all", ...TYPE_KEYS] as const).map((t) => (
            <button key={t} className={"mk-chip" + (type === t ? " on" : "")} onClick={() => setType(t)}>
              {t === "all" ? "All" : TYPE[t].label}<span className="mk-chip-n">{counts[t] || 0}</span>
            </button>
          ))}
        </div>
        <div className="mk-sort">
          <button className={"mk-sortbtn" + (sortOpen ? " open" : "")} onClick={(e) => { e.stopPropagation(); setSortOpen((o) => !o); }}>
            <span className="mk-sort-ic">⇅</span>
            <span className="mk-sort-cur">{cur[1]}</span>
            <span className="mk-sort-caret">▾</span>
          </button>
          {sortOpen && (
            <div className="mk-sortmenu" onClick={(e) => e.stopPropagation()}>
              {SORT_OPTS.map(([v, l, ic]) => (
                <button key={v} className={"mk-sortitem" + (sort === v ? " on" : "")} onClick={() => { setSort(v); setSortOpen(false); }}>
                  <span className="msi-ic">{ic}</span><span className="msi-l">{l}</span>{sort === v && <span className="msi-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {type === "all" && !q && featured.length > 0 && (
        <div className="mk-section">
          <div className="mk-sec-h">Featured</div>
          <div className="mk-featgrid">{featured.map((i) => <Card key={i.id} i={i} where="feat" />)}</div>
        </div>
      )}

      <div className="mk-section">
        <div className="mk-sec-h">{type === "all" ? "All items" : TYPE[type].label + "s"} <span className="mk-sec-n">{shown.length}</span></div>
        <div className="mk-grid">{shown.map((i) => <Card key={i.id} i={i} where="grid" />)}</div>
        {shown.length === 0 && !community.isPending && !community.isError && <div className="mk-empty">
          {q ? <>No results for “{q}”.</> : publicMode && type === "all"
            ? "No community profiles yet. Publish the first profile with its public GitHub source."
            : "No items in this category yet."}
        </div>}
      </div>

      {pubOpen && (
        <PublishModal
          signedIn={!!session}
          onClose={() => setPubOpen(false)}
          onPublish={async (draft) => {
            // Signed in → push to the hosted marketplace so everyone sees it.
            if (session) {
              try {
                await publishCommunity({
                  type: draft.type,
                  name: draft.name,
                  description: draft.desc,
                  tags: draft.tags,
                  sourceUrl: draft.sourceUrl || undefined,
                });
                await queryClient.invalidateQueries({ queryKey: ["community-market"] });
                setPubOpen(false);
                setType("all");
                setQ("");
                setSort("new");
                flash(draft.name + " published to the marketplace ✓");
              } catch (err) {
                flash("Publish failed: " + (err as Error).message);
              }
              return;
            }
            // Signed out → keep a local-only draft and point them at the API view.
            const item: LocalMarketItem = {
              ...draft,
              id: "u" + Date.now(),
              author: "you",
              handle: "you",
              stars: 0,
              installs: "0",
              when: "now",
              featured: false,
              source: "local",
              add: "",
              addKind: draft.type,
              mine: true,
            };
            setPublished((p) => [item, ...p]);
            setPubOpen(false);
            setType("all");
            setQ("");
            setSort("new");
            flash("Saved locally — sign in (API view) to publish to everyone");
          }}
        />
      )}
      {toast && <div className="mk-toast" role="status">{toast}</div>}
    </div>
  );
}

// The publish form yields just the editable fields; the view fills the rest.
type PublishDraft = { type: MarketType; name: string; desc: string; tags: string[]; sourceUrl: string };

function PublishModal({ signedIn, onClose, onPublish }: { signedIn: boolean; onClose: () => void; onPublish: (draft: PublishDraft) => void | Promise<void> }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus();
  }, []);
  const [type, setType] = useState<MarketType>("profile");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [tags, setTags] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const sourceValid = profileInstallCommand(sourceUrl.trim()) !== null;
  const valid = name.trim() && desc.trim() && (type !== "profile" || sourceValid);
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onPublish({ type, name: name.trim(), desc: desc.trim(), sourceUrl: sourceUrl.trim(), tags: tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 4) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mk-modal-bg" onClick={onClose}>
      <div ref={dialog} className="mk-modal" role="dialog" aria-modal="true" aria-labelledby="publish-title" onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key !== "Tab") return;
        const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input, textarea");
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }} onClick={(e) => e.stopPropagation()}>
        <div className="mk-modal-h" id="publish-title">Publish to marketplace <button className="mk-modal-x" aria-label="Close publish dialog" onClick={onClose}>×</button></div>
        <div className="mk-modal-sub">{signedIn
          ? "Share a profile, workflow, skill or CLI with everyone running cue."
          : "Sign in from the API view to publish to everyone — otherwise this is saved as a local draft."}</div>
        <label className="mk-field"><span>Type</span>
          <div className="mk-typesel">{TYPE_KEYS.map((t) => (
            <button key={t} className={type === t ? "on" : ""} style={type === t ? { borderColor: TYPE[t].color, color: TYPE[t].color } : undefined} onClick={() => setType(t)}>{TYPE[t].glyph} {TYPE[t].label}</button>
          ))}</div>
        </label>
        <label className="mk-field"><span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ship-fast" spellCheck={false} />
        </label>
        <label className="mk-field"><span>Description</span>
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What does it do? When should someone reach for it?" rows={3} />
        </label>
        <label className="mk-field"><span>Tags <span className="mk-hint">comma-separated</span></span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="gstack, build, review" spellCheck={false} />
        </label>
        {type === "profile" && <label className="mk-field"><span>Public GitHub profile source (required)</span><input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://github.com/owner/repo/tree/main/profiles/example" aria-describedby="profile-source-help" required /><span id="profile-source-help" className="mk-hint">Link to the public repository or profile folder. The server validates the source before generating an install command.</span>{sourceUrl && !sourceValid && <span role="alert">Use an HTTPS github.com repository URL.</span>}</label>}
        <div className="mk-modal-foot">
          <button className="de-btn" onClick={onClose}>Cancel</button>
          <button
            className="de-btn primary"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >{busy ? "Publishing…" : signedIn ? "Publish" : "Save draft"}</button>
        </div>
      </div>
    </div>
  );
}
