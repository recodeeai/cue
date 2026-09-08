/**
 * Marketplace publish + list logic, shared between transports (the Bun dev
 * server and the Vercel Node function), exactly like `lib/me.ts`.
 *
 * The "push from your PC" goal:
 *   - A user mints an API token in the studio (BetterAuth apiKey plugin).
 *   - `cue marketplace publish …` (or the studio Publish modal) POSTs a
 *     profile / skill / mcp here with `Authorization: Bearer <token>`.
 *   - We authenticate via `auth.api.getSession` (works for both session
 *     cookies and Bearer api-keys, thanks to `enableSessionForAPIKeys`),
 *     validate + clamp the payload, and upsert it into Postgres.
 *
 * Security stance (deliberate):
 *   - The install command is DERIVED server-side, never taken from the client,
 *     so a submission can't smuggle `curl … | bash` into someone else's
 *     dashboard.
 *   - Every text field is length-clamped; tags are capped and slugged.
 *   - `id` embeds a per-user suffix so two users can't overwrite each other,
 *     and a unique (user_id, type, name) index makes re-publishing an update.
 */
import { createHash } from "node:crypto";

import { auth } from "./auth.js";
import { getPool } from "./db.js";
import { profileInstallCommand } from "./profile-source.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const MARKET_TYPES = ["profile", "workflow", "skill", "cli", "mcp", "plugin"] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

/** The fields a client may submit. Everything else is derived or server-set. */
export interface PublishInput {
  type: string;
  name: string;
  description?: string;
  tags?: string[];
  sourceUrl?: string;
}

/** One marketplace item, byte-compatible with the studio's `MarketItem`. */
export interface MarketItem {
  id: string;
  type: MarketType;
  name: string;
  author: string;
  handle: string;
  stars: number;
  installs: string;
  when: string;
  featured: boolean;
  desc: string;
  tags: string[];
  source: "registry" | "local";
  add: string;
  addKind: MarketType;
  sourceUrl?: string;
  status?: string;
}

export type Result<T> =
  | { status: number; body: { ok: true; data: T } }
  | { status: number; body: { ok: false; error: string } };

// ---------------------------------------------------------------------------
// Schema (idempotent — runs lazily on first use so a fresh DB just works)
// ---------------------------------------------------------------------------

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS market_item (
          id          text PRIMARY KEY,
          user_id     text NOT NULL,
          handle      text NOT NULL,
          type        text NOT NULL,
          name        text NOT NULL,
          description text NOT NULL DEFAULT '',
          tags        text[] NOT NULL DEFAULT '{}',
          source_url  text,
          status      text NOT NULL DEFAULT 'approved',
          stars       integer NOT NULL DEFAULT 0,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz NOT NULL DEFAULT now()
        );
      `);
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS market_item_owner_uidx
           ON market_item (user_id, type, name);`,
      );
    })().catch((err) => {
      // Reset so a transient failure (cold DB) can be retried next call.
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Validation + helpers
// ---------------------------------------------------------------------------

const MAX = { name: 64, desc: 500, tag: 24, tags: 8, url: 300, handle: 48 } as const;

/** lower-kebab slug, used for ids and to normalize handles/names. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX.name);
}

function clampStr(s: unknown, max: number): string {
  return (typeof s === "string" ? s : "").trim().slice(0, max);
}

/** Short stable per-user suffix so ids never collide across accounts. */
function userSuffix(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 6);
}

/** Compact relative time like the studio expects: "now", "5h", "3d", "2w". */
function relWhen(d: Date): string {
  const secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (secs < 90 * 60) return "now";
  const hours = secs / 3600;
  if (hours < 36) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}

/**
 * Derive the safe install / "add" command for an item. NEVER trust a
 * client-supplied command — that's the whole point. The shapes mirror the
 * studio's existing copy-install affordance and the `cue` CLI surface.
 */
function deriveAdd(type: MarketType, handle: string, name: string, sourceUrl: string | null): string {
  const ref = `${handle}/${name}`;
  switch (type) {
    case "profile": return profileInstallCommand(sourceUrl) ?? "";
    case "mcp": return `cue marketplace install-mcp ${name}`;
    case "skill": return `cue marketplace install-skill ${ref}`;
    default: return `cue add ${ref}`;
  }
}

interface ValidInput {
  type: MarketType;
  name: string;
  description: string;
  tags: string[];
  sourceUrl: string | null;
}

function validate(input: PublishInput): { ok: true; value: ValidInput } | { ok: false; error: string } {
  const type = clampStr(input.type, 16) as MarketType;
  if (!MARKET_TYPES.includes(type)) {
    return { ok: false, error: `invalid type (expected one of: ${MARKET_TYPES.join(", ")})` };
  }
  const name = slug(clampStr(input.name, MAX.name));
  if (!name) return { ok: false, error: "name is required (lowercase letters, digits, dashes)" };

  const description = clampStr(input.description, MAX.desc);

  const rawTags = Array.isArray(input.tags) ? input.tags : [];
  const tags = [...new Set(rawTags.map((t) => slug(clampStr(t, MAX.tag))).filter(Boolean))].slice(0, MAX.tags);

  let sourceUrl: string | null = null;
  if (type === "profile" && (
    typeof input.sourceUrl !== "string" || input.sourceUrl.length > MAX.url ||
    !profileInstallCommand(input.sourceUrl.trim())
  )) {
    return { ok: false, error: "Profiles require a public GitHub sourceUrl: https://github.com/owner/repo or https://github.com/owner/repo/tree/ref/profile-directory" };
  }
  const url = clampStr(input.sourceUrl, MAX.url);
  if (url) {
    if (!/^https:\/\/[^\s]+$/i.test(url)) {
      return { ok: false, error: "sourceUrl must be an https:// URL" };
    }
    sourceUrl = url;
  }

  return { ok: true, value: { type, name, description, tags, sourceUrl } };
}

// ---------------------------------------------------------------------------
// Row → MarketItem
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  handle: string;
  type: MarketType;
  name: string;
  description: string;
  tags: string[];
  source_url: string | null;
  status: string;
  stars: number;
  created_at: Date;
}

