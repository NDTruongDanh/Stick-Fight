import os from "node:os";
import { HostServer } from "./HostServer.js";
import { DEFAULT_PORT } from "../shared/constants.js";

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

const server = new HostServer(port, levelId);
server.start();

console.log("=== Stick Fight LAN host ===");
console.log(`level: ${levelId}`);
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
