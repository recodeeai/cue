import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Repositories } from "./Repositories";
import type { Role, WorkspaceDetail } from "./api";

function render(role: Role, repositories: WorkspaceDetail["repositories"] = []) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <Repositories workspaceId="workspace" userId="user" role={role} repositories={repositories} />
  </QueryClientProvider>);
}

test("repository empty state is actionable without claiming configured gates", () => {
  const html = render("owner");
  expect(html).toContain("Connect your first repository");
  expect(html).toContain("<summary");
  expect(html).toContain("Connect a GitHub repository");
  expect(html).toContain('type="password"');
  expect(html).toContain('autoComplete="off"');
  expect(html).toContain("delegated to this workspace’s owners/admins");
  expect(html).toContain("never bypassing branch protections");
  expect(html).not.toContain("All checks passed");
});

test("read-only members see guidance, never repository management forms", () => {
  const html = render("member");
  expect(html).toContain("Ask a workspace owner or admin to connect a repository.");
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain("Connect repository</button>");
});

test("connected repositories retain real statuses and guarded management actions", () => {
  const repos = [{ id: "repo", full_name: "owner/project", auto_merge: false, last_event_at: null, last_result: null }];
  const owner = render("owner", repos);
  expect(owner).toContain('href="https://github.com/owner/project"');
  expect(owner).toContain("Auto-enrollment paused");
  expect(owner).toContain("Queue after gate check");
  expect(owner).toContain("Enable auto-enrollment");
  expect(owner).toContain("Disconnect");
  expect(owner).not.toContain("Connect your first repository");
  const member = render("member", repos);
  expect(member).not.toContain("Enable auto-enrollment");
  expect(member).not.toContain("Existing PR number");
  expect(member).not.toContain("Disconnect");
});
