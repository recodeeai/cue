export type Role = "owner" | "admin" | "member";
export type Workspace = { id: string; name: string; kind: "personal" | "team"; role: Role };
export type WorkspaceDetail = {
  workspace: Workspace;
  members: { id: string; name: string; role: Role }[];
  invites: { id: string; role: "admin" | "member"; expires_at: string; created_by: string }[];
  repositories: { id: string; full_name: string; auto_merge: boolean; last_event_at: string | null; last_result: string | null }[];
};

export async function workspaceApi<T>(action?: Record<string, unknown>, id?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/workspaces${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
    method: action ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
    ...(action ? { headers: { "content-type": "application/json" }, body: JSON.stringify(action) } : {}),
  });
  let result: { ok: boolean; data: T; error?: { message?: string } };
  try { result = await response.json(); } catch { throw new Error("Workspace service unavailable. Please retry."); }
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? "Workspace request failed.");
  return result.data;
}
