import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ApiError } from "../../shared/api";

export function Shell({
  children,
  crumb,
  actions,
}: {
  children: ReactNode;
  crumb?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          FLIPBOOK <span>STUDIO</span>
        </Link>
        <nav className="kits-nav" aria-label="Kits">
          <Link to="/kits/themes">Themes</Link>
        </nav>
        {crumb ? <span className="crumb">{crumb}</span> : null}
        {actions ? <div className="topbar-actions">{actions}</div> : null}
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
          {(error.details.violations as (string | { message: string })[]).map((violation) => {
            // Load errors carry strings; BLUEPRINT_FAILED carries Violation objects.
            const text = typeof violation === "string" ? violation : violation.message;
            return <li key={text}>{text}</li>;
          })}
        </ul>
      ) : null}
    </div>
  );
}
