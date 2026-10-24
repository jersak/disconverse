function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const livekitUrl = required("LIVEKIT_URL");

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  /** Origin the web client is served from; WebSocket upgrades from other origins are rejected. */
  publicOrigin: process.env.PUBLIC_ORIGIN ?? "http://localhost:5173",
  secureCookies: process.env.NODE_ENV === "production",
  /** Built client to serve (production). In development Vite serves it instead. */
  clientDist: process.env.CLIENT_DIST,
  livekit: {
    /** URL handed to clients. */
    url: livekitUrl,
    /** URL the server uses for the LiveKit API; on the host this bypasses the public hostname. */
    apiUrl: process.env.LIVEKIT_API_URL ?? livekitUrl.replace(/^ws/, "http"),
    apiKey: required("LIVEKIT_API_KEY"),
    apiSecret: required("LIVEKIT_API_SECRET"),
  },
};
