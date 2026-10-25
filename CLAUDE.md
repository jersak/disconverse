# Disconverse

Self-hosted, simplified Discord-style app for a small group of friends: text and voice channels,
webcam and screen sharing, attachments, GIFs, emoji, mentions, and an owner admin panel.
See README.md for features and setup. Installation-specific notes (if any) are in CLAUDE.local.md.

## Architecture

```
 Browser (React + livekit-client)
   │  HTTPS / WSS (app, chat, auth, uploads)   │  WebRTC media (UDP 7882, TCP 7881 fallback)
   ▼                                           ▼
 Caddy (443) ──► backend (Node/TS) ──► SQLite, uploads folder
   └──────────► LiveKit signaling (7880)   ◄── backend signs LiveKit join tokens
```

- **LiveKit** (SFU) handles all voice/video/screen share; one LiveKit room per voice channel
  (`<VOICE_ROOM>-<channel id>`). Single UDP port mux (7882), TCP fallback (7881).
- **Backend** (`server/`): Node.js + TypeScript, Fastify, `node:sqlite`, one WebSocket per client for
  chat/presence/voice state. Invite-only signup, scrypt passwords, cookie sessions.
- **Client** (`client/`): React + Vite, served by the backend in production.
- **Caddy**: TLS and the only public HTTP entrypoint.

## Conventions

- Node 24 runs the server's `.ts` files directly (type stripping): erasable TypeScript only, imports
  use `.ts` extensions. `tsc` is for type checking only.
- Permissions are checked by permission name (`roles.ts`), never by role name; the server enforces
  everything, the UI only hides what the user can't do.
- Destructive admin actions require "sudo" (password re-entry, 10 minutes per session); the API
  returns 403 with code `sudo_required` and the client prompts.
- Anything that loads third-party content goes through the server (link previews, GIF media) so
  members' browsers don't contact third parties until they choose to play something.
- Dependency versions are pinned exactly, choosing releases at least two weeks old; avoid native
  dependencies (e.g. thumbnails are made in the browser, not with sharp).
- Configuration: secrets and server-specific values live only in gitignored `.env` files (see the
  `.env.example` files) and `.deploy.env`. Tracked files must not contain hostnames or addresses.

## Database

Schema changes: add a new entry to `MIGRATIONS` in `server/src/db.ts` (never edit shipped ones;
`PRAGMA user_version` tracks progress). Before deploying a migration, test it on a copy of the
production database (`VACUUM INTO` snapshot) and keep a snapshot as a backup.

## Development

- Local dev: `server/.env` (see `server/.env.example`) → backend on :3000; Vite on :5173 proxies
  `/api` (incl. WebSocket). Dev may use the production LiveKit but must set `VOICE_ROOM=voice-dev`:
  user ids from the dev database would collide with production identities and kick real users out.
- Admin CLI: `docker compose exec backend node src/cli.ts invite|invites|users|reset-password <name>|set-role <name> <role>`
  on the server (locally: `node --env-file=.env src/cli.ts ...` in `server/`).

## Deploy

Commit, then run `scripts/deploy.sh` (Git Bash). It copies `git archive HEAD` to `~/disconverse/src`
on the server (target from `.deploy.env`), writes the compose/Caddy configs in place, rebuilds the
backend (with `APP_VERSION` = commit) and reloads Caddy.

## Roadmap

1. [x] Infra: Caddy + LiveKit, voice/video verified across NAT.
2. [x] Backend: invite-code auth, WebSocket chat with history, LiveKit tokens.
3. [x] Web client: chat and voice (mute/deafen/speaking indicators).
4. [x] Video: webcam + screen share (quality presets, simulcast, H.264 for screen shares, system
   audio where the browser allows), stage grid with spotlight/fullscreen, opt-in "Watch Stream"
   (client connects with autoSubscribe off), stats overlay.
5. [ ] Electron (separate repo `disconverse-desktop`, Windows only): picker with system audio, tray and
   auto-update done; push-to-talk and echo-free system audio pending.
6. [x] Roles (owner/admin/member) and channels: create/rename/delete text and voice channels,
   per-channel history and unread markers, in-app invites, owner manages roles. First account = owner.
7. [ ] Later: message deletion/moderation, reordering channels, reactions, notifications,
   persistent mention counts, @everyone.
8. Admin panel (`/admin`, owner only via `manageServer`; API in `server/src/serverAdmin.ts`):
   - [x] Overview (drives via statfs, per-drive and per-type storage, counts, version), audit log
     (`admin_audit`, append-only), sudo.
   - [x] Media: thumbnails (made by the uploader's browser, `uploads/thumbs`, backfill in the owner's
     browser), filters, grid/list, infinite scroll, bulk delete and delete-all-matching (count-checked),
     removed attachments become placeholders (`removed_at`, `attachments-removed` event), storage per
     member/channel, retention policy (`settings` table, hourly job), orphaned avatar cleanup.
   - [ ] Logs: the app's own logs (rotating files + live view, download, clear). No docker socket.
   - [ ] Users: sessions, reset password, disable, delete (messages kept as "deleted user"), voice
     disconnect.
   - [ ] Maintenance: database backups (scheduled), VACUUM, runtime settings (upload limits, GIF
     filter) editable in the panel.

Also done: noise suppression (RNNoise/GTCRN + noise gate), device pickers, join/leave/mention sounds,
image/video attachments (type sniffed server-side, served only to logged-in users with sandboxing
headers, `MAX_IMAGE_MB`/`MAX_VIDEO_MB`), configurable upload storage with a mount marker, video link
embeds (YouTube/Vimeo/Streamable/Twitch; metadata proxied), GIFs (Giphy/Tenor/Imgur links proxied;
picker with verified API key), GIF playback controls, emoji picker (device-supported emoji only),
display names and profile pictures, @mentions with badges.
