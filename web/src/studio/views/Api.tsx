/**
 * API view — the public account surface of cuecards.cc.
 *
 * Logged out  -> <AuthGate>: register or sign in (BetterAuth email+password).
 * Logged in   -> <ApiTokens>: manage API tokens, modelled on the reference
 *                screenshot (create, copy-once, regenerate, delete, expiry).
 *
 * This view is independent of the local cue dashboard server, so StudioApp
 * renders it even when that server is offline.
 */
import { useCallback, useEffect, useState } from "react";
import {
  useSession, signIn, signUp, signOut, authClient, type ApiKeyRow,
} from "../../lib/auth-client";

const DAY = 60 * 60 * 24;
const EXPIRY_CHOICES: [string, number | null][] = [
  ["Never expires", null],
  ["30 days", 30 * DAY],
  ["90 days", 90 * DAY],
  ["1 year", 365 * DAY],
];

function fmtDate(value: Date | string | null): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

/* ───────────────────────── auth gate ───────────────────────── */

export function AuthGate({ workspace = false }: { workspace?: boolean }) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = mode === "signup"
        ? await signUp.email({ email, password, name: name || email.split("@")[0] })
        : await signIn.email({ email, password });
      if (res.error) setError(res.error.message ?? "Something went wrong");
    } catch { setError("Account service unavailable. Please retry."); }
    finally { setBusy(false); }
    // On success the useSession hook flips the whole view to <ApiTokens>.
  };

  return (
    <div className="api-auth">
      <div className="api-auth-card">
        <div className="api-auth-head">
          <h2>{mode === "signup" ? "Create your free account" : "Welcome back"}</h2>
          <p>{workspace ? "Sign in or create an account to access your private and team workspaces." : mode === "signup"
            ? "Register for cuecards.cc to create API tokens. Free, no card."
            : "Sign in to manage your API tokens."}</p>
        </div>
        <form onSubmit={submit} className="api-form">
          {mode === "signup" && (
            <label className="api-field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace" autoComplete="name" />
            </label>
          )}
          <label className="api-field">
            <span>Email</span>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" autoComplete="email" />
          </label>
          <label className="api-field">
            <span>Password</span>
            <input type="password" required minLength={8} value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete={mode === "signup" ? "new-password" : "current-password"} />
          </label>
          {error && <div className="api-error">{error}</div>}
          <button className="api-btn primary" type="submit" disabled={busy}>
            {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>
        <div className="api-auth-switch">
          {mode === "signup" ? "Already have an account?" : "New to cuecards?"}{" "}
          <button onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null); }}>
            {mode === "signup" ? "Sign in" : "Create one free"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── token manager ───────────────────────── */

function ApiTokens({ email }: { email: string }) {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newExpiry, setNewExpiry] = useState<number | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await authClient.apiKey.list();
    setLoading(false);
    if (res.error) { setError(res.error.message ?? "Failed to load tokens"); return; }
    setKeys((res.data?.apiKeys as ApiKeyRow[]) ?? []);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await authClient.apiKey.create({
      name: newName || "token",
      ...(newExpiry ? { expiresIn: newExpiry } : {}),
    });
    if (res.error) { setError(res.error.message ?? "Failed to create token"); return; }
    setFreshToken((res.data as { key: string }).key);
    setReveal(false);
    setCreating(false);
    setNewName("");
    setNewExpiry(null);
    await reload();
  };

  const remove = async (id: string) => {
    setError(null);
    const res = await authClient.apiKey.delete({ keyId: id });
    if (res.error) { setError(res.error.message ?? "Failed to delete token"); return; }
    await reload();
  };

  // BetterAuth has no rotate endpoint, so regenerate = recreate with the same
  // name + remaining expiry. Create FIRST, then delete the old key — never
  // destroy the existing token until the replacement exists, so a failed
  // create can't lock the user out. (Note: a long-lived token regenerated late
  // in its life inherits only its *remaining* lifetime, by design.)
  const regenerate = async (row: ApiKeyRow) => {
    setError(null);
    const expiresIn = row.expiresAt
      ? Math.max(DAY, Math.round((new Date(row.expiresAt).getTime() - Date.now()) / 1000))
      : null;
    const res = await authClient.apiKey.create({
      name: row.name ?? "token",
      ...(expiresIn ? { expiresIn } : {}),
    });
    if (res.error) { setError(res.error.message ?? "Failed to regenerate"); return; }
    const del = await authClient.apiKey.delete({ keyId: row.id });
    if (del.error) {
      setError("New token created, but removing the old one failed — delete it manually below.");
    }
    setFreshToken((res.data as { key: string }).key);
    setReveal(false);
    await reload();
  };

  const copy = async () => {
    if (!freshToken) return;
    try {
      // Await the promise: writeText rejects (not throws) on permission denial
      // or a non-secure context, so a sync try/catch would flash a false "✓".
      await navigator.clipboard.writeText(freshToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setError("Couldn't copy automatically — reveal the token and copy it manually.");
    }
  };

  return (
    <div className="api-page">
      <div className="api-crumb">
        <span className="api-crumb-home">⌂</span> <span>›</span> <b>API</b>
      </div>
      <div className="api-titlerow">
        <h1>API</h1>
        <div className="api-user">
          <span className="api-user-email">{email}</span>
          <button className="api-btn ghost sm" onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>

      <div className="api-card">
        <div className="api-card-head">
          <div className="api-card-title">API token</div>
          <div className="api-card-actions">
            <a className="api-btn ghost" href="https://github.com/opencue/cuecards#api"
              target="_blank" rel="noopener noreferrer">API documentation ↗</a>
            <button className="api-btn primary" onClick={() => { setCreating((c) => !c); setError(null); }}>
              + New token
            </button>
          </div>
        </div>

        {creating && (
          <form className="api-newtoken" onSubmit={create}>
            <input className="api-newtoken-name" value={newName} autoFocus
              onChange={(e) => setNewName(e.target.value)} placeholder="Token name (e.g. claude)" />
            <select className="api-newtoken-exp" value={newExpiry ?? ""}
              onChange={(e) => setNewExpiry(e.target.value ? Number(e.target.value) : null)}>
              {EXPIRY_CHOICES.map(([label, secs]) => (
                <option key={label} value={secs ?? ""}>{label}</option>
              ))}
            </select>
            <button className="api-btn primary" type="submit">Create</button>
            <button className="api-btn ghost" type="button" onClick={() => setCreating(false)}>Cancel</button>
          </form>
        )}

        {error && <div className="api-error">{error}</div>}

        {freshToken && (
          <div className="api-tokenbanner">
            <span className="api-tokenbanner-ico">⚠</span>
            <div className="api-tokenbanner-body">
              <div className="api-tokenbanner-title">Copy your token</div>
              <div className="api-tokenbanner-sub">It won't be shown again if you refresh or leave the page.</div>
            </div>
            <div className="api-tokenbox">
              <code>{reveal ? freshToken : "•".repeat(Math.min(40, freshToken.length))}</code>
              <button className="api-icobtn" title={reveal ? "Hide" : "Reveal"}
                onClick={() => setReveal((r) => !r)}>{reveal ? "🙈" : "👁"}</button>
              <button className="api-icobtn" title="Copy" onClick={() => void copy()}>{copied ? "✓" : "⧉"}</button>
            </div>
            <button className="api-tokenbanner-close" title="Dismiss" onClick={() => setFreshToken(null)}>×</button>
          </div>
        )}

        <div className="api-tokenlist">
          {loading ? (
            <div className="api-empty">Loading tokens…</div>
          ) : keys.length === 0 ? (
            <div className="api-empty">No tokens yet. Create one to call the cuecards API.</div>
          ) : keys.map((k) => (
            <div className="api-tokenrow" key={k.id}>
              <div className="api-tokenrow-key">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="7" cy="15" r="3" /><path d="M9.5 12.5 19 3M16 6l2 2M18 4l2 2" />
                </svg>
              </div>
              <div className="api-tokenrow-main">
                <div className="api-tokenrow-name">
                  {k.name ?? "token"}
                  <span className={"api-badge" + (k.expiresAt ? " amber" : "")}>
                    {k.expiresAt ? `Expires on ${fmtDate(k.expiresAt)}` : "Never expires"}
                  </span>
                </div>
                <div className="api-tokenrow-meta">
                  Created on: {fmtDate(k.createdAt)} <span className="api-dim">|</span> Last used: {fmtDate(k.lastRequest)}
                </div>
              </div>
              <div className="api-tokenrow-actions">
                <button className="api-btn ghost sm" onClick={() => void regenerate(k)}>Regenerate</button>
                <button className="api-icobtn danger" title="Delete" onClick={() => void remove(k.id)}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── entry ───────────────────────── */

export function ApiView() {
  const { data: session, isPending } = useSession();
  if (isPending) return <div className="api-page"><div className="api-empty">Loading…</div></div>;
  if (!session) return <AuthGate />;
  return <ApiTokens email={session.user.email} />;
}
