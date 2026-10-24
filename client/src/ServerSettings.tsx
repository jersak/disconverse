import { useCallback, useEffect, useState } from "react";
import { api, type Invite, type User } from "./api.ts";
import { Avatar, Icon } from "./ui.tsx";
import type { Server } from "./useServer.ts";
import { displayName } from "./users.tsx";

type Tab = "invites" | "members";

/** Invites (admins) and member roles (owner). */
export function ServerSettings({ server, users, onClose }: { server: Server; users: User[]; onClose: () => void }) {
  const tabs: { id: Tab; label: string }[] = [
    ...(server.can("manageInvites") ? [{ id: "invites" as const, label: "Invites" }] : []),
    ...(server.can("manageRoles") ? [{ id: "members" as const, label: "Members & Roles" }] : []),
  ];
  const [tab, setTab] = useState<Tab | undefined>(tabs[0]?.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Server Settings</h2>
          <button className="icon-button" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </header>
        {server.can("manageServer") && (
          <a className="admin-link" href="/admin">
            Open the admin panel: storage, media cleanup and audit log →
          </a>
        )}
        {tabs.length > 1 && (
          <div className="tabs">
            {tabs.map((t) => (
              <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        {tab === "invites" && <Invites />}
        {tab === "members" && <Roles users={users} />}
      </div>
    </div>
  );
}

function Invites() {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .invites()
      .then(({ invites }) => setInvites(invites))
      .catch((err) => setError(err.message));
  }, []);
  useEffect(reload, [reload]);

  const create = async () => {
    setError(null);
    try {
      const { code } = await api.createInvite();
      setFresh(code);
      setCopied(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create an invite");
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard blocked: the code is selectable on screen.
    }
  };

  const unused = invites?.filter((i) => !i.usedBy) ?? [];
  const used = invites?.filter((i) => i.usedBy) ?? [];

  return (
    <section>
      <p className="hint">
        Each invite code works once. Send it to a friend; they choose "Create an account" on the login screen.
      </p>
      <button className="primary" onClick={create}>
        Create invite
      </button>
      {fresh && (
        <div className="fresh-invite">
          <code>{fresh}</code>
          <button className="secondary" onClick={() => copy(fresh)}>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}

      <h3>Unused invites</h3>
      {invites === null ? (
        <p className="hint">Loading…</p>
      ) : unused.length === 0 ? (
        <p className="hint">None.</p>
      ) : (
        <ul className="settings-list">
          {unused.map((i) => (
            <li key={i.code}>
              <code>{i.code}</code>
              <span className="hint">{i.createdBy ? `by ${i.createdBy}` : "from server"}</span>
              <button
                className="danger-link"
                onClick={() =>
                  void api
                    .revokeInvite(i.code)
                    .then(reload)
                    .catch((err) => setError(err.message))
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {used.length > 0 && (
        <>
          <h3>Used</h3>
          <ul className="settings-list">
            {used.map((i) => (
              <li key={i.code}>
                <code className="used">{i.code}</code>
                <span className="hint">joined as {i.usedBy}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Roles({ users }: { users: User[] }) {
  const [error, setError] = useState<string | null>(null);

  const change = async (user: User, role: "admin" | "member") => {
    setError(null);
    try {
      await api.setRole(user.id, role); // the member list refreshes via the users-changed event
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the role");
    }
  };

  return (
    <section>
      <p className="hint">Admins can create, rename and delete channels, and create invites.</p>
      {error && <div className="form-error">{error}</div>}
      <ul className="settings-list">
        {users.map((u) => (
          <li key={u.id}>
            <Avatar userId={u.id} name={displayName(u)} avatarUrl={u.avatarUrl} size={28} />
            <span className="settings-name">
              {displayName(u)}
              {u.displayName && <span className="hint"> @{u.username}</span>}
            </span>
            {u.role === "owner" ? (
              <span className="role-tag">
                <Icon name="crown" size={14} /> Owner
              </span>
            ) : (
              <select value={u.role} onChange={(e) => void change(u, e.target.value as "admin" | "member")}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
