import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFound,
});

function RootComponent() {
  return <Outlet />;
}

function NotFound() {
  return (
    <div className="page narrow center-v">
      <div className="panel notfound">
        <h1>404</h1>
        <p className="muted">Nothing lives at this address.</p>
        <Link to="/" className="btn btn-primary">
          Back home
        </Link>
      </div>
    </div>
  );
}
