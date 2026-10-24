import type { User } from "./api.ts";
import { Avatar, Icon } from "./ui.tsx";
import { displayName } from "./users.tsx";

export function Members({ users, online }: { users: User[]; online: number[] }) {
  const onlineSet = new Set(online);
  const isStaff = (u: User) => u.role === "owner" || u.role === "admin";
  const groups = [
    { label: "Admins", users: users.filter((u) => onlineSet.has(u.id) && isStaff(u)), offline: false },
    { label: "Online", users: users.filter((u) => onlineSet.has(u.id) && !isStaff(u)), offline: false },
    { label: "Offline", users: users.filter((u) => !onlineSet.has(u.id)), offline: true },
  ];

  return (
    <aside className="members">
      {groups.map(
        (g) =>
          g.users.length > 0 && (
            <section key={g.label}>
              <div className="category">
                {g.label} — {g.users.length}
              </div>
              {g.users.map((u) => (
                <div key={u.id} className={`member${g.offline ? " offline" : ""}`} title={`@${u.username}`}>
                  <span className="avatar-wrap">
                    <Avatar userId={u.id} name={displayName(u)} avatarUrl={u.avatarUrl} />
                    {!g.offline && <span className="status-dot" />}
                  </span>
                  <span className="name">{displayName(u)}</span>
                  {u.role === "owner" && (
                    <span className="owner-crown" title="Server owner">
                      <Icon name="crown" size={14} />
                    </span>
                  )}
                </div>
              ))}
            </section>
          ),
      )}
    </aside>
  );
}
