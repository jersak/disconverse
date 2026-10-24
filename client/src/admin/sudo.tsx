// Destructive admin actions need the owner's password re-entered (valid ~10 minutes, per session).
// `withSudo(action)` runs the action, asks for the password if the server requires it, then retries.
import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ApiError } from "../api.ts";
import { adminApi } from "./adminApi.ts";

type WithSudo = <T>(action: () => Promise<T>) => Promise<T>;

const SudoContext = createContext<WithSudo>((action) => action());

export const useSudo = () => useContext(SudoContext);

export function SudoProvider({ children }: { children: ReactNode }) {
  const [asking, setAsking] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (err: Error) => void } | null>(null);

  const askPassword = () =>
    new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject };
      setAsking(true);
    });

  const withSudo: WithSudo = useCallback(async (action) => {
    try {
      return await action();
    } catch (err) {
      // Checked by code rather than `instanceof`, which breaks if the module is ever loaded twice.
      if ((err as Partial<ApiError> | null)?.code !== "sudo_required") throw err;
      await askPassword();
      return action();
    }
  }, []);

  const finish = (error?: Error) => {
    setAsking(false);
    if (error) pending.current?.reject(error);
    else pending.current?.resolve();
    pending.current = null;
  };

  return (
    <SudoContext.Provider value={withSudo}>
      {children}
      {asking && <PasswordDialog onConfirmed={() => finish()} onCancel={() => finish(new Error("Cancelled"))} />}
    </SudoContext.Provider>
  );
}

function PasswordDialog({ onConfirmed, onCancel }: { onConfirmed: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.sudo(password);
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't confirm");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Confirm it's you</h2>
        </header>
        <p className="hint">This action can't be undone. Enter your password to continue; you won't be asked again for 10 minutes.</p>
        <label className="field">
          <span>Password</span>
          <div className="field-input">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
          </div>
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !password}>
            Confirm
          </button>
        </div>
      </form>
    </div>
  );
}
