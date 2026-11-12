import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ApiError } from "../../shared/api";

export function Shell({ children, crumb }: { children: ReactNode; crumb?: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          FLIPBOOK <span>STUDIO</span>
        </Link>
        {crumb ? <span className="crumb">{crumb}</span> : null}
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

export function ErrorNotice({ error }: { error: ApiError }) {
  return (
    <div className="error" role="alert">
      {error.path ? <strong className="error-path">{error.path}</strong> : null}
      <p>{error.message}</p>
      {Array.isArray(error.details?.violations) ? (
        <ul>
          {(error.details.violations as string[]).map((violation) => (
            <li key={violation}>{violation}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
