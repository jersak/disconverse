import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Channel, type ChannelType, type User } from "./api.ts";
import { ChannelDialog } from "./ChannelDialog.tsx";
import { AdminApp } from "./admin/AdminApp.tsx";
import { Chat } from "./Chat.tsx";
import { Login } from "./Login.tsx";
import { Members } from "./Members.tsx";
import { ServerSettings } from "./ServerSettings.tsx";
import { Sidebar, type Selection } from "./Sidebar.tsx";
import { Stage } from "./Stage.tsx";
import { useServer } from "./useServer.ts";
import { UsersProvider } from "./users.tsx";
import { useVoice } from "./useVoice.ts";
import { Settings } from "./Settings.tsx";

const LAST_CHANNEL_KEY = "disconverse.lastChannel";

export function App() {
  // undefined = still checking the session cookie
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="splash">Loading…</div>;
  if (!user) return <Login onLogin={setUser} />;
  if (location.pathname.startsWith("/admin")) return <AdminApp user={user} />;
  return <Main initialUser={user} onLoggedOut={() => setUser(null)} />;
}

function readLastChannel(): number | null {
  try {
    return Number(localStorage.getItem(LAST_CHANNEL_KEY)) || null;
  } catch {
    return null;
  }
}

function Main({ initialUser, onLoggedOut }: { initialUser: User; onLoggedOut: () => void }) {
  const server = useServer(initialUser, onLoggedOut);
  const voice = useVoice(server.notifyVoiceChanged);
  const [users, setUsers] = useState<User[]>([]);

  // Refetch the member list when accounts/roles change or someone unknown comes online.
  const unknownOnline = server.online.some((id) => !users.some((u) => u.id === id));
  useEffect(() => {
    api
      .users()
      .then(({ users }) => setUsers(users))
      .catch(() => {});
  }, [unknownOnline, server.usersVersion]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const logout = useCallback(async () => {
    voice.leave();
    await api.logout().catch(() => {});
    onLoggedOut();
  }, [voice.leave, onLoggedOut]);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [qualityMenu, setQualityMenu] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const [channelDialog, setChannelDialog] = useState<{ type: ChannelType; channel?: Channel } | null>(null);
  // Small screens show one column; channels and members slide in as drawers.
  const [drawer, setDrawer] = useState<"channels" | "members" | null>(null);

  const textChannels = server.channels.filter((c) => c.type === "text");
  const selected = selection ? server.channels.find((c) => c.id === selection.channelId) : undefined;

  // Pick a text channel once channels arrive, and fall back if the selected one is deleted.
  useEffect(() => {
    if (!server.ready || selected) return;
    const remembered = textChannels.find((c) => c.id === readLastChannel());
    const fallback = remembered ?? textChannels[0];
    if (fallback) setSelection({ kind: "text", channelId: fallback.id });
  }, [server.ready, selected, textChannels]);

  useEffect(() => {
    server.setViewing(selected?.type === "text" ? selected.id : null);
  }, [selected?.id, selected?.type]);

  // Viewing a text channel: load it and mark it read as messages arrive.
  useEffect(() => {
    if (selected?.type !== "text") return;
    void server.loadChannel(selected.id);
    server.markRead(selected.id, selected.latestMessageId);
    try {
      localStorage.setItem(LAST_CHANNEL_KEY, String(selected.id));
    } catch {
      // not essential
    }
  }, [selected?.id, selected?.type, selected?.latestMessageId]);

  const select = (next: Selection) => {
    setSelection(next);
    setDrawer(null);
    if (next.kind === "voice" && voice.channelId !== next.channelId) void voice.join(next.channelId);
  };

  const channelMessages = selected?.type === "text" ? server.messages[selected.id] : undefined;

  return (
    <UsersProvider value={usersById}>
    <div className={`app${drawer ? ` show-${drawer}` : ""}`}>
      <Sidebar
        user={server.user}
        server={server}
        voice={voice}
        selection={selection}
        onSelect={select}
        onShareScreen={() => {
          if (voice.channelId) setSelection({ kind: "voice", channelId: voice.channelId });
          setDrawer(null);
          setQualityMenu(true);
        }}
        onCreateChannel={(type) => setChannelDialog({ type })}
        onEditChannel={(channel) => setChannelDialog({ type: channel.type, channel })}
        onOpenServerSettings={() => setServerSettingsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={logout}
      />
      {selected?.type === "voice" ? (
        <Stage
          voice={voice}
          channel={selected}
          qualityMenu={qualityMenu}
          setQualityMenu={setQualityMenu}
          onJoin={() => void voice.join(selected.id)}
          onOpenChannels={() => setDrawer("channels")}
        />
      ) : selected ? (
        <Chat
          key={selected.id}
          myId={server.user.id}
          channel={selected}
          messages={channelMessages?.messages ?? []}
          loaded={!!channelMessages}
          hasMore={channelMessages?.hasMore ?? false}
          connected={server.connected}
          send={(content, attachmentIds) => server.send(selected.id, content, attachmentIds)}
          loadOlder={() => server.loadOlder(selected.id)}
          onOpenChannels={() => setDrawer("channels")}
          onOpenMembers={() => setDrawer("members")}
        />
      ) : (
        <main className="chat" />
      )}
      <Members users={users} online={server.online} />
      {drawer && <div className="scrim" onClick={() => setDrawer(null)} />}
      {settingsOpen && <Settings user={server.user} voice={voice} onClose={() => setSettingsOpen(false)} />}
      {serverSettingsOpen && (
        <ServerSettings server={server} users={users} onClose={() => setServerSettingsOpen(false)} />
      )}
      {channelDialog && (
        <ChannelDialog type={channelDialog.type} channel={channelDialog.channel} onClose={() => setChannelDialog(null)} />
      )}
    </div>
    </UsersProvider>
  );
}
