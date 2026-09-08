import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { workspaceApi, type Role, type WorkspaceDetail } from "./api";

export function Repositories({ workspaceId, userId, role, repositories }: {
  workspaceId: string; userId: string; role: Role; repositories: WorkspaceDetail["repositories"];
}) {
  const client = useQueryClient();
  const tokenInput = useRef<HTMLInputElement>(null);
  const [repository, setRepository] = useState("");
  const [notice, setNotice] = useState("");
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async (action: Record<string, unknown>) => {
      // Credential stays out of TanStack mutation variables/cache/devtools.
      const token = action.action === "connectRepo" ? tokenInput.current?.value : undefined;
      if (tokenInput.current) tokenInput.current.value = "";
      return workspaceApi<{ result?: string }>({ ...action, workspaceId, ...(token ? { token } : {}) });
    },
    onSuccess: async (result, action) => {
      if (action.action === "connectRepo") setRepository("");
      setNotice(action.action === "disconnectRepo"
        ? "Credential removed. Delete the Cuecards webhook in GitHub settings. Already queued PRs remain in GitHub."
        : result.result === "skipped" ? "Skipped: only open, non-draft PRs from this repository to its default branch qualify."
        : result.result === "queued" ? "Queued in GitHub. Required CI and review gates still apply." : "Repository settings saved.");
      await client.invalidateQueries({ queryKey: ["workspace", userId, workspaceId] });
    },
  });
  const canManage = role !== "member";
  return <section className="ws-card ws-repositories"><div className="ws-section-heading"><div><p className="ws-eyebrow">BUILD. REVIEW. SHIP.</p><h2>Repositories</h2></div><span className="ws-badge">GX delivery</span></div>
    <p className="ws-section-caption">Your code, connected to guarded auto-merge.</p>
    {mutation.error && <p className="ws-error" role="alert">{mutation.error.message}</p>}
    {notice && <p role="status">{notice}</p>}
    {!repositories.length && <div className="ws-empty"><span className="ws-empty-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 5h13a3 3 0 0 1 3 3v19H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z" /><path d="M5 23a3 3 0 0 1 3-3h16M11 10h7M11 14h5M20 24v6l-3-2-3 2v-6" /></svg></span><h3>{canManage ? "Connect your first repository" : "No repositories connected yet"}</h3><p>{canManage ? "Bring your code into the workspace. Keep every merge behind your required checks and reviews." : "Ask a workspace owner or admin to connect a repository."}</p></div>}
    <ul className="ws-members">{repositories.map(repo => <li key={repo.id}><div>
      <a href={`https://github.com/${repo.full_name}`} target="_blank" rel="noreferrer" style={{ color: "#36d7b6" }}>{repo.full_name}</a>
      <small>Auto-enrollment {repo.auto_merge ? "enabled" : "paused"}</small>
      {repo.last_result && <small>{repo.last_result}</small>}
      {repo.last_event_at && <small>Last event: {new Date(repo.last_event_at).toLocaleString()}</small>}
      {canManage && <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); mutation.mutate({ action: "queuePull", repositoryId: repo.id, number: Number(data.get("number")) }); }}>
        <label>Existing PR number<input name="number" type="number" min={1} max={2147483647} required placeholder="123" /></label><button disabled={mutation.isPending}>Queue after gate check</button>
      </form>}
    </div>{canManage && <div className="ws-actions"><button disabled={mutation.isPending} onClick={() => {
      if (window.confirm(repo.auto_merge ? "Pause enrollment of new PRs? Already queued PRs remain managed by GitHub." : "Install a signed GitHub webhook and enroll future eligible PRs? Required branch checks and reviews must be configured first.")) mutation.mutate({ action: "setAutoMerge", repositoryId: repo.id, enabled: !repo.auto_merge });
    }}>{repo.auto_merge ? "Pause new enrollments" : "Enable auto-enrollment"}</button><button disabled={mutation.isPending} onClick={() => {
      if (window.confirm("Remove this stored credential? You must delete its Cuecards webhook in GitHub separately. Queued PRs remain in GitHub.")) mutation.mutate({ action: "disconnectRepo", repositoryId: repo.id });
    }}>Disconnect</button></div>}</li>)}</ul>
    {canManage && <details className="ws-connect"><summary><span aria-hidden="true">＋</span> Connect a GitHub repository</summary><div className="ws-connection-help"><p>Use a repository-scoped fine-grained token from a repository administrator. Permissions: Contents, Pull requests and Webhooks read/write; Administration read. Enable squash and auto-merge in GitHub yourself.</p><p>The token is encrypted on the server and delegated to this workspace’s owners/admins. It is never returned to browsers. To rotate, disconnect and reconnect; revoke the old token in GitHub.</p></div>
      <form onSubmit={e => { e.preventDefault(); setNotice(""); mutation.mutate({ action: "connectRepo", repository }); }}>
        <label>Repository<input value={repository} onChange={e => setRepository(e.target.value)} required maxLength={200} pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" placeholder="owner/repository" /></label>
        <label>Fine-grained GitHub token<input ref={tokenInput} type="password" required minLength={20} maxLength={255} autoComplete="off" spellCheck={false} /></label>
        <button className="ws-primary" disabled={mutation.isPending}>Connect repository</button>
      </form></details>}
    <div className="ws-gx-note"><span className="ws-badge">How it works</span><p>GX runs in your checkout or CI runner. Cuecards enrolls eligible PRs in GitHub’s native auto-merge — never bypassing branch protections.</p></div>
    <details className="ws-terminal"><summary>GX setup & delivery commands</summary><p>Run in your repository after installing GitGuardex. These commands are guidance, not remote execution.</p><pre>{'gx setup\ngx status\ngx branch start --new --no-transfer "your task" "your agent"\n# Work in the printed worktree and claim files before editing.\ngx branch finish --branch "<agent-branch>" --via-pr --wait-for-merge --gate-review --gate-autofix --cleanup'}</pre></details>
  </section>;
}
