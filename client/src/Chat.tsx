import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Attachment, Channel, Message, User } from "./api.ts";
import { EmbedCard } from "./EmbedCard.tsx";
import { embedKey, isGif, parseEmbed, type Embed } from "./embeds.ts";
import { GifEmbed } from "./GifEmbed.tsx";
import { ExpressionPicker, type PickerTab } from "./ExpressionPicker.tsx";
import { useGifSearch } from "./GifPicker.tsx";
import { Avatar, formatTime, formatTimestamp, Icon } from "./ui.tsx";
import { useUploads } from "./useUploads.ts";
import { encodeMentions, MENTION_TOKEN, mentionQueryAt, mentions, suggestUsers } from "./mentions.ts";
import { displayName, profileOf, useUsers } from "./users.tsx";

const GROUP_WINDOW_MS = 7 * 60 * 1000;
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
const MEDIA_MAX_WIDTH = 400;
const MEDIA_MAX_HEIGHT = 350;
const MAX_EMBEDS = 3;

function linkify(text: string, keyPrefix: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={`${keyPrefix}-${i}`} href={part} target="_blank" rel="noreferrer noopener">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

/** Message text with clickable links and "@Name" chips for mentions. */
function renderContent(text: string, users: Map<number, User>, myId: number): ReactNode[] {
  const parts = text.split(MENTION_TOKEN); // [text, id, text, id, ...]
  return parts.flatMap((part, i): ReactNode[] => {
    if (i % 2 === 0) return linkify(part, String(i));
    const user = users.get(Number(part));
    return [
      <span key={`m${i}`} className={`mention${Number(part) === myId ? " me" : ""}`} title={user ? `@${user.username}` : undefined}>
        @{user ? displayName(user) : "unknown-user"}
      </span>,
    ];
  });
}

function AttachmentView({ attachment: a, onOpen }: { attachment: Attachment; onOpen: (a: Attachment) => void }) {
  if (a.removed) {
    return (
      <div className="attachment-removed" title={a.filename}>
        {a.mime.startsWith("image/") ? "Image" : "Video"} removed by an admin
      </div>
    );
  }
  // Reserve the final size up front so the chat doesn't jump when media loads.
  const scale = a.width && a.height ? Math.min(1, MEDIA_MAX_WIDTH / a.width, MEDIA_MAX_HEIGHT / a.height) : 1;
  const style =
    a.width && a.height
      ? { width: Math.round(a.width * scale), aspectRatio: `${a.width} / ${a.height}` }
      : { maxWidth: MEDIA_MAX_WIDTH, maxHeight: MEDIA_MAX_HEIGHT };

  if (a.mime.startsWith("image/")) {
    return <img className="attachment" src={a.url} alt={a.filename} style={style} loading="lazy" onClick={() => onOpen(a)} />;
  }
  return (
    <div className="attachment-video">
      <video
        className="attachment"
        src={a.url}
        poster={a.thumbUrl ?? undefined}
        style={style}
        controls
        preload="metadata"
        playsInline
      />
      <a href={a.url} download={a.filename}>
        {a.filename}
      </a>
    </div>
  );
}

/** Playable video links in a message (deduplicated, at most MAX_EMBEDS). */
function findEmbeds(content: string): { embed: Embed; url: string }[] {
  const found = new Map<string, { embed: Embed; url: string }>();
  for (const url of content.match(URL_RE) ?? []) {
    const embed = parseEmbed(url);
    if (embed && !found.has(embedKey(embed))) found.set(embedKey(embed), { embed, url });
    if (found.size >= MAX_EMBEDS) break;
  }
  return [...found.values()];
}

function MessageBody({ message, myId, onOpen }: { message: Message; myId: number; onOpen: (a: Attachment) => void }) {
  const users = useUsers();
  const embeds = findEmbeds(message.content);
  // A message that is just a GIF link shows only the GIF, like Discord.
  const onlyGif = embeds.length === 1 && isGif(embeds[0]!.embed) && message.content.trim() === embeds[0]!.url;
  return (
    <>
      {message.content && !onlyGif && <div className="content">{renderContent(message.content, users, myId)}</div>}
      {message.attachments.length > 0 && (
        <div className="attachments">
          {message.attachments.map((a) => (
            <AttachmentView key={a.id} attachment={a} onOpen={onOpen} />
          ))}
        </div>
      )}
      {embeds.map(({ embed, url }) =>
        isGif(embed) ? (
          <GifEmbed key={embedKey(embed)} embed={embed} url={url} />
        ) : (
          <EmbedCard key={embedKey(embed)} embed={embed} url={url} />
        ),
      )}
    </>
  );
}

export function Chat({
  myId,
  channel,
  messages,
  loaded,
  hasMore,
  connected,
  send,
  loadOlder,
  onOpenChannels,
  onOpenMembers,
}: {
  myId: number;
  channel: Channel;
  messages: Message[];
  /** False until the channel's first page has arrived. */
  loaded: boolean;
  hasMore: boolean;
  connected: boolean;
  send: (content: string, attachmentIds: string[]) => boolean;
  loadOlder: () => Promise<boolean>;
  onOpenChannels: () => void;
  onOpenMembers: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [dragging, setDragging] = useState(false);
  // Enter pressed while files were still uploading: send once they finish.
  const [sendQueued, setSendQueued] = useState(false);
  const [picker, setPicker] = useState<PickerTab | null>(null);
  // The GIF button only appears when the server's GIF search works (verified API key).
  const gifProvider = useGifSearch() ?? null;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Where the caret was in the message box, so emoji go there even after clicking the picker. */
  const caret = useRef({ start: 0, end: 0 });
  const rememberCaret = () => {
    const ta = textareaRef.current;
    if (ta) caret.current = { start: ta.selectionStart, end: ta.selectionEnd };
  };

  const insertText = (text: string) => {
    const { start, end } = caret.current;
    setDraft((d) => {
      const from = Math.min(start, d.length);
      return d.slice(0, from) + text + d.slice(Math.min(end, d.length));
    });
    const position = Math.min(start, draft.length) + text.length;
    caret.current = { start: position, end: position };
  };

  // A picker button toggles the picker, or switches tabs when it is open on the other one.
  const togglePicker = (tab: PickerTab) => setPicker((open) => (open === tab ? null : tab));
  const uploads = useUploads();
  const users = useUsers();
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const heightBeforePrepend = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (heightBeforePrepend.current !== null) {
      // Older messages were added above: keep the visible ones in place.
      el.scrollTop += el.scrollHeight - heightBeforePrepend.current;
      heightBeforePrepend.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Content that grows after rendering (embed titles, media without known size) keeps the view
  // pinned to the bottom if it was there.
  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current && heightBeforePrepend.current === null) list.scrollTop = list.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 200 && hasMore && heightBeforePrepend.current === null) {
      heightBeforePrepend.current = el.scrollHeight;
      void loadOlder().then((added) => {
        if (!added) heightBeforePrepend.current = null;
      });
    }
  };

  const sendNow = () => {
    const content = encodeMentions(draft.trim(), [...users.values()]);
    if (!content && !uploads.readyIds.length) return;
    if (send(content, uploads.readyIds)) {
      setDraft("");
      uploads.clear();
      stickToBottom.current = true;
    }
  };

  useEffect(() => {
    if (sendQueued && !uploads.uploading) {
      setSendQueued(false);
      sendNow();
    }
  });

  // ---- @mention autocomplete
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const suggestions = mentionQuery ? suggestUsers([...users.values()], mentionQuery.query) : [];

  const updateMentionQuery = (text: string, caretPos: number) => {
    const next = mentionQueryAt(text, caretPos);
    setMentionQuery(next);
    if (next?.query !== mentionQuery?.query) setMentionIndex(0);
  };

  const insertMention = (user: User) => {
    if (!mentionQuery) return;
    const end = mentionQuery.start + 1 + mentionQuery.query.length;
    const insert = `@${user.username} `;
    const next = draft.slice(0, mentionQuery.start) + insert + draft.slice(end);
    setDraft(next);
    setMentionQuery(null);
    const caretPos = mentionQuery.start + insert.length;
    caret.current = { start: caretPos, end: caretPos };
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caretPos, caretPos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        insertMention(suggestions[Math.min(mentionIndex, suggestions.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (uploads.uploading) setSendQueued(true);
    else sendNow();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return; // plain text paste
    e.preventDefault();
    uploads.add(files);
  };

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    uploads.add([...e.dataTransfer.files]);
  };

  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setViewing(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  return (
    <main className="chat" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="chat-header">
        <button className="icon-button mobile-only channels-toggle" onClick={onOpenChannels} title="Channels">
          <Icon name="menu" />
        </button>
        <span className="hash">#</span>
        <span className="chat-title">{channel.name}</span>
        {!connected && <span className="reconnecting">Reconnecting…</span>}
        <button className="icon-button mobile-only members-toggle" onClick={onOpenMembers} title="Members">
          <Icon name="people" />
        </button>
      </header>

      <div className="messages" ref={listRef} onScroll={onScroll}>
        <div ref={contentRef}>
        {loaded && !hasMore && (
          <div className="channel-start">
            <div className="channel-start-icon">#</div>
            <h2>Welcome to #{channel.name}!</h2>
            <p>This is the start of the #{channel.name} channel.</p>
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = prev && prev.userId === m.userId && m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
          const author = profileOf(users, m.userId, m.username);
          return grouped ? (
            <div key={m.id} className={`message compact${mentions(m.content, myId) ? " mentioned" : ""}`}>
              <span className="gutter-time">{formatTime(m.createdAt)}</span>
              <div className="body">
                <MessageBody message={m} myId={myId} onOpen={setViewing} />
              </div>
            </div>
          ) : (
            <div key={m.id} className={`message${mentions(m.content, myId) ? " mentioned" : ""}`}>
              <Avatar userId={m.userId} name={author.name} avatarUrl={author.avatarUrl} size={40} />
              <div className="body">
                <div className="meta">
                  <span className="author" title={author.username ? `@${author.username}` : undefined}>
                    {author.name}
                  </span>
                  <span className="timestamp">{formatTimestamp(m.createdAt)}</span>
                </div>
                <MessageBody message={m} myId={myId} onOpen={setViewing} />
              </div>
            </div>
          );
        })}
        </div>
      </div>

      <div className="composer">
        <div className="composer-box">
          {suggestions.length > 0 && (
            <ul className="mention-suggestions" role="listbox" aria-label="Mention someone">
              <li className="mention-suggestions-title">Members matching @{mentionQuery?.query}</li>
              {suggestions.map((u, i) => (
                <li
                  key={u.id}
                  role="option"
                  aria-selected={i === mentionIndex}
                  className={i === mentionIndex ? "active" : ""}
                  onMouseEnter={() => setMentionIndex(i)}
                  // mousedown, so it happens before the textarea loses focus
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(u);
                  }}
                >
                  <Avatar userId={u.id} name={displayName(u)} avatarUrl={u.avatarUrl} size={24} />
                  <span className="mention-name">{displayName(u)}</span>
                  <span className="hint">@{u.username}</span>
                </li>
              ))}
            </ul>
          )}
          {uploads.items.length > 0 && (
            <div className="upload-tray">
              {uploads.items.map((item) => (
                <div key={item.key} className={`upload-item${item.error ? " failed" : ""}`} title={item.error ?? item.file.name}>
                  {item.file.type.startsWith("video/") ? (
                    <video src={item.preview} muted />
                  ) : item.file.type.startsWith("image/") ? (
                    <img src={item.preview} alt="" />
                  ) : (
                    <div className="upload-generic" />
                  )}
                  {!item.attachment && !item.error && (
                    <div className="upload-progress">
                      <div style={{ width: `${Math.round(item.progress * 100)}%` }} />
                    </div>
                  )}
                  {item.error && <div className="upload-error">{item.error}</div>}
                  <span className="upload-name">{item.file.name}</span>
                  <button className="upload-remove" onClick={() => uploads.remove(item.key)} title="Remove">
                    <Icon name="close" size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-row">
            <button className="icon-button attach-button" onClick={() => fileInput.current?.click()} title="Attach images or videos">
              <Icon name="add" />
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,video/*"
              multiple
              hidden
              onChange={(e) => {
                uploads.add([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                caret.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
                updateMentionQuery(e.target.value, e.target.selectionStart);
              }}
              onSelect={(e) => {
                rememberCaret();
                updateMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart);
              }}
              onBlur={() => setTimeout(() => setMentionQuery(null), 150)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={`Message #${channel.name}`}
              maxLength={2000}
              rows={1}
              autoFocus
            />
            <div className="expression-picker-wrap">
              {gifProvider && (
                <button
                  className={`gif-button${picker === "gif" ? " active" : ""}`}
                  onClick={() => togglePicker("gif")}
                  title="Send a GIF"
                >
                  GIF
                </button>
              )}
              <button
                className={`emoji-button${picker === "emoji" ? " active" : ""}`}
                onClick={() => togglePicker("emoji")}
                title="Add an emoji"
              >
                <Icon name="smile" size={22} />
              </button>
              {picker && (
                <ExpressionPicker
                  gifProvider={gifProvider}
                  tab={picker}
                  onTabChange={setPicker}
                  onPickGif={(url) => {
                    setPicker(null);
                    stickToBottom.current = true;
                    send(url, []);
                  }}
                  onPickEmoji={insertText}
                  onClose={() => setPicker(null)}
                />
              )}
            </div>
          </div>
          {sendQueued && <div className="composer-status">Sending when uploads finish…</div>}
        </div>
      </div>

      {dragging && (
        <div className="drop-overlay">
          <div>Drop images or videos to attach</div>
        </div>
      )}

      {viewing && (
        <div className="lightbox" onClick={() => setViewing(null)}>
          <img src={viewing.url} alt={viewing.filename} />
          <a href={viewing.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            Open original
          </a>
        </div>
      )}
    </main>
  );
}
