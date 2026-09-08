import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { WorkspaceError, type WorkspaceAction, type WorkspaceRole } from "./workspace-schema.js";
import { GitHubRepo, encryptCredential, decryptCredential, webhookSecret } from "./gx.js";
import { resolveAuthBaseUrl } from "./auth-origin.js";
import { z } from "zod";

export type Workspace = { id: string; name: string; kind: "personal" | "team"; role: WorkspaceRole };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const forbidden = () => new WorkspaceError(403, "FORBIDDEN", "Your workspace role does not allow this action.");
const unavailable = () => new WorkspaceError(410, "INVITE_UNAVAILABLE", "This invitation is expired, revoked or already used.");

export class Workspaces {
  constructor(private pool: Pool) {}

  async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally { db.release(); }
  }

  // Lock first, then authorize: member removal cannot race a privileged write.
  async authorize(db: PoolClient, userId: string, id: string): Promise<Workspace> {
    await db.query("SELECT id FROM cue_workspace WHERE id=$1 FOR UPDATE", [id]);
    const result = await db.query<Workspace>(
      "SELECT w.id,w.name,w.kind,m.role FROM cue_workspace w JOIN cue_workspace_member m ON m.workspace_id=w.id WHERE w.id=$1 AND m.user_id=$2",
      [id, userId],
    );
    if (!result.rows[0]) throw new WorkspaceError(404, "NOT_FOUND", "Workspace not found.");
    return result.rows[0];
  }

  async list(userId: string): Promise<Workspace[]> {
    return this.transaction(async db => {
      const personal = await db.query<{ id: string }>(
        "INSERT INTO cue_workspace(id,name,kind,owner_id) VALUES($1,'Personal workspace','personal',$2) ON CONFLICT (owner_id) WHERE kind='personal' DO UPDATE SET owner_id=EXCLUDED.owner_id RETURNING id",
        [randomUUID(), userId],
      );
      await db.query("INSERT INTO cue_workspace_member(workspace_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING", [personal.rows[0].id, userId]);
      return (await db.query<Workspace>(
        "SELECT w.id,w.name,w.kind,m.role FROM cue_workspace w JOIN cue_workspace_member m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.kind,w.created_at",
        [userId],
      )).rows;
    });
  }

  async detail(userId: string, id: string) {
    return this.transaction(async db => {
      const workspace = await this.authorize(db, userId, id);
      const members = (await db.query<{ id: string; name: string; role: WorkspaceRole }>(
        'SELECT u.id,u.name,m.role FROM cue_workspace_member m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.joined_at', [id],
      )).rows;
      const invites = workspace.role === "member" ? [] : (await db.query<{ id: string; role: "admin" | "member"; expires_at: string; created_by: string }>(
        "SELECT id,role,expires_at,created_by FROM cue_workspace_invite WHERE workspace_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC", [id],
      )).rows;
      const repositories = (await db.query("SELECT id,full_name,auto_merge,last_event_at,last_result FROM cue_workspace_repo WHERE workspace_id=$1 ORDER BY created_at", [id])).rows;
      return { workspace, members, invites, repositories };
    });
  }

  async mutate(userId: string, input: WorkspaceAction): Promise<Record<string, unknown>> {
    return this.transaction(async db => {
      if (input.action === "create") {
        // Serialize per-owner quota checks, including concurrent requests.
        await db.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
        const count = await db.query("SELECT count(*)::int AS count FROM cue_workspace WHERE owner_id=$1 AND kind='team'", [userId]);
        if (count.rows[0].count >= 30) throw new WorkspaceError(409, "WORKSPACE_LIMIT", "You can own at most 30 team workspaces.");
        const id = randomUUID();
        await db.query("INSERT INTO cue_workspace(id,name,kind,owner_id) VALUES($1,$2,'team',$3)", [id, input.name, userId]);
        await db.query("INSERT INTO cue_workspace_member(workspace_id,user_id,role) VALUES($1,$2,'owner')", [id, userId]);
        return { id };
      }
      if (input.action === "acceptInvite") {
        const found = await db.query("SELECT workspace_id FROM cue_workspace_invite WHERE token_hash=$1", [hash(input.token)]);
        if (!found.rows[0]) throw unavailable();
        const id = found.rows[0].workspace_id;
        const workspace = await db.query("SELECT kind FROM cue_workspace WHERE id=$1 FOR UPDATE", [id]);
        if (workspace.rows[0]?.kind !== "team") throw unavailable();
        const invite = (await db.query(
          "SELECT i.id,i.role,m.role AS issuer_role FROM cue_workspace_invite i JOIN cue_workspace_member m ON m.workspace_id=i.workspace_id AND m.user_id=i.created_by WHERE i.token_hash=$1 AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()",
          [hash(input.token)],
        )).rows[0];
        if (!invite || !["owner", "admin"].includes(invite.issuer_role) || (invite.role === "admin" && invite.issuer_role !== "owner")) throw unavailable();
        const count = await db.query("SELECT count(*)::int AS count FROM cue_workspace_member WHERE workspace_id=$1", [id]);
        if (count.rows[0].count >= 200) throw new WorkspaceError(409, "MEMBER_LIMIT", "This workspace has reached its 200-member limit.");
        // Existing memberships are never promoted by a bearer invitation.
        await db.query("INSERT INTO cue_workspace_member(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [id, userId, invite.role]);
        await db.query("UPDATE cue_workspace_invite SET consumed_at=now() WHERE id=$1", [invite.id]);
        return { id };
      }
      const workspace = await this.authorize(db, userId, input.workspaceId);
      if (["connectRepo", "disconnectRepo", "setAutoMerge", "queuePull"].includes(input.action)) {
        if (workspace.role === "member") throw forbidden();
        const secret = process.env.BETTER_AUTH_SECRET ?? "";
        if (input.action === "connectRepo") {
          const count = await db.query("SELECT count(*)::int AS count FROM cue_workspace_repo WHERE workspace_id=$1", [workspace.id]);
          if (count.rows[0].count >= 50) throw new WorkspaceError(409, "REPOSITORY_LIMIT", "A workspace can connect at most 50 repositories.");
          const repo = await new GitHubRepo(input.token).repository(input.repository);
          const id = randomUUID();
          const credential = encryptCredential(input.token, workspace.id + ":" + id, secret);
          const result = await db.query("INSERT INTO cue_workspace_repo(id,workspace_id,github_id,full_name,credential) VALUES($1,$2,$3,$4,$5) ON CONFLICT (github_id) DO NOTHING RETURNING id", [id, workspace.id, repo.id, repo.full_name, credential]);
          if (!result.rowCount) throw new WorkspaceError(409, "REPOSITORY_CONNECTED", "This repository is already connected to a workspace.");
          return { id };
        }
        if (input.action !== "disconnectRepo" && input.action !== "setAutoMerge" && input.action !== "queuePull") throw forbidden();
        const repo = (await db.query("SELECT * FROM cue_workspace_repo WHERE id=$1 AND workspace_id=$2", [input.repositoryId, workspace.id])).rows[0];
        if (!repo) throw new WorkspaceError(404, "NOT_FOUND", "Repository not found.");
        if (input.action === "disconnectRepo") {
          // Forgetting credentials must remain possible even after token expiry.
          // The now-orphaned GitHub hook fails closed (no connection exists).
          await db.query("DELETE FROM cue_workspace_repo WHERE id=$1", [repo.id]);
          return { id: workspace.id };
        }
        const github = new GitHubRepo(decryptCredential(repo.credential, workspace.id + ":" + repo.id, secret));
        if (input.action === "queuePull") return { id: workspace.id, result: await github.queue(repo.full_name, Number(repo.github_id), input.number) };
        if (input.enabled) {
          await github.gates(repo.full_name, Number(repo.github_id));
          const origin = new URL(resolveAuthBaseUrl());
          if (origin.protocol !== "https:") throw new WorkspaceError(409, "PUBLIC_HTTPS_REQUIRED", "Deploy to your public HTTPS domain before enabling webhooks.");
          const config = { url: origin.origin + "/api/gx-hook?id=" + repo.id, content_type: "json", insecure_ssl: "0", secret: webhookSecret(repo.id, secret) };
          const hook = z.object({ id: z.number().int().positive() }).parse(await github.api(
            `repos/${repo.full_name}/hooks${repo.hook_id ? "/" + repo.hook_id : ""}`,
            repo.hook_id ? "PATCH" : "POST", { ...(repo.hook_id ? {} : { name: "web" }), active: true, events: ["pull_request"], config },
          ));
          await db.query("UPDATE cue_workspace_repo SET hook_id=$2 WHERE id=$1", [repo.id, hook.id]);
        }
        await db.query("UPDATE cue_workspace_repo SET auto_merge=$2,last_result=$3 WHERE id=$1", [repo.id, input.enabled, input.enabled ? "Waiting for a pull request event" : "New enrollments paused; queued PRs remain in GitHub"]);
        return { id: workspace.id };
      }
      if (workspace.kind === "personal") throw new WorkspaceError(400, "PERSONAL_WORKSPACE", "Use a team workspace to invite or manage members.");
      if (workspace.role === "member") throw forbidden();
      if (input.action === "invite") {
        if (input.role === "admin" && workspace.role !== "owner") throw forbidden();
        const count = await db.query("SELECT count(*)::int AS count FROM cue_workspace_invite WHERE workspace_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()", [workspace.id]);
        if (count.rows[0].count >= 100) throw new WorkspaceError(409, "INVITE_LIMIT", "Revoke an existing invitation before creating another.");
        const token = randomBytes(32).toString("base64url"), id = randomUUID();
        const created = await db.query("INSERT INTO cue_workspace_invite(id,workspace_id,created_by,role,token_hash) VALUES($1,$2,$3,$4,$5) RETURNING expires_at", [id, workspace.id, userId, input.role, hash(token)]);
        return { id, token, expiresAt: created.rows[0].expires_at };
      }
      if (input.action === "revokeInvite") {
        const result = await db.query("UPDATE cue_workspace_invite SET revoked_at=now() WHERE id=$1 AND workspace_id=$2 AND ($3='owner' OR role='member') RETURNING id", [input.inviteId, workspace.id, workspace.role]);
        if (!result.rowCount) throw new WorkspaceError(404, "NOT_FOUND", "Invitation not found.");
        return { id: input.inviteId };
      }
      if (input.action !== "setRole" && input.action !== "removeMember") throw forbidden();
      const target = (await db.query("SELECT role FROM cue_workspace_member WHERE workspace_id=$1 AND user_id=$2", [workspace.id, input.userId])).rows[0];
      if (!target) throw new WorkspaceError(404, "NOT_FOUND", "Member not found.");
      if (target.role === "owner" || (workspace.role !== "owner" && target.role !== "member")) throw forbidden();
      if (input.action === "setRole") {
        if (workspace.role !== "owner") throw forbidden();
        await db.query("UPDATE cue_workspace_member SET role=$3 WHERE workspace_id=$1 AND user_id=$2", [workspace.id, input.userId, input.role]);
      } else {
        await db.query("DELETE FROM cue_workspace_member WHERE workspace_id=$1 AND user_id=$2", [workspace.id, input.userId]);
      }
      // Demoted/removed issuers cannot leave elevated invitations behind.
      await db.query("UPDATE cue_workspace_invite SET revoked_at=now() WHERE workspace_id=$1 AND created_by=$2 AND consumed_at IS NULL", [workspace.id, input.userId]);
      return { id: workspace.id };
    });
  }
}
