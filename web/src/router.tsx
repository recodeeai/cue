import { createRootRoute, createRoute, createRouter, Link, Outlet, redirect } from "@tanstack/react-router";
import { StudioApp, type View } from "./studio/StudioApp";
import { WorkspacesPage } from "./workspaces/Workspaces";
import { parseStudioView, parseWorkspaceSearch } from "./route-search";
import { isDemoMode } from "./lib/fetcher";

const root = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <main className="ws-shell"><h1>Page not found</h1><Link to="/">Back to Studio</Link></main>,
  errorComponent: () => <main className="ws-shell"><h1>This page could not load</h1><a href="/">Reload Studio</a></main>,
});
const home = createRoute({
  getParentRoute: () => root, path: "/", component: StudioRoute,
  validateSearch: (raw: Record<string, unknown>): { view?: View } => ({ view: parseStudioView(raw.view) }),
});
function StudioRoute() {
  const { view } = home.useSearch();
  const navigate = home.useNavigate();
  return <StudioApp view={view ?? (isDemoMode() ? "welcome" : "inventory")} onViewChange={next => void navigate({ search: { view: next } })} />;
}
const legacyStudio = createRoute({
  getParentRoute: () => root, path: "/studio/$view",
  beforeLoad: ({ params }) => { throw redirect({ to: "/", search: { view: parseStudioView(params.view) } }); },
});
const workspaces = createRoute({
  getParentRoute: () => root, path: "/workspaces", component: WorkspacesPage,
  validateSearch: parseWorkspaceSearch,
});
export const router = createRouter({ routeTree: root.addChildren([home, workspaces, legacyStudio]) });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
