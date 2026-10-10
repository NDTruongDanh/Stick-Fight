import { WebSocket } from "ws";
import { HostServer } from "./server/HostServer.ts";

const PORT = 18082;
const server = new HostServer(PORT, "woods1", 5, 0, null, 60);
server.start();

function connectClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const rec = { welcome: null, rosters: [], snapshots: 0, starts: 0, chats: [] };
    const timer = setTimeout(() => reject(new Error(name + ": no welcome")), 5000);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.t === "welcome") { rec.welcome = msg; clearTimeout(timer); resolve({ ws, rec }); }
      else if (msg.t === "roster") rec.rosters.push(msg);
      else if (msg.t === "snapshot") rec.snapshots++;
      else if (msg.t === "start") rec.starts++;
      else if (msg.t === "chat") rec.chats.push(msg);
    });
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, t: "hello", name, version: 1 })));
    ws.rec = rec;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chat = (ws, text) => ws.send(JSON.stringify({ v: 1, t: "chat", text }));

try {
  const c1 = await connectClient("ALICE");
  await sleep(800);
  console.log("1) solo lobby: rosters=" + c1.ws.rec.rosters.length + " snapshots=" + c1.ws.rec.snapshots + " starts=" + c1.ws.rec.starts);
  console.log(c1.ws.rec.snapshots === 0 && c1.ws.rec.starts === 0 ? "PASS: solo joiner held in lobby, no game" : "FAIL: game leaked pre-start");
  console.log("   roster has color: " + (c1.ws.rec.rosters.at(-1)?.players?.every((p) => typeof p.color === "string") ? "PASS" : "FAIL"));

  const c2 = await connectClient("BOB");
  await sleep(3500); // old 3s auto-start window — must NOT start without ready now
  console.log("2) two joined, nobody ready: c1 starts=" + c1.ws.rec.starts + " snaps=" + c1.ws.rec.snapshots + " | c2 starts=" + c2.ws.rec.starts + " snaps=" + c2.ws.rec.snapshots);
  console.log(c1.ws.rec.starts === 0 && c2.ws.rec.starts === 0 && c1.ws.rec.snapshots === 0 ? "PASS: no auto-start without ready" : "FAIL: match started without everyone ready");

  chat(c1.ws, "/ready");
  await sleep(600);
  console.log("3) one ready: starts=" + c1.ws.rec.starts + " snaps=" + c1.ws.rec.snapshots);
  console.log(c1.ws.rec.starts === 0 ? "PASS: waits for everyone" : "FAIL: started with only one ready");
  chat(c2.ws, "/ready");
  await sleep(1200);
  console.log("4) both ready: c1 starts=" + c1.ws.rec.starts + " snaps=" + c1.ws.rec.snapshots + " | c2 starts=" + c2.ws.rec.starts + " snaps=" + c2.ws.rec.snapshots);
  console.log(c1.ws.rec.starts >= 1 && c2.ws.rec.starts >= 1 && c1.ws.rec.snapshots > 0 ? "PASS: starts when everyone ready" : "FAIL: ready-gated start broken");

  const c3 = await connectClient("CAROL");
  await sleep(800);
  console.log("5) late join: starts=" + c3.ws.rec.starts + " snaps=" + c3.ws.rec.snapshots);
  console.log(c3.ws.rec.starts >= 1 ? "PASS: late join caught up" : "FAIL: late join stuck");

  c1.ws.close(); c2.ws.close(); c3.ws.close();
  await sleep(300);
} catch (e) {
  console.error("ERROR:", e);
} finally {
  server.stop();
  process.exit(0);
}
