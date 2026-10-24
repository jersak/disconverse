# Disconverse

A small, self-hosted Discord-style app for a group of friends: text and voice channels, webcam and
screen sharing. Built to run on a single home server.

## Features

- **Text channels** with history, unread markers, presence, links, and image/video attachments
  (paste, drag and drop, or pick)
- **@mentions** with autocomplete, highlighted messages, per-channel mention badges and a ping sound
- **Emoji picker** with search, showing only emoji the device can display
- **Inline video players** for YouTube, Vimeo, Streamable and Twitch links and direct video files
- **GIFs**: Giphy, Tenor and Imgur links play inline, and a GIF picker searches Giphy or Tenor (needs an
  API key in `GIPHY_API_KEY` or `TENOR_API_KEY`)
- **Voice channels** with mute/deafen, speaking indicators, join/leave sounds and per-device
  input/output selection
- **Noise suppression** running locally in the browser (RNNoise or GTCRN via WebAssembly), plus an
  optional noise gate ("input sensitivity")
- **Webcam and screen sharing** up to 1440p60, with system/tab audio where the browser supports it;
  viewers opt in with "Watch Stream", and a stats overlay helps diagnose choppy streams
- **Profiles**: display names (nicknames) and profile pictures, cropped and resized in the browser
- **Admin panel** for the owner at `/admin`: disk and storage overview, media browser with bulk delete,
  automatic cleanup of old media, storage per member/channel, and an audit log. Destructive actions
  require re-entering the password
- **Invite-only accounts** and three roles: the **owner** (first account) manages roles; **admins**
  create, rename and delete channels and create invites; **members** chat and talk
- Works on desktop and mobile browsers

## How it works

```
 Browser (React + livekit-client)
   │  HTTPS / WSS (app, chat, auth, uploads)   │  WebRTC media (UDP 7882, TCP 7881 fallback)
   ▼                                           ▼
 Caddy (443) ──► backend (Node + Fastify) ──► SQLite, uploads folder
   └──────────► LiveKit signaling (7880)   ◄── backend issues LiveKit join tokens
```

