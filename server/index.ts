import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostServer } from "./HostServer.js";
import { DEFAULT_PORT, TICK_RATE } from "../shared/constants.js";
import type { LevelDef } from "../shared/types.js";

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
const levelId = arg("level", "woods1");
const winsTarget = Number(arg("wins", "5")) || 5;
const botCount = Math.max(0, Number(arg("bots", "0")) || 0);
const levelFile = arg("level-file", "");
const tickHz = Math.max(10, Math.min(120, Math.floor(Number(arg("tick", String(TICK_RATE)))) || TICK_RATE));
const noStatic = hasFlag("no-static") || hasFlag("no-client") || arg("static", "") === "off";
const staticDirArg = arg("static-dir", "");

// Custom editor map: loose validation (object with spawns + weaponDrops).
// Full validation happens client-side via editor validateLevel.
let customLevel: LevelDef | null = null;
if (levelFile) {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(levelFile, "utf8"));
    const rec = parsed as Record<string, unknown>;
    const ok =
      typeof parsed === "object" && parsed !== null &&
      Array.isArray(rec.spawns) && rec.spawns.length > 0 &&
      Array.isArray(rec.weaponDrops) && rec.weaponDrops.length > 0;
    if (!ok) {
      console.error(`[host] --level-file ${levelFile}: missing spawns/weaponDrops — falling back to --level ${levelId}`);
    } else {
      customLevel = parsed as LevelDef;
    }
  } catch (err) {
    console.error(`[host] --level-file ${levelFile}: ${(err as Error).message} — falling back to --level ${levelId}`);
  }
}

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

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, port }));
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

const server = new HostServer(port, levelId, winsTarget, botCount, customLevel, tickHz);
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
  console.log("=== Stick Fight LAN host ===");
  if (customLevel) {
    console.log(`custom level: ${customLevel.name || levelFile}`);
  }
  console.log(`level: ${customLevel ? customLevel.id : levelId} · first to ${winsTarget} · bots: ${botCount}`);
  console.log("lobby: match starts automatically ~3s after 2+ players join");
  for (const { addr, internal } of lanIPs()) {
    console.log(`  http://${addr}:${port}${internal ? "  (this machine)" : "  <-- open this in a browser"}`);
    console.log(`  ws://${addr}:${port}${internal ? "  (this machine)" : "  <-- join address for friends"}`);
  }
  if (distExists) {
    console.log(`client: serving ${distDir} (open the http:// URL above, then HOST or JOIN)`);
  }
  console.log("flags: --no-static serves WS only · --static-dir <dir> overrides the client dir");
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
