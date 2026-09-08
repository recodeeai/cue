import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signOut, useSession } from "../lib/auth-client";
import { AuthGate } from "../studio/views/Api";
import { workspaceApi, type Workspace, type WorkspaceDetail } from "./api";
import "./workspaces.css";
import { Repositories } from "./Repositories";

export function WorkspacesPage() {
  const { data: session, isPending, error, refetch } = useSession();
  const [invitation, setInvitation] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("invite") ?? "");
  const navigate = useNavigate();
  useEffect(() => { if (window.location.hash) void navigate({ hash: "", replace: true }); }, [navigate]);
  return <main className="ws-shell">
    <header className="ws-top"><Link to="/" className="ws-brand"><span className="ws-brand-mark" aria-hidden="true">c</span>cue<span>cards</span></Link><span className="ws-top-context">Workspace console</span><Link to="/" className="ws-studio-link">Back to Studio <span aria-hidden="true">↗</span></Link></header>
    {isPending ? <p role="status">Loading your account…</p> : error ? <div role="alert">Account service unavailable. <button onClick={() => void refetch()}>Retry</button></div>
      : session ? <AccountWorkspaces key={session.user.id} userId={session.user.id} email={session.user.email} invitation={invitation} onAccepted={() => setInvitation("")} />
      : <><section className="ws-intro"><p className="ws-eyebrow">YOUR CODE. YOUR TEAM.</p><h1>One place to work together.</h1><p>Private by default. Invite your team when you’re ready.</p>{invitation && <p role="status">Sign in first, then accept your workspace invitation.</p>}</section><AuthGate workspace /></>}
  </main>;
}

// A separate cache lifetime per authenticated identity prevents stale user data
// from surviving sign-out/account switches, including requests still in flight.
function AccountWorkspaces(props: { userId: string; email: string; invitation: string; onAccepted: () => void }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000, refetchOnWindowFocus: true } } }));
  useEffect(() => () => { void client.cancelQueries(); client.clear(); }, [client]);
  return <QueryClientProvider client={client}><WorkspaceHome {...props} /></QueryClientProvider>;
}

function WorkspaceHome({ userId, email, invitation, onAccepted }: { userId: string; email: string; invitation: string; onAccepted: () => void }) {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [authError, setAuthError] = useState("");
  const list = useQuery({ queryKey: ["workspaces", userId], queryFn: ({ signal }) => workspaceApi<Workspace[]>(undefined, undefined, signal) });
  const selected = search.workspace ?? list.data?.[0]?.id;
  const mutation = useMutation({
    mutationFn: (action: Record<string, unknown>) => workspaceApi<{ id: string }>(action),
    onSuccess: async (result, action) => {
      await client.invalidateQueries({ queryKey: ["workspaces", userId] });
      if (action.action === "acceptInvite") onAccepted();
      setName("");
      void navigate({ to: "/workspaces", search: { workspace: result.id } });
    },
  });
  return <>
    <section className="ws-intro ws-overview"><div><p className="ws-eyebrow">YOUR WORK, CONNECTED</p><h1>Workspace overview</h1></div><div className="ws-account"><span className="ws-avatar" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span><span className="ws-account-email">{email}</span><button disabled={signingOut} onClick={async () => {
      setSigningOut(true); setAuthError("");
      try { const result = await signOut(); if (result.error) setAuthError(result.error.message ?? "Sign out failed."); else client.clear(); }
      catch { setAuthError("Sign out failed. Please retry."); }
      finally { setSigningOut(false); }
    }}>Sign out</button></div>{authError && <p role="alert">{authError}</p>}</section>
    {invitation && <section className="ws-card ws-invitation"><h2>You’ve been invited</h2><p>Accept to join the shared workspace with your current account.</p><button className="ws-primary" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "acceptInvite", token: invitation })}>Accept invitation</button><button onClick={onAccepted}>Dismiss</button></section>}
    {mutation.error && <p className="ws-error" role="alert">{mutation.error.message}</p>}
    <div className="ws-layout">
      <aside className="ws-card ws-sidebar"><div className="ws-section-heading"><h2>Your workspaces</h2>{list.data && <span className="ws-count">{list.data.length}</span>}</div>
        {list.isPending && <p role="status">Loading workspaces…</p>}
        {list.error && <p role="alert">{list.error.message} <button onClick={() => void list.refetch()}>Retry</button></p>}
        <nav aria-label="Your workspaces">{list.data?.map(item => <Link key={item.id} to="/workspaces" search={{ workspace: item.id }} aria-current={selected === item.id ? "page" : undefined} className={selected === item.id ? "ws-nav active" : "ws-nav"}><span className="ws-workspace-icon" aria-hidden="true">{item.kind === "personal" ? "P" : item.name.slice(0, 2).toUpperCase()}</span><span><strong>{item.name}</strong><small>{item.kind} · {item.role}</small></span></Link>)}</nav>
        <details className="ws-create"><summary><span aria-hidden="true">＋</span> New workspace</summary><form onSubmit={e => { e.preventDefault(); mutation.mutate({ action: "create", name }); }}><label>New team workspace<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Platform team" /></label><button className="ws-primary" disabled={mutation.isPending || !name.trim()}>Create workspace</button></form></details>
        <p className="ws-sidebar-note">Personal space. Shared possibilities.<br />You choose who gets access.</p>
      </aside>
      {selected && <WorkspacePanel key={selected} userId={userId} id={selected} />}
    </div>
  </>;
}

