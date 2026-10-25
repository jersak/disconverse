// Fallback emoji font for devices whose own font lacks newer emoji (e.g. Windows 10, where Chrome,
// Edge and the desktop app show 🫥 or 🥲 as boxes). It's listed after the system emoji fonts in
// styles.css, so it only draws what those can't, and the browser downloads it (~6 MB, cached) only
// when such an emoji is on screen.
//
// The complete font is used on purpose: the package's per-range subsets render blank in Chromium.
import fontUrl from "@fontsource/noto-color-emoji/files/noto-color-emoji-emoji-400-normal.woff2?url";

const EMOJI_RANGES =
  "U+A9,U+AE,U+200D,U+203C,U+2049,U+20E3,U+2122,U+2139,U+2194-21AA,U+231A-23FF,U+24C2," +
  "U+25AA-27BF,U+2934-2935,U+2B05-2B55,U+3030,U+303D,U+3297,U+3299,U+FE0F,U+1F000-1FAFF,U+E0020-E007F";

export function registerEmojiFont() {
  const face = new FontFace("Disconverse Emoji", `url(${fontUrl}) format("woff2")`, {
    unicodeRange: EMOJI_RANGES,
    display: "swap",
  });
  document.fonts.add(face);
}
