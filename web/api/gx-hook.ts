import { z } from "zod";
import type { Pool } from "pg";
import { getPool } from "../lib/db.js";
import { GitHubRepo, decryptCredential, verifyWebhook, webhookSecret } from "../lib/gx.js";
import { Workspaces } from "../lib/workspaces.js";
import { WorkspaceError } from "../lib/workspace-schema.js";

export async function githubWebhook(req: Request, dependencies?: { pool: Pool; secret: string; request?: typeof fetch }): Promise<Response> {
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
  if (req.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  const id = z.uuid().safeParse(new URL(req.url).searchParams.get("id"));
  if (!id.success) return json({ error: { code: "INVALID_INPUT" } }, 400);
  try {
    const pool = dependencies?.pool ?? getPool(), secret = dependencies?.secret ?? process.env.BETTER_AUTH_SECRET ?? "";
    const reader = req.body?.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 262144) { await reader.cancel(); return json({ error: { code: "BODY_TOO_LARGE" } }, 413); }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    if (!verifyWebhook(body, req.headers.get("x-hub-signature-256") ?? "", webhookSecret(id.data, secret))) return json({ error: { code: "INVALID_SIGNATURE" } }, 401);
    const repo = (await pool.query("SELECT workspace_id FROM cue_workspace_repo WHERE id=$1", [id.data])).rows[0];
    if (!repo) return json({ error: { code: "NOT_FOUND" } }, 404);
    const event = req.headers.get("x-github-event");
    if (event === "ping") return json({ ok: true });
    if (event !== "pull_request") return json({ ok: true, result: "ignored" });
    let raw: unknown;
    try { raw = JSON.parse(body.toString("utf8")); } catch { return json({ error: { code: "INVALID_JSON" } }, 400); }
    const parsed = z.object({ action: z.string(), number: z.number().int().positive().max(2147483647), repository: z.object({ id: z.number().int().positive() }) }).safeParse(raw);
    if (!parsed.success) return json({ error: { code: "INVALID_INPUT" } }, 400);
    if (!["opened", "reopened", "synchronize", "ready_for_review", "edited"].includes(parsed.data.action)) return json({ ok: true, result: "ignored" });
    const result = await new Workspaces(pool).transaction(async db => {
      await db.query("SELECT id FROM cue_workspace WHERE id=$1 FOR UPDATE", [repo.workspace_id]);
      const connection = (await db.query("SELECT * FROM cue_workspace_repo WHERE id=$1", [id.data])).rows[0];
      if (!connection?.auto_merge || Number(connection.github_id) !== parsed.data.repository.id) return "ignored";
      let outcome: string;
      try {
        const github = new GitHubRepo(decryptCredential(connection.credential, connection.workspace_id + ":" + connection.id, secret), dependencies?.request);
        outcome = await github.queue(connection.full_name, Number(connection.github_id), parsed.data.number);
      } catch (error) {
        outcome = error instanceof WorkspaceError ? error.code : "GITHUB_UNAVAILABLE";
      }
      // Redeliveries are safe: queue re-fetches current PR/policy and skips
      // closed/draft/fork PRs; an already queued PR is an idempotent success.
      await db.query("UPDATE cue_workspace_repo SET last_event_at=now(),last_result=$2 WHERE id=$1", [connection.id, outcome]);
      return outcome;
    });
    return json({ ok: true, result });
  } catch { return json({ error: { code: "SERVICE_UNAVAILABLE" } }, 503); }
}
export default { fetch: githubWebhook };