function rowToItem(r: Row): MarketItem {
  const add = deriveAdd(r.type, r.handle, r.name, r.source_url);
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    author: r.handle,
    handle: r.handle,
    stars: r.stars,
    installs: "0",
    when: relWhen(new Date(r.created_at)),
    featured: false,
    desc: r.description,
    tags: r.tags ?? [],
    source: "registry",
    add,
    addKind: r.type,
    ...(r.source_url ? { sourceUrl: r.source_url } : {}),
    status: r.type === "profile" && !add ? "source-required" : r.status,
  };
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

const SELECT = `
  SELECT id, handle, type, name, description, tags, source_url, status, stars, created_at
    FROM market_item`;

/**
 * GET /api/v1/market — the community-published catalog. Returns approved items
 * for everyone; when authenticated and `mine` is set, returns the caller's own
 * items regardless of status so they can see pending/just-published entries.
 */
export async function getMarket(headers: Headers, opts: { mine?: boolean } = {}): Promise<Result<{ items: MarketItem[] }>> {
  try {
    await ensureSchema();
    const pool = getPool();

    if (opts.mine) {
      const session = await auth.api.getSession({ headers });
      if (!session) return { status: 401, body: { ok: false, error: "unauthorized" } };
      const res = await pool.query<Row>(
        `${SELECT} WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [session.user.id],
      );
      return { status: 200, body: { ok: true, data: { items: res.rows.map(rowToItem) } } };
    }

    const res = await pool.query<Row>(
      `${SELECT} WHERE status = 'approved' ORDER BY stars DESC, created_at DESC LIMIT 500`,
    );
    return { status: 200, body: { ok: true, data: { items: res.rows.map(rowToItem) } } };
  } catch (err) {
    return { status: 500, body: { ok: false, error: (err as Error).message } };
  }
}

/**
 * POST /api/v1/market — publish (or re-publish) one item. Authenticated via
 * session cookie OR `Authorization: Bearer <api-key>`.
 */
export async function publishMarket(headers: Headers, input: PublishInput): Promise<Result<MarketItem>> {
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers });
  } catch (err) {
    return { status: 500, body: { ok: false, error: (err as Error).message } };
  }
  if (!session) return { status: 401, body: { ok: false, error: "unauthorized" } };

  const checked = validate(input ?? {});
  if (!checked.ok) return { status: 400, body: { ok: false, error: checked.error } };
  const { type, name, description, tags, sourceUrl } = checked.value;

  const userId = session.user.id;
  const handle = slug(session.user.name || session.user.email.split("@")[0] || "anon").slice(0, MAX.handle) || "anon";
  const id = `${type}:${name}-${userSuffix(userId)}`;

  try {
    await ensureSchema();
    const pool = getPool();
    const res = await pool.query<Row>(
      `INSERT INTO market_item (id, user_id, handle, type, name, description, tags, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, type, name) DO UPDATE
         SET description = EXCLUDED.description,
             tags        = EXCLUDED.tags,
             source_url  = EXCLUDED.source_url,
             handle      = EXCLUDED.handle,
             updated_at  = now()
       RETURNING id, handle, type, name, description, tags, source_url, status, stars, created_at`,
      [id, userId, handle, type, name, description, tags, sourceUrl],
    );
    return { status: 200, body: { ok: true, data: rowToItem(res.rows[0]!) } };
  } catch (err) {
    return { status: 500, body: { ok: false, error: (err as Error).message } };
  }
}