function WorkspacePanel({ userId, id }: { userId: string; id: string }) {
  const client = useQueryClient();
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [freshLink, setFreshLink] = useState("");
  const detail = useQuery({ queryKey: ["workspace", userId, id], queryFn: ({ signal }) => workspaceApi<WorkspaceDetail>(undefined, id, signal), refetchInterval: 15000 });
  const mutation = useMutation({
    mutationFn: (action: Record<string, unknown>) => workspaceApi<{ id: string; token?: string }>({ workspaceId: id, ...action }),
    onSuccess: async result => {
      if (result.token) setFreshLink(`${window.location.origin}/workspaces#invite=${result.token}`);
      await client.invalidateQueries({ queryKey: ["workspace", userId, id] });
    },
  });
  if (detail.isPending) return <section className="ws-card" role="status">Loading workspace…</section>;
  // Do not keep rendering cached private data after permission has been revoked.
  if (detail.error) return <section className="ws-card" role="alert">{detail.error.message} <button onClick={() => void detail.refetch()}>Retry</button></section>;
  if (!detail.data) return null;
  const { workspace, members, invites } = detail.data;
  const canManage = workspace.role !== "member";
  return <section className="ws-content">
    <div className="ws-card ws-workspace-header"><div className="ws-workspace-title"><span className="ws-workspace-icon ws-workspace-icon-lg" aria-hidden="true">{workspace.kind === "personal" ? "P" : workspace.name.slice(0, 2).toUpperCase()}</span><div><div className="ws-badges"><span className="ws-badge">{workspace.kind} workspace</span><span className="ws-role">{workspace.role}</span></div><h2>{workspace.name}</h2></div></div><p>{workspace.kind === "personal" ? "Only you can access this workspace. Create a team workspace to collaborate." : "A shared space for your repositories and the people behind them."}</p><div className="ws-workspace-meta"><span><strong>{detail.data.repositories.length}</strong> repositories</span><span><strong>{members.length}</strong> {members.length === 1 ? "member" : "members"}</span><span>Access by invitation{workspace.kind === "personal" ? " · teams only" : ""}</span></div></div>
    {mutation.error && <p role="alert" className="ws-error">{mutation.error.message}</p>}
    <div className="ws-panel-grid"><Repositories workspaceId={id} userId={userId} role={workspace.role} repositories={detail.data.repositories} />
    <div className="ws-team-column"><section className="ws-card"><div className="ws-section-heading"><h2>People</h2><span className="ws-count">{members.length}</span></div><p className="ws-section-caption">The people with access to this workspace.</p>
      <ul className="ws-members">{members.map(member => <li key={member.id}><div className="ws-member-identity"><span className="ws-avatar" aria-hidden="true">{member.name.slice(0, 2).toUpperCase()}</span><div><strong>{member.name}</strong><small>{member.role}{member.id === userId ? " · you" : ""}</small></div></div>
        {workspace.kind === "team" && canManage && member.role !== "owner" && (workspace.role === "owner" || member.role === "member") && <div className="ws-actions">
          {workspace.role === "owner" && <button disabled={mutation.isPending} onClick={() => { if (window.confirm(`Change ${member.name} to ${member.role === "admin" ? "member" : "admin"}?`)) mutation.mutate({ action: "setRole", userId: member.id, role: member.role === "admin" ? "member" : "admin" }); }}>{member.role === "admin" ? "Make member" : "Make admin"}</button>}
          <button disabled={mutation.isPending} onClick={() => { if (window.confirm(`Remove ${member.name} from this workspace?`)) mutation.mutate({ action: "removeMember", userId: member.id }); }}>Remove</button>
        </div>}
      </li>)}</ul>
    </section>
    {workspace.kind === "team" && canManage && <section className="ws-card ws-invite-card"><span className="ws-invite-symbol" aria-hidden="true">＋</span><h2>Better together.</h2><p>Invite your team with a private link.</p><p className="ws-section-caption">One use · expires in 7 days. Anyone signed in with this link can join. Share it privately.</p>
      <form onSubmit={e => { e.preventDefault(); setFreshLink(""); mutation.mutate({ action: "invite", role: inviteRole }); }}><label>Invitation role<select value={inviteRole} onChange={e => setInviteRole(e.target.value as "admin" | "member")}><option value="member">Member — view workspace</option>{workspace.role === "owner" && <option value="admin">Admin — manage repos and members</option>}</select></label><button className="ws-primary" disabled={mutation.isPending}>Create invite link</button></form>
      {freshLink && <div role="status"><label>Copy this link now — it is shown only once<input aria-label="Invitation link" readOnly value={freshLink} onFocus={e => e.target.select()} /></label><button onClick={() => setFreshLink("")}>Hide link</button></div>}
      <ul className="ws-members">{invites.map(invite => <li key={invite.id}><div><strong>{invite.role} invitation</strong><small>Expires {new Date(invite.expires_at).toLocaleDateString()}</small></div>{(workspace.role === "owner" || invite.role === "member") && <button disabled={mutation.isPending} onClick={() => { setFreshLink(""); mutation.mutate({ action: "revokeInvite", inviteId: invite.id }); }}>Revoke</button>}</li>)}</ul>
    </section>}</div></div>
  </section>;
}
