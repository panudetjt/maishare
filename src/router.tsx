import { createRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPreloadStaleTime: 10_000,
  scrollRestoration: true,
  defaultPendingComponent: DefaultPending,
  defaultErrorComponent: DefaultError,
});

function DefaultPending() {
  return (
    <div className="page">
      <div className="skeleton skeleton-hero" />
    </div>
  );
}

function DefaultError({ error }: ErrorComponentProps) {
  return (
    <div className="page narrow center-v">
      <div className="panel notfound">
        <h2>Something broke</h2>
        <p className="muted">{error instanceof Error ? error.message : String(error)}</p>
      </div>
    </div>
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
