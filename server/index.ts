import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostServer } from "./HostServer.js";
import { DEFAULT_PORT, PROTOCOL_VERSION, TICK_RATE } from "../shared/constants.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  const pref = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (pref) return pref.slice(name.length + 3);
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function lanIPs(): { addr: string; internal: boolean }[] {
  const out: { addr: string; internal: boolean }[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === "IPv4" && !n.address.startsWith("169.254.")) {
        out.push({ addr: n.address, internal: n.internal });
      }
    }
  }
  return out;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/** Serve a file with sane caching: immutable hashed assets, no-cache HTML. */
function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
): void {
  const ext = path.extname(file).toLowerCase();
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  if (file.endsWith("index.html")) {
    res.setHeader("Cache-Control", "no-cache");
  } else if (file.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "public, max-age=3600");
  }
  if (req.method === "HEAD") {
    try {
      res.setHeader("Content-Length", fs.statSync(file).size);
    } catch {
      /* size unknown — omit */
    }
    res.end();
    return;
  }
  fs.createReadStream(file).on("error", () => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("failed to read file");
  }).pipe(res);
}

const port = Number(arg("port", String(DEFAULT_PORT))) || DEFAULT_PORT;
// Room defaults: used when a created room omits the field. Per-room values
// come from the creating client's createRoom message.
const defaultLevel = arg("level", "woods1");
const defaultWins = Number(arg("wins", "5")) || 5;
const defaultBots = Math.max(0, Number(arg("bots", "0")) || 0);
const tickHz = Math.max(10, Math.min(120, Math.floor(Number(arg("tick", String(TICK_RATE)))) || TICK_RATE));
const noStatic = hasFlag("no-static") || hasFlag("no-client") || arg("static", "") === "off";
const staticDirArg = arg("static-dir", "");

// Static client dir: --static-dir <dir>, else <repo>/dist (sibling of server/).
const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = staticDirArg
  ? path.resolve(process.cwd(), staticDirArg)
  : path.resolve(here, "..", "dist");
const distExists = !noStatic && fs.existsSync(distDir) && fs.existsSync(path.join(distDir, "index.html"));
if (!noStatic && !distExists) {
  console.warn(
    `[host] no client bundle at ${distDir} — serving API/WS only. Run \`npm run build\` first to also host the web UI.`,
  );
}

const server = new HostServer(port, defaultLevel, defaultWins, defaultBots, tickHz);

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    // Discovery probe: CORS-open so LAN clients can identify this server
    // via fetch() (no sensitive data — game id, wire proto, room count).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    let rooms = 0;
    try {
      rooms = server.roomCount;
    } catch {
      rooms = 0;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, port, game: "stickfight", proto: PROTOCOL_VERSION, rooms }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("method not allowed");
    return;
  }
  if (!distExists) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("client not built — run `npm run build` on the host, then reload");
    return;
  }
  // Strip query, decode, resolve inside distDir (block traversal).
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad request");
    return;
  }
  if (rel === "/") rel = "/index.html";
  const resolved = path.normalize(path.join(distDir, rel));
  if (!resolved.startsWith(path.normalize(distDir + path.sep)) && resolved !== path.normalize(distDir)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      sendFile(req, res, path.join(distDir, "index.html"));
      return;
    }
    if (stat.isFile()) {
      sendFile(req, res, resolved);
      return;
    }
  } catch {
    /* fall through to SPA fallback */
  }
  // SPA fallback: unknown paths (no extension) boot the client router.
  const fallback = path.join(distDir, "index.html");
  if (fs.existsSync(fallback)) {
    sendFile(req, res, fallback);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// Attach WS to the same HTTP server: one port serves the web UI + game WS.
server.start(httpServer);

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[host] port ${port} in use — stop the other host or pick a free port: npm run host -- --port 8081`);
    process.exit(1);
  }
  console.error("[host] http error:", err);
});

httpServer.listen(port, () => {
  console.log("=== Stick Fight LAN room server ===");
  console.log(`room defaults: level ${defaultLevel} · first to ${defaultWins} · bots: ${defaultBots}`);
  console.log("flow: any player creates a room (HOST) -> shares the 4-letter code -> friends JOIN with the code");
  console.log("lobby: match starts automatically ~3s after 2+ players join a room");
  console.log("rooms: host DELETE kicks everyone · host quit auto-deletes the room");
  for (const { addr, internal } of lanIPs()) {
    console.log(`  http://${addr}:${port}${internal ? "  (this machine)" : "  <-- open this in a browser"}`);
    console.log(`  ws://${addr}:${port}${internal ? "  (this machine)" : "  <-- server address for friends"}`);
  }
  if (distExists) {
    console.log(`client: serving ${distDir} (open the http:// URL above, then HOST or JOIN with a room code)`);
  }
  console.log("flags: --no-static serves WS only · --static-dir <dir> overrides the client dir");
  console.log("       --level/--wins/--bots set room defaults (per-room values come from the host client)");
  console.log("Press Ctrl+C to stop.");
});

const shutdown = (): void => {
  console.log("\nstopping…");
  server.stop();
  httpServer.close(() => process.exit(0));
  // Force-exit if keep-alives hold the server open.
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
