import { useCallback, useEffect, useRef, useState } from "react";
import { loadDeviceSettings } from "./devices.ts";
import { mentions } from "./mentions.ts";
import { loadAudioSettings } from "./noise.ts";
import { playMentionSound } from "./sounds.ts";
import {
  api,
  PAGE_SIZE,
  type Channel,
  type Message,
  type Permission,
  type ServerEvent,
  type User,
  type VoiceState,
} from "./api.ts";

type ChannelMessages = { messages: Message[]; hasMore: boolean };

const LAST_READ_KEY = "disconverse.lastRead";

function loadLastRead(): Record<number, number> {
  try {
    return JSON.parse(localStorage.getItem(LAST_READ_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveLastRead(lastRead: Record<number, number>) {
  try {
    localStorage.setItem(LAST_READ_KEY, JSON.stringify(lastRead));
  } catch {
    // Storage unavailable: unread markers just won't persist across reloads.
  }
}

/** Live connection to the server: channels, messages, presence, voice, and the user's permissions. */
export function useServer(initialUser: User, onUnauthorized: () => void) {
  const [user, setUser] = useState(initialUser);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<Record<number, ChannelMessages>>({});
  const [online, setOnline] = useState<number[]>([]);
  const [voice, setVoice] = useState<VoiceState>({});
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [lastRead, setLastRead] = useState(loadLastRead);
  /** Mentions of you per channel that arrived while you weren't looking at it (this session). */
  const [mentionCounts, setMentionCounts] = useState<Record<number, number>>({});
  const viewingRef = useRef<number | null>(null);
  const userRef = useRef(initialUser);
  userRef.current = user;
  /** Bumped when accounts or roles change, so the member list refetches. */
  const [usersVersion, setUsersVersion] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const loading = useRef(new Set<number>());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (ev) => {
        const event = JSON.parse(ev.data) as ServerEvent;
        switch (event.type) {
          case "hello":
            setUser(event.user);
            setPermissions(event.permissions);
            setChannels(event.channels);
            setOnline(event.online);
            setVoice(event.voice);
            // Anything may have happened while disconnected: reload history on demand.
            setMessages({});
            // Channels never seen before start out as read.
            setLastRead((prev) => {
              const next = { ...prev };
              for (const c of event.channels) if (!(c.id in next)) next[c.id] = c.latestMessageId ?? 0;
              saveLastRead(next);
              return next;
            });
            setReady(true);
            break;
          case "message": {
            const { message } = event;
            const me = userRef.current;
            if (message.userId !== me.id && mentions(message.content, me.id)) {
              const looking = viewingRef.current === message.channelId && document.hasFocus();
              if (!looking) {
                if (viewingRef.current !== message.channelId) {
                  setMentionCounts((prev) => ({ ...prev, [message.channelId]: (prev[message.channelId] ?? 0) + 1 }));
                }
                if (loadAudioSettings().mentionSound) playMentionSound(loadDeviceSettings().audiooutput);
              }
            }
            setMessages((prev) => {
              const current = prev[message.channelId];
              return current ? { ...prev, [message.channelId]: { ...current, messages: [...current.messages, message] } } : prev;
            });
            setChannels((prev) =>
              prev.map((c) => (c.id === message.channelId ? { ...c, latestMessageId: message.id } : c)),
            );
            break;
          }
          case "presence":
            setOnline(event.online);
            break;
          case "voice":
            setVoice(event.voice);
            break;
          case "channels":
            setChannels(event.channels);
            break;
          case "attachments-removed": {
            const removed = new Set(event.ids);
            setMessages((prev) => {
              const next: typeof prev = {};
              for (const [id, channel] of Object.entries(prev)) {
                next[Number(id)] = {
                  ...channel,
                  messages: channel.messages.map((m) =>
                    m.attachments.some((a) => removed.has(a.id))
                      ? { ...m, attachments: m.attachments.map((a) => (removed.has(a.id) ? { ...a, removed: true, url: "" } : a)) }
                      : m,
                  ),
                };
              }
              return next;
            });
            break;
          }
          case "users-changed":
            setUsersVersion((v) => v + 1);
            // Our own role may have changed.
            void api.me().then(({ user, permissions }) => {
              setUser(user);
              setPermissions(permissions);
            });
            break;
        }
      };
      ws.onclose = (ev) => {
        setConnected(false);
        if (stopped) return;
        if (ev.code === 4001) return onUnauthorizedRef.current();
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15_000));
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, []);

  /** Loads a channel's latest messages if they aren't loaded yet. */
  const loadChannel = useCallback(async (channelId: number) => {
    if (messagesRef.current[channelId] || loading.current.has(channelId)) return;
    loading.current.add(channelId);
    try {
      const { messages: page } = await api.messages(channelId);
      setMessages((prev) => ({ ...prev, [channelId]: { messages: page, hasMore: page.length >= PAGE_SIZE } }));
    } catch {
      // Channel deleted or connection lost; a later visit retries.
    } finally {
      loading.current.delete(channelId);
    }
  }, []);

  /** Loads the previous page of a channel. Resolves to true if any messages were added. */
  const loadOlder = useCallback(async (channelId: number) => {
    const current = messagesRef.current[channelId];
    const oldest = current?.messages[0];
    if (!current || !oldest || !current.hasMore || loading.current.has(channelId)) return false;
    loading.current.add(channelId);
    try {
      const { messages: older } = await api.messages(channelId, oldest.id);
      setMessages((prev) => {
        const cur = prev[channelId];
        if (!cur) return prev;
        return { ...prev, [channelId]: { messages: [...older, ...cur.messages], hasMore: older.length >= PAGE_SIZE } };
      });
      return older.length > 0;
    } catch {
      return false;
    } finally {
      loading.current.delete(channelId);
    }
  }, []);

  const send = useCallback((channelId: number, content: string, attachmentIds: string[] = []) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "send", channelId, content, attachments: attachmentIds }));
    return true;
  }, []);

  /** The text channel on screen (mentions there don't count as missed). */
  const setViewing = useCallback((channelId: number | null) => {
    viewingRef.current = channelId;
    if (channelId !== null) setMentionCounts((prev) => (prev[channelId] ? { ...prev, [channelId]: 0 } : prev));
  }, []);

  const markRead = useCallback((channelId: number, messageId: number | null) => {
    if (messageId === null) return;
    setLastRead((prev) => {
      if ((prev[channelId] ?? 0) >= messageId) return prev;
      const next = { ...prev, [channelId]: messageId };
      saveLastRead(next);
      return next;
    });
  }, []);

  const isUnread = (c: Channel) => c.type === "text" && (c.latestMessageId ?? 0) > (lastRead[c.id] ?? 0);

  /** Ask the server to refresh voice member lists now instead of on its next poll. */
  const notifyVoiceChanged = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "voice-changed" }));
  }, []);

  const can = (permission: Permission) => permissions.includes(permission);

  return {
    user,
    can,
    channels,
    messages,
    online,
    voice,
    connected,
    ready,
    usersVersion,
    loadChannel,
    loadOlder,
    send,
    markRead,
    isUnread,
    mentionCounts,
    setViewing,
    notifyVoiceChanged,
  };
}

export type Server = ReturnType<typeof useServer>;
