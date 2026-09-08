#!/usr/bin/env bun
/**
 * Local auth server for development and the end-to-end check. Mounts the SAME
 * BetterAuth instance the Vercel functions use, so a green check here means the
 * real code paths work — only the transport (Bun vs Vercel Node) differs.
 *
 *   /api/auth/*    -> BetterAuth (sign-up, sign-in, session, api-key/*)
 *   /api/v1/me        -> shared getMe()
 *   /api/v1/community -> shared getMarket() / publishMarket()
 *
 * Env: DATABASE_URL, BETTER_AUTH_SECRET, optional PORT (default 3000).
 * Run:  bun scripts/dev-server.ts
 */
import { auth } from "../lib/auth.js";
import { workspaceRequest } from "../api/v1/workspaces.js";
import { githubWebhook } from "../api/gx-hook.js";
import { getMe } from "../lib/me.js";
import { getMarket, publishMarket, type PublishInput } from "../lib/market.js";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    if (pathname === "/api/v1/workspaces") return workspaceRequest(req);
    if (pathname === "/api/gx-hook") return githubWebhook(req);
    if (pathname.startsWith("/api/auth")) {
      return auth.handler(req);
    }
    if (pathname === "/api/v1/me") {
      const { status, body } = await getMe(req.headers);
      return Response.json(body, { status });
    }
    if (pathname === "/api/v1/community") {
      if (req.method === "GET") {
        const { status, body } = await getMarket(req.headers, { mine: url.searchParams.get("mine") === "1" });
        return Response.json(body, { status });
      }
      if (req.method === "POST") {
        let input: PublishInput;
        try { input = (await req.json()) as PublishInput; }
        catch { return Response.json({ ok: false, error: "invalid-json" }, { status: 400 }); }
        const { status, body } = await publishMarket(req.headers, input);
        return Response.json(body, { status });
      }
      return Response.json({ ok: false, error: "method-not-allowed" }, { status: 405 });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`auth dev server listening on http://localhost:${server.port}`);
