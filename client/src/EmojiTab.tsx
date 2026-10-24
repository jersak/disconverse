import { useEffect, useMemo, useRef, useState } from "react";
import { loadEmoji, recentEmoji, rememberEmoji, searchEmoji, type Emoji, type EmojiGroup } from "./emoji.ts";

// Category bar icons, by group slug.
const GROUP_ICONS: Record<string, string> = {
  recent: "\u{1F552}",
  smileys_emotion: "\u{1F600}",
  people_body: "\u{1F44B}",
  animals_nature: "\u{1F43B}",
  food_drink: "\u{1F354}",
  travel_places: "\u{2708}\u{FE0F}",
  activities: "\u{26BD}",
  objects: "\u{1F4A1}",
  symbols: "\u{2764}\u{FE0F}",
  flags: "\u{1F3F3}\u{FE0F}",
};

/** Emoji search and categories. Picking inserts into the message; the picker stays open. */
export function EmojiTab({ onPick }: { onPick: (emoji: string) => void }) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState(recentEmoji);
  const [hovered, setHovered] = useState<Emoji | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadEmoji().then(setGroups);
  }, []);

  const byEmoji = useMemo(() => new Map(groups?.flatMap((g) => g.emojis.map((e) => [e.emoji, e] as const))), [groups]);

  const sections = useMemo((): EmojiGroup[] => {
    if (!groups) return [];
    if (query.trim()) return [{ slug: "results", name: "Search results", emojis: searchEmoji(groups, query) }];
    const recentList = recent.flatMap((e) => byEmoji.get(e) ?? []);
    return recentList.length ? [{ slug: "recent", name: "Recently used", emojis: recentList }, ...groups] : groups;
  }, [groups, query, recent, byEmoji]);

  const pick = (e: Emoji) => {
    onPick(e.emoji);
    rememberEmoji(e.emoji);
    setRecent(recentEmoji());
  };

  const jumpTo = (slug: string) => {
    const header = listRef.current?.querySelector<HTMLElement>(`[data-group="${slug}"]`);
    if (header && listRef.current) listRef.current.scrollTop = header.offsetTop - listRef.current.offsetTop;
  };

  return (
    <div className="emoji-tab">
      <input
        className="gif-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search emoji"
        autoFocus
      />
      {!query && groups && (
        <div className="emoji-categories">
          {sections.map((s) => (
            <button key={s.slug} title={s.name} onClick={() => jumpTo(s.slug)}>
              {GROUP_ICONS[s.slug] ?? s.emojis[0]?.emoji}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-list" ref={listRef}>
        {!groups && <p className="gif-picker-message">Loading…</p>}
        {groups && sections[0]?.emojis.length === 0 && <p className="gif-picker-message">No emoji found.</p>}
        {sections.map((s) =>
          s.emojis.length === 0 ? null : (
            <section key={s.slug}>
              <h4 data-group={s.slug}>{s.name}</h4>
              <div className="emoji-grid">
                {s.emojis.map((e) => (
                  <button
                    key={e.emoji}
                    title={e.name}
                    onClick={() => pick(e)}
                    onMouseEnter={() => setHovered(e)}
                    onFocus={() => setHovered(e)}
                  >
                    {e.emoji}
                  </button>
                ))}
              </div>
            </section>
          ),
        )}
      </div>
      <div className="emoji-preview">
        {hovered ? (
          <>
            <span className="emoji-preview-glyph">{hovered.emoji}</span>
            <span>{hovered.name}</span>
          </>
        ) : (
          <span className="hint">Click an emoji to add it to your message</span>
        )}
      </div>
    </div>
  );
}
