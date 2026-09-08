import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./studio/styles.css";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // 5s stale matches the server-side cache header from cue dashboard.
      // Avoids over-fetching while keeping data fresh enough for a refresh-on-action UX.
      staleTime: 5_000,
      // The dashboard is a single-tab tool — don't aggressively refetch on every focus.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
