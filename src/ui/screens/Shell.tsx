import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { ApiError } from "../../shared/api";
import pkg from "../../../package.json";

const NAV = [
  { to: "/", label: "Decks", match: (p: string) => p === "/" || p.startsWith("/decks") },
  { to: "/kits/themes", label: "Themes" },
  { to: "/kits/templates", label: "Templates" },
  { to: "/kits/blueprints", label: "Blueprints" },
  { to: "/kits/media", label: "Media kits" },
  { to: "/settings", label: "Settings" },
];

export function Shell({
  children,
  crumb,
  actions,
  status,
  wide,
}: {
  children: ReactNode;
  crumb?: ReactNode;
  actions?: ReactNode;
  /** Extra items for the bottom status bar. */
  status?: ReactNode;
  /** Use the full window width (editor screens). */
  wide?: boolean;
}) {
  const { pathname } = useLocation();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Flipbook Studio home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <rect
                x="3"
                y="4"
                width="18"
                height="16"
                rx="2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M10 9l5 3-5 3z" fill="currentColor" />
            </svg>
          </span>
          FLIPBOOK <span>STUDIO</span>
        </Link>
        <span className="chip mono">v{pkg.version}</span>
        <span className="chip mono ok">
          <i className="dot" aria-hidden="true" />
          {location.host}
        </span>
        {crumb ? <span className="crumb">{crumb}</span> : null}
        {actions ? <div className="topbar-actions">{actions}</div> : null}
      </header>
      <nav className="kits-nav" aria-label="Kits">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={() =>
              (item.match ? item.match(pathname) : pathname.startsWith(item.to)) ? "active" : ""
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main className={wide ? "content wide" : "content"}>{children}</main>
      <footer className="statusbar mono">
        <span>
          <i className="dot" aria-hidden="true" /> sandbox: iframe srcdoc
        </span>
        {status}
        <span className="spacer" />
        <span>UTF-8</span>
      </footer>
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
