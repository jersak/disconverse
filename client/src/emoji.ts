// Emoji data for the picker: loaded on first use, filtered to what this device can display.

export type Emoji = {
  emoji: string;
  name: string;
  /** Lower-case words to search: the name plus keywords (e.g. 👋 → wave, hello, hi). */
  terms: string[];
};
export type EmojiGroup = { slug: string; name: string; emojis: Emoji[] };

type RawGroup = { name: string; slug: string; emojis: { emoji: string; name: string }[] };

const FLAG = /[\u{1F1E6}-\u{1F1FF}]/u;

/** True if the system font can draw `emoji` as one glyph (not a placeholder box, letters or pieces). */
function createRenderCheck() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = "24px sans-serif";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000";
  const reference = ctx.measureText("\u{1F600}").width; // 😀, supported everywhere

  const draw = (text: string) => {
    ctx.clearRect(0, 0, 32, 32);
    ctx.fillText(text, 0, 0);
    return ctx.getImageData(0, 0, 32, 32).data;
  };
  const hasColour = (data: Uint8ClampedArray) => {
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
      if (a > 50 && (Math.abs(r - g) > 30 || Math.abs(g - b) > 30 || Math.abs(r - b) > 30)) return true;
    }
    return false;
  };
  // What a missing glyph looks like: an unassigned code point gets the font's placeholder box.
  const missing = draw("\u{10FFFD}");
  const missingWidth = ctx.measureText("\u{10FFFD}").width;
  const sameAsMissing = (data: Uint8ClampedArray) => data.every((v, i) => v === missing[i]);

  return (emoji: string) => {
    const width = ctx.measureText(emoji).width;
    // Unsupported sequences fall apart into several glyphs.
    if (width > reference * 1.4) return false;
    const flag = FLAG.test(emoji);
    // Reading pixels is the slow part: only needed when the width matches the placeholder's.
    if (!flag && width !== missingWidth) return true;
    const data = draw(emoji);
    if (width === missingWidth && sameAsMissing(data)) return false;
    // Flags without font support show as two letters; real flags are always colourful.
    if (flag) return hasColour(data);
    return true;
  };
}

const UNSUPPORTED_KEY = "disconverse.unsupportedEmoji";

/**
 * Emoji this device can't draw. Checking takes ~0.5 s (font lookups), so the result is remembered
 * per browser version and emoji data; a browser update re-checks, since it may add emoji.
 */
async function findUnsupported(all: string[]): Promise<Set<string>> {
  const cacheKey = `${navigator.userAgent}|${all.length}|${all[all.length - 1]}`;
  try {
    const cached = JSON.parse(localStorage.getItem(UNSUPPORTED_KEY) ?? "null");
    if (cached?.key === cacheKey && Array.isArray(cached.emoji)) return new Set(cached.emoji);
  } catch {
    // re-check below
  }

  const renders = createRenderCheck();
  const unsupported: string[] = [];
  // In small batches, so the page stays responsive while the picker shows "Loading…".
  for (let i = 0; i < all.length; i += 150) {
    for (const emoji of all.slice(i, i + 150)) if (!renders(emoji)) unsupported.push(emoji);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  try {
    localStorage.setItem(UNSUPPORTED_KEY, JSON.stringify({ key: cacheKey, emoji: unsupported }));
  } catch {
    // not essential
  }
  return new Set(unsupported);
}

let loading: Promise<EmojiGroup[]> | undefined;

/** Emoji grouped by category, without those this device would show as boxes. */
export function loadEmoji(): Promise<EmojiGroup[]> {
  loading ??= Promise.all([
    import("unicode-emoji-json/data-by-group.json"),
    import("emojilib/dist/emoji-en-US.json"),
  ]).then(async ([{ default: data }, { default: keywordData }]) => {
    const groups = data as RawGroup[];
    const keywords = keywordData as Record<string, string[]>;
    const termsFor = (emoji: string, name: string) => [
      ...new Set([name, ...(keywords[emoji] ?? [])].flatMap((k) => k.toLowerCase().split(/[\s_]+/)).filter(Boolean)),
    ];
    // Fonts lag behind new emoji releases (and some never draw flags): check each one.
    const unsupported = await findUnsupported(groups.flatMap((g) => g.emojis.map((e) => e.emoji)));
    return groups
      .map((g) => ({
        slug: g.slug,
        name: g.name,
        emojis: g.emojis
          .filter((e) => !unsupported.has(e.emoji))
          .map(({ emoji, name }) => ({ emoji, name, terms: termsFor(emoji, name) })),
      }))
      .filter((g) => g.emojis.length > 0);
  });
  return loading;
}

/**
 * Emoji matching every word of the query, best first: exact keyword matches, then prefixes
 * ("wav" → wave), then words merely contained in a term.
 */
export function searchEmoji(groups: EmojiGroup[], query: string): Emoji[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { emoji: Emoji; score: number; order: number }[] = [];
  let order = 0;
  for (const group of groups) {
    for (const emoji of group.emojis) {
      let score = 0;
      for (const word of words) {
        let best = 0;
        for (const term of emoji.terms) {
          if (term === word) best = 3;
          else if (best < 2 && term.startsWith(word)) best = 2;
          else if (best < 1 && term.includes(word)) best = 1;
          if (best === 3) break;
        }
        if (!best) {
          score = 0;
          break;
        }
        score += best;
      }
      // The emoji literally named what was searched (🔥 "fire") beats ones that merely mention it.
      if (score && emoji.name === words.join(" ")) score += 10;
      if (score) scored.push({ emoji, score, order: order++ });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.emoji);
}

// ---- Recently used ------------------------------------------------------------

const RECENT_KEY = "disconverse.recentEmoji";
const RECENT_MAX = 24;

export function recentEmoji(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string) {
  const next = [emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // not essential
  }
}
