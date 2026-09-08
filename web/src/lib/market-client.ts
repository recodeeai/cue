/**
 * Client for the HOSTED community marketplace (`/api/v1/community`) — the
 * publish/push surface, distinct from the local dashboard's read-only browse
 * catalog (`/api/v1/market`, via `studio/api.ts`).
 *
 * Always talks to the same origin (Vercel function in prod, the Vite auth
 * proxy in dev). Auth is the BetterAuth session cookie, so `credentials:
 * "include"` is enough — the same token a `cue marketplace publish` call sends
 * as a Bearer header. Catalog failures are surfaced separately so browsing
 * local profiles remains available without pretending the community is empty.
 */
import { useQuery } from "@tanstack/react-query";

import type { MarketItem } from "../studio/api";

export interface PublishInput {
  type: MarketItem["type"];
  name: string;
  description?: string;
  tags?: string[];
  sourceUrl?: string;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

/** Fetch the approved community catalog, distinguishing outages from no items. */
export async function fetchCommunity(): Promise<MarketItem[]> {
  const res = await fetch("/api/v1/community", { credentials: "include" });
  if (!res.ok) throw new Error(`Community catalog unavailable (HTTP ${res.status})`);
  const env = (await res.json()) as Envelope<{ items: MarketItem[] }>;
  if (!env.ok) throw new Error(env.error);
  return env.data.items;
}

/** Publish one item. Throws with the server error message on failure. */
export async function publishCommunity(input: PublishInput): Promise<MarketItem> {
  let res: Response;
  try {
    res = await fetch("/api/v1/community", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw new Error(`couldn't reach the marketplace: ${(err as Error).message}`);
  }
  let env: Envelope<MarketItem>;
  try {
    env = (await res.json()) as Envelope<MarketItem>;
  } catch {
    throw new Error(`marketplace returned non-JSON (HTTP ${res.status})`);
  }
  if (!env.ok) throw new Error(env.error);
  return env.data;
}

/** React Query hook for the community catalog (caches a minute). */
export function useCommunityMarket() {
  return useQuery({
    queryKey: ["community-market"],
    queryFn: fetchCommunity,
    staleTime: 60_000,
  });
}