- [LiveKit](https://github.com/livekit/livekit) (open-source media server) handles all voice, video and
  screen sharing. Media is relayed through the server; members never connect to each other directly.
- The backend (`server/`) is Node.js with TypeScript, run directly by Node 24 (no build step). It
  stores accounts, sessions and messages in SQLite and uploaded files on disk.
- The client (`client/`) is a React app built with Vite and served by the backend.
- Caddy terminates TLS (automatic Let's Encrypt certificates) and is the only public HTTP entrypoint.

## Self-hosting

You need a Linux server with Docker, a domain with two hostnames pointing at it (one for the app, one
for LiveKit), and these ports forwarded to the server:

| Port | Protocol | Used by |
|---|---|---|
| 80, 443 | TCP | Caddy (certificates, app, LiveKit signaling) |
| 7881 | TCP | LiveKit media fallback |
| 7882 | UDP | LiveKit media |

1. **Configure.** Copy each `.env.example` to `.env` and fill it in. Nothing in the tracked files needs
   editing:
   - `deploy/disconverse/.env`: your two hostnames (`APP_DOMAIN`, `RTC_DOMAIN`), LiveKit keys
     (`openssl rand -hex 8` and `openssl rand -base64 32`), the uploads folder, and optional limits and
     GIF search keys.
   - `deploy/proxy/.env`: the same two hostnames, for Caddy.
   - `.deploy.env` (only if you use `scripts/deploy.sh`): the server's SSH target.
   - In `deploy/disconverse/livekit.yaml`, set your LAN subnet under `ips.includes`.
2. **Storage.** Create the uploads folder set in `UPLOADS_PATH` and an empty `.disconverse-storage` file
   inside it. The backend refuses to start without that file, so an unmounted drive gets noticed instead
   of uploads silently going to the wrong disk.
3. **Deploy.** Copy `deploy/proxy/` and `deploy/disconverse/` to the server, put the repository source in
   `deploy/disconverse/src/`, then run `docker compose up -d` in the proxy folder first, then in the
   disconverse folder. `scripts/deploy.sh` automates this over SSH (target from `.deploy.env`; it
   expects the stacks in `~/proxy` and `~/disconverse` on the server).
4. **Invite people.** The first account needs an invite created on the server:
   ```bash
   docker compose exec backend node src/cli.ts invite
   ```
   That first account becomes the **owner**. After that, the owner and admins create invites in the app
   (⚙ next to the server name). Other server commands: `invites`, `users`,
   `reset-password <username>`, `set-role <username> <owner|admin|member>` (also the way to transfer
   ownership).

**Behind a home router without NAT loopback?** Devices on your own network won't be able to reach the
public hostnames. Point them at the server's LAN IP with a local DNS override (Pi-hole, AdGuard Home, or
your router's DNS). `deploy/disconverse/livekit.yaml` also has settings for this case
(`skip_external_ip_validation`, `advertise_internal_ip`, and the LAN subnet in `ips.includes`); adjust
the subnet to yours.

### Settings (backend environment)

| Variable | Default | |
|---|---|---|
| `APP_DOMAIN`, `RTC_DOMAIN` | (required, compose) | Hostnames of the app and of LiveKit; the compose file derives `PUBLIC_ORIGIN` and `LIVEKIT_URL` from them |
| `LIVEKIT_URL` | (required) | LiveKit URL given to clients, e.g. `wss://rtc.example.com` |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | (required) | Must match LiveKit's keys |
| `LIVEKIT_API_URL` | from `LIVEKIT_URL` | URL the backend uses for the LiveKit API |
| `PUBLIC_ORIGIN` | `http://localhost:5173` | Origin the app is served from (WebSocket origin check) |
| `DATA_DIR` | `./data` | Database location |
| `UPLOADS_DIR` | `DATA_DIR/uploads` | Uploaded files (can be a different drive) |
| `REQUIRE_UPLOADS_MARKER` | off | `true` = require `.disconverse-storage` in `UPLOADS_DIR` |
| `MAX_IMAGE_MB`, `MAX_VIDEO_MB` | 30, 300 | Per-file upload limits |
| `VOICE_ROOM` | `voice` | LiveKit room name (use a different one for development) |
| `GIPHY_API_KEY` / `TENOR_API_KEY` | (none) | Enables GIF search in the picker (Giphy wins if both are set) |
| `GIF_CONTENT_FILTER` | `medium` | GIF search filter: `off`, `low`, `medium`, `high` |

## Development

Requires Node.js 24.

```bash
npm install
cp server/.env.example server/.env   # fill in LiveKit URL and keys
npm run dev:server                     # backend on :3000
npm run dev:client                     # Vite on :5173, proxies /api to the backend
```

Development can use the production LiveKit server; keep `VOICE_ROOM=voice-dev` so development users
(whose ids come from a separate database) never collide with real ones in the production voice room.
Create a local invite with `npm run invite`.

## Privacy notes

This is built for a trusted group on a server you control, not as a public service. Before inviting
people, be aware of the following:

- **Uploaded photos and videos are stored and served unchanged, including their metadata.** Pictures
  and videos taken with a phone often contain the **GPS location** where they were taken (EXIF and
  similar metadata). Anyone in the server can download an attachment and read it. Screenshots and pasted
  images usually don't contain location data, but files shared straight from a phone's gallery often do.
  If that's a concern for your group, strip metadata before uploading, or patch the upload handler
  (`server/src/uploads.ts`) to remove it (e.g. with `exiftool` for images and `ffmpeg -map_metadata -1`
  for videos).
- **Members can't see each other's IP addresses.** Voice and video are relayed through the server, and
  the app never sends IPs to clients. The server's logs (Caddy, LiveKit, the backend) do record client IP
  addresses, so whoever runs the server can see them.
- **Messages and files are not end-to-end encrypted.** They are encrypted in transit (HTTPS/WebRTC) but
  stored in plain form on the server, readable by whoever administers it.
- **Uploads are only served to logged-in users**, but anyone with an account can view all of them.
- **Video link previews are fetched by the server**, so posting a YouTube/Vimeo/Streamable link doesn't
  make members' browsers contact those sites. Pressing play loads the provider's player (YouTube via its
  privacy-enhanced `youtube-nocookie.com` domain), and from then on that provider sees the viewer's IP
  like any embedded video. Direct video file links aren't fetched until play is pressed.
- **GIFs are loaded through the server** (Giphy, Tenor and Imgur media only), so members' browsers don't
  contact those sites. GIF searches are made by the server too.
- LiveKit contacts public STUN servers (Google, Twilio) at startup to discover the server's public IP.

## License

Disconverse is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. See [LICENSE](LICENSE).

Third-party components keep their own licenses (all permissive and GPLv3-compatible), including
LiveKit (Apache-2.0), RNNoise (BSD-3-Clause), GTCRN (MIT) and web-noise-suppressor (MIT).
