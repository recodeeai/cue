import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { workspaceAction } from "./workspace-schema.js";
import { Workspaces } from "./workspaces.js";
import { githubWebhook } from "../api/gx-hook.js";
import { encryptCredential, webhookSecret } from "./gx.js";

test("workspace actions reject forged roles, unknown fields and unsafe IDs", () => {
  expect(workspaceAction.safeParse({ action: "create", name: "Team", role: "owner" }).success).toBe(false);
  expect(workspaceAction.safeParse({ action: "invite", workspaceId: randomUUID(), role: "owner" }).success).toBe(false);
  expect(workspaceAction.safeParse({ action: "removeMember", workspaceId: "../other", userId: "x" }).success).toBe(false);
});

const database = process.env.WORKSPACES_TEST_DATABASE_URL;
describe.skipIf(!database)("workspace PostgreSQL isolation", () => {
  const schema = `test_ws_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: database, options: `-c search_path=${schema}`, max: 5 });
  const service = new Workspaces(pool);
  let team: string;
  const run = (user: string, input: unknown) => service.mutate(user, workspaceAction.parse(input));
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL)');
    await pool.query(`INSERT INTO "user" VALUES ('alice','Alice','alice@test.invalid'),('bob','Bob','bob@test.invalid'),('eve','Eve','eve@test.invalid'),('admin','Admin','admin@test.invalid')`);
    await pool.query(await readFile(new URL("../migrations/001-workspaces.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../migrations/002-workspace-repositories.sql", import.meta.url), "utf8"));
    team = (await run("alice", { action: "create", name: "Shared team" })).id as string;
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });
  test("concurrent personal initialization returns one workspace, private to its user", async () => {
    const results = await Promise.all([service.list("alice"), service.list("alice")]);
    const personal = results[0].find(w => w.kind === "personal")!;
    expect(results[1].find(w => w.kind === "personal")?.id).toBe(personal.id);
    expect((await service.list("bob")).some(w => w.id === personal.id)).toBe(false);
    await expect(service.detail("bob", personal.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(run("alice", { action: "invite", workspaceId: personal.id, role: "member" })).rejects.toMatchObject({ code: "PERSONAL_WORKSPACE" });
  });
  test("single-use invitation grants membership but no privilege escalation", async () => {
    const invite = await run("alice", { action: "invite", workspaceId: team, role: "member" });
    const stored = await pool.query("SELECT token_hash FROM cue_workspace_invite WHERE id=$1", [invite.id]);
    expect(stored.rows[0].token_hash).not.toBe(invite.token);
    expect(JSON.stringify(await service.detail("alice", team))).not.toContain(invite.token as string);
    await run("bob", { action: "acceptInvite", token: invite.token });
    expect((await service.detail("bob", team)).workspace.role).toBe("member");
    await expect(run("eve", { action: "acceptInvite", token: invite.token })).rejects.toMatchObject({ code: "INVITE_UNAVAILABLE" });
    await expect(run("bob", { action: "invite", workspaceId: team, role: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run("bob", { action: "setRole", workspaceId: team, userId: "bob", role: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run("bob", { action: "connectRepo", workspaceId: team, repository: "alice/private", token: randomUUID().replaceAll("-", "") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run("eve", { action: "disconnectRepo", workspaceId: team, repositoryId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.detail("eve", team)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  test("expired, revoked and concurrently consumed invitations fail closed", async () => {
    const expired = await run("alice", { action: "invite", workspaceId: team, role: "member" });
    await pool.query("UPDATE cue_workspace_invite SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    await expect(run("eve", { action: "acceptInvite", token: expired.token })).rejects.toMatchObject({ code: "INVITE_UNAVAILABLE" });
    const revoked = await run("alice", { action: "invite", workspaceId: team, role: "member" });
    await run("alice", { action: "revokeInvite", workspaceId: team, inviteId: revoked.id });
    await expect(run("eve", { action: "acceptInvite", token: revoked.token })).rejects.toMatchObject({ code: "INVITE_UNAVAILABLE" });
    const once = await run("alice", { action: "invite", workspaceId: team, role: "member" });
    const results = await Promise.allSettled(["bob", "eve"].map(user => run(user, { action: "acceptInvite", token: once.token })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  test("admin cannot promote, remove owner, or invite another admin", async () => {
    const invite = await run("alice", { action: "invite", workspaceId: team, role: "admin" });
    await run("admin", { action: "acceptInvite", token: invite.token });
    for (const input of [
      { action: "invite", workspaceId: team, role: "admin" },
      { action: "removeMember", workspaceId: team, userId: "alice" },
      { action: "setRole", workspaceId: team, userId: "bob", role: "admin" },
    ]) await expect(run("admin", input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run("alice", { action: "removeMember", workspaceId: team, userId: "alice" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const stale = await run("admin", { action: "invite", workspaceId: team, role: "member" });
    await run("alice", { action: "removeMember", workspaceId: team, userId: "admin" });
    await expect(run("eve", { action: "acceptInvite", token: stale.token })).rejects.toMatchObject({ code: "INVITE_UNAVAILABLE" });
    await expect(service.detail("admin", team)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  test("signed webhook validates raw body, repository identity, pause and disconnect", async () => {
    const id = randomUUID(), secret = randomBytes(32).toString("hex");
    const token = randomBytes(32).toString("hex");
    await pool.query("INSERT INTO cue_workspace_repo(id,workspace_id,github_id,full_name,credential) VALUES($1,$2,123,'owner/repo',$3)", [id, team, encryptCredential(token, team + ":" + id, secret)]);
    const detail = JSON.stringify(await service.detail("alice", team));
    expect(detail).not.toContain(token);
    expect(detail).not.toContain("credential");
    const send = (repository = 123, tamper = false) => {
      const body = JSON.stringify({ action: "opened", number: 1, repository: { id: repository } });
      const signature = createHmac("sha256", webhookSecret(id, secret)).update(body).digest("hex");
      return githubWebhook(new Request("https://cuecards.cc/api/gx-hook?id=" + id, {
        method: "POST", headers: { "x-hub-signature-256": "sha256=" + signature, "x-github-event": "pull_request" }, body: body + (tamper ? " " : ""),
      }), { pool, secret, request: async () => { throw new Error("NETWORK_MUST_NOT_BE_USED"); } });
    };
    expect((await send(123, true)).status).toBe(401);
    expect((await (await send()).json()).result).toBe("ignored");
    await pool.query("UPDATE cue_workspace_repo SET auto_merge=true WHERE id=$1", [id]);
    expect((await (await send(456)).json()).result).toBe("ignored");
    expect((await (await send()).json()).result).toBe("GITHUB_UNAVAILABLE");
    // Only safe error codes are persisted, never external response messages.
    expect((await pool.query("SELECT last_result FROM cue_workspace_repo WHERE id=$1", [id])).rows[0].last_result).toBe("GITHUB_UNAVAILABLE");
    await run("alice", { action: "disconnectRepo", workspaceId: team, repositoryId: id });
    expect((await send()).status).toBe(404);
  });
});
