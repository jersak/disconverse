import { useEffect, useState } from "react";
import { api, type User } from "../api.ts";
import { Icon, type IconName } from "../ui.tsx";
import { Audit } from "./Audit.tsx";
import { Media } from "./Media.tsx";
import { OverviewPage } from "./Overview.tsx";
import { Storage } from "./Storage.tsx";
import { SudoProvider } from "./sudo.tsx";

type PageId = "overview" | "media" | "storage" | "audit";

const PAGES: { id: PageId; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "info" },
  { id: "media", label: "Media", icon: "screen" },
  { id: "storage", label: "Storage", icon: "people" },
  { id: "audit", label: "Audit log", icon: "settings" },
];

const pageFromHash = (): PageId => {
  const id = location.hash.slice(1);
  return PAGES.some((p) => p.id === id) ? (id as PageId) : "overview";
};

/** The owner's server admin panel, at /admin. */
export function AdminApp({ user }: { user: User }) {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .me()
      .then(({ permissions }) => setAllowed(permissions.includes("manageServer")))
      .catch(() => setAllowed(false));
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (allowed === null) return <div className="splash">Loading…</div>;
  if (!allowed) {
    return (
      <div className="splash admin-denied">
        <p>The admin panel is only available to the server owner.</p>
        <a href="/">Back to chat</a>
      </div>
    );
  }

  return (
    <SudoProvider>
      <div className="admin">
        <nav className="admin-nav">
          <a className="admin-back" href="/">
            ← Back to chat
          </a>
          <div className="settings-nav-title">Server admin</div>
          {PAGES.map((p) => (
            <a key={p.id} href={`#${p.id}`} className={p.id === page ? "active" : ""}>
              <Icon name={p.icon} size={18} />
              {p.label}
            </a>
          ))}
          <div className="admin-user">Signed in as {user.displayName ?? user.username}</div>
        </nav>
        <main className="admin-content">
          {page === "overview" && <OverviewPage />}
          {page === "media" && <Media />}
          {page === "storage" && <Storage />}
          {page === "audit" && <Audit />}
        </main>
      </div>
    </SudoProvider>
  );
}
