import { WebSocket } from "ws";
import { HostServer } from "./server/HostServer.ts";

const PORT = 18082;
const server = new HostServer(PORT, "woods1", 5, 0, null, 60);
server.start();

function connectClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const rec = { welcome: null, rosters: [], snapshots: 0, starts: 0 };
    const timer = setTimeout(() => reject(new Error(name + ": no welcome")), 5000);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.t === "welcome") { rec.welcome = msg; clearTimeout(timer); resolve({ ws, rec }); }
      else if (msg.t === "roster") rec.rosters.push(msg);
      else if (msg.t === "snapshot") rec.snapshots++;
      else if (msg.t === "start") rec.starts++;
    });
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, t: "hello", name, version: 1 })));
    ws.rec = rec;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const c1 = await connectClient("ALICE");
  await sleep(800);
  console.log("1) solo lobby: rosters=" + c1.ws.rec.rosters.length + " snapshots=" + c1.ws.rec.snapshots + " starts=" + c1.ws.rec.starts);
  console.log(c1.ws.rec.snapshots === 0 && c1.ws.rec.starts === 0 ? "PASS: solo joiner held in lobby, no game" : "FAIL: game leaked pre-start");
  console.log("   roster has color: " + (c1.ws.rec.rosters.at(-1)?.players?.every((p) => typeof p.color === "string") ? "PASS" : "FAIL"));

  const c2 = await connectClient("BOB");
  await sleep(1500); // within the ~3s auto-start window — must NOT have started yet
  console.log("2) two joined, waiting: c1 starts=" + c1.ws.rec.starts + " snaps=" + c1.ws.rec.snapshots + " | c2 starts=" + c2.ws.rec.starts + " snaps=" + c2.ws.rec.snapshots);
  console.log(c1.ws.rec.starts === 0 && c2.ws.rec.starts === 0 ? "PASS: holds briefly before auto-start" : "FAIL: started too early");
  await sleep(3000); // past the ~3s auto-start window — must have started now
  console.log("3) after wait: c1 starts=" + c1.ws.rec.starts + " snaps=" + c1.ws.rec.snapshots + " | c2 starts=" + c2.ws.rec.starts + " snaps=" + c2.ws.rec.snapshots);
  console.log(c1.ws.rec.starts >= 1 && c2.ws.rec.starts >= 1 && c1.ws.rec.snapshots > 0 ? "PASS: auto-starts once 2+ players joined" : "FAIL: auto-start broken");

  const c3 = await connectClient("CAROL");
  await sleep(800);
  console.log("4) late join: starts=" + c3.ws.rec.starts + " snaps=" + c3.ws.rec.snapshots);
  console.log(c3.ws.rec.starts >= 1 ? "PASS: late join caught up" : "FAIL: late join stuck");

  c1.ws.close(); c2.ws.close(); c3.ws.close();
  await sleep(300);
} catch (e) {
  console.error("ERROR:", e);
} finally {
  server.stop();
  process.exit(0);
}
