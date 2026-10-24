import { useEffect } from "react";
import { EmojiTab } from "./EmojiTab.tsx";
import { GifTab, type GifProvider } from "./GifPicker.tsx";

export type PickerTab = "gif" | "emoji";

/** The popup behind the GIF and emoji buttons, with a tab for each. */
export function ExpressionPicker({
  gifProvider,
  tab,
  onTabChange,
  onPickGif,
  onPickEmoji,
  onClose,
}: {
  /** Without GIF search, the picker is just the emoji tab. */
  gifProvider: GifProvider | null;
  tab: PickerTab;
  onTabChange: (tab: PickerTab) => void;
  onPickGif: (url: string) => void;
  onPickEmoji: (emoji: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!(e.target as Element).closest(".expression-picker-wrap")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="gif-picker expression-picker" role="dialog" aria-label={tab === "gif" ? "GIF picker" : "Emoji picker"}>
      {gifProvider && (
        <div className="picker-tabs">
          <button className={tab === "gif" ? "active" : ""} onClick={() => onTabChange("gif")}>
            GIFs
          </button>
          <button className={tab === "emoji" ? "active" : ""} onClick={() => onTabChange("emoji")}>
            Emoji
          </button>
        </div>
      )}
      {tab === "gif" && gifProvider ? (
        <GifTab provider={gifProvider} onPick={onPickGif} />
      ) : (
        <EmojiTab onPick={onPickEmoji} />
      )}
    </div>
  );
}
