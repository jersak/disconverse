import { useEffect, useState, type FormEvent } from "react";
import { api, type Channel, type ChannelType } from "./api.ts";
import { Icon } from "./ui.tsx";

/** Create a channel (`channel` omitted) or rename/delete an existing one. */
export function ChannelDialog({
  type,
  channel,
  onClose,
}: {
  type: ChannelType;
  channel?: Channel;
  onClose: () => void;
}) {
  const [name, setName] = useState(channel?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => (channel ? api.renameChannel(channel.id, name) : api.createChannel(type, name)));
  };

  // Text channel names are shown as they'll be saved (lowercase, dashes).
  const preview = type === "text" ? name.trim().toLowerCase().replace(/\s+/g, "-") : name;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{channel ? "Edit Channel" : `Create ${type === "text" ? "Text" : "Voice"} Channel`}</h2>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </header>

        <label className="field">
          <span>Channel name</span>
          <div className="field-input">
            {type === "text" ? <span className="hash">#</span> : <Icon name="speaker" />}
            <input
              value={type === "text" ? preview : name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === "text" ? "new-channel" : "New Channel"}
              maxLength={32}
              autoFocus
              required
            />
          </div>
        </label>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          {channel &&
            (confirmingDelete ? (
              <div className="confirm-delete">
                <span>
                  {type === "text"
                    ? "Delete this channel and all its messages and files?"
                    : "Delete this channel? Anyone in it will be disconnected."}
                </span>
                <button type="button" className="danger" disabled={busy} onClick={() => run(() => api.deleteChannel(channel.id))}>
                  Delete
                </button>
                <button type="button" className="secondary" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="danger-link" onClick={() => setConfirmingDelete(true)}>
                Delete channel
              </button>
            ))}
          {!confirmingDelete && (
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              {channel ? "Save" : "Create Channel"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
