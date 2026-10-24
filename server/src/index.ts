import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth.ts";
import { registerAdminRoutes } from "./admin.ts";
import { registerChannelRoutes } from "./channels.ts";
import { registerChatRoutes } from "./chat.ts";
import { config } from "./config.ts";
import { registerEmbedRoutes } from "./embeds.ts";
import { registerGifRoutes } from "./gifs.ts";
import { registerProfileRoutes } from "./profile.ts";
import { registerServerAdminRoutes } from "./serverAdmin.ts";
import { broadcast, hasClients } from "./hub.ts";
import { registerUploadRoutes, uploadsDir } from "./uploads.ts";
import { registerVoiceRoutes, startVoicePolling } from "./voice.ts";

const app = Fastify({
  logger: { level: config.logLevel },
  trustProxy: true, // behind Caddy: use X-Forwarded-For for rate limiting
  bodyLimit: 64 * 1024,
});

await app.register(cookie);
await app.register(rateLimit, { global: false });
await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
await app.register(multipart);
// Provides reply.sendFile for uploaded files (no routes of its own).
await app.register(fastifyStatic, { root: resolve(uploadsDir), serve: false });

registerAuthRoutes(app);
registerChatRoutes(app);
registerChannelRoutes(app);
registerAdminRoutes(app);
registerEmbedRoutes(app);
registerGifRoutes(app);
registerProfileRoutes(app);
registerServerAdminRoutes(app);
registerVoiceRoutes(app);
registerUploadRoutes(app);
startVoicePolling(app, (voice) => broadcast({ type: "voice", voice }), hasClients);

if (config.clientDist) {
  const clientRoot = resolve(config.clientDist);
  await app.register(fastifyStatic, { root: clientRoot, decorateReply: false });
  // Single-page app: unknown non-API paths get index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html", clientRoot);
    return reply.code(404).send({ error: "Not found" });
  });
}

await app.listen({ host: config.host, port: config.port });
