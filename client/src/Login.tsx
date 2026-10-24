import { useState, type FormEvent } from "react";
import { api, type User } from "./api.ts";

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [inviteCode, setInviteCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } =
        mode === "login" ? await api.login(username, password) : await api.signup(inviteCode, username, password);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode(mode === "login" ? "signup" : "login");
    setError(null);
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>{mode === "login" ? "Welcome back!" : "Create an account"}</h1>
        <p className="login-sub">{mode === "login" ? "Log in to Disconverse" : "You'll need an invite code"}</p>

        {mode === "signup" && (
          <label>
            Invite code
            <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required autoFocus />
          </label>
        )}
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            autoFocus={mode === "login"}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "signup" ? 8 : undefined}
            required
          />
        </label>

        {error && <div className="form-error">{error}</div>}

        <button type="submit" className="primary" disabled={busy}>
          {mode === "login" ? "Log In" : "Sign Up"}
        </button>
        <button type="button" className="link" onClick={switchMode}>
          {mode === "login" ? "Have an invite? Create an account" : "Already have an account? Log in"}
        </button>
      </form>
    </div>
  );
}
