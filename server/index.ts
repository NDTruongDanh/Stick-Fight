import fs from "node:fs";
import os from "node:os";
import { HostServer } from "./HostServer.js";
import { DEFAULT_PORT } from "../shared/constants.js";
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

const port = Number(arg("port", String(DEFAULT_PORT))) || DEFAULT_PORT;
const levelId = arg("level", "woods1");
const winsTarget = Number(arg("wins", "5")) || 5;
const botCount = Math.max(0, Number(arg("bots", "0")) || 0);
const levelFile = arg("level-file", "");

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

const server = new HostServer(port, levelId, winsTarget, botCount, customLevel);
server.start();

console.log("=== Stick Fight LAN host ===");
if (customLevel) {
  console.log(`custom level: ${customLevel.name || levelFile}`);
}
console.log(`level: ${customLevel ? customLevel.id : levelId} · first to ${winsTarget} · bots: ${botCount}`);
console.log("lobby: players type /ready (auto-starts when all 2+ ready, else 3s timer)");
console.log("host (first player) chat commands: /start · /restart · /kick <name> · /bots <0-4>");
for (const { addr, internal } of lanIPs()) {
  console.log(`  ws://${addr}:${port}${internal ? "  (this machine)" : "  <-- give this to friends"}`);
}
console.log("Press Ctrl+C to stop.");

const shutdown = (): void => {
  console.log("\nstopping…");
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
