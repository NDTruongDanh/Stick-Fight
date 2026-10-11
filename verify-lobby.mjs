import { WebSocket } from "ws";
import { HostServer } from "./server/HostServer.ts";

const PORT = 18082;
const server = new HostServer(PORT, "woods1", 5, 0, 60);
server.start();

function rawConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function createRoom(name, opts = {}) {
  return new Promise(async (resolve, reject) => {
    const ws = await rawConnect();
    const rec = { welcome: null, rosters: [], snapshots: 0, starts: 0, closed: null, rejects: [] };
    const timer = setTimeout(() => reject(new Error(name + ": no welcome")), 5000);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.t === "welcome") { rec.welcome = msg; clearTimeout(timer); resolve({ ws, rec }); }
      else if (msg.t === "roster") rec.rosters.push(msg);
      else if (msg.t === "snapshot") rec.snapshots++;
      else if (msg.t === "start") rec.starts++;
      else if (msg.t === "roomClosed") rec.closed = msg;
      else if (msg.t === "reject") rec.rejects.push(msg);
    });
    ws.rec = rec;
    ws.send(JSON.stringify({ v: 2, t: "createRoom", name, version: 2, ...opts }));
  });
}

function joinRoom(name, code) {
  return new Promise(async (resolve, reject) => {
    const ws = await rawConnect();
    const rec = { welcome: null, rosters: [], snapshots: 0, starts: 0, closed: null, rejects: [] };
    const timer = setTimeout(() => reject(new Error(name + ": no welcome")), 5000);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.t === "welcome") { rec.welcome = msg; clearTimeout(timer); resolve({ ws, rec }); }
      else if (msg.t === "roster") rec.rosters.push(msg);
      else if (msg.t === "snapshot") rec.snapshots++;
      else if (msg.t === "start") rec.starts++;
      else if (msg.t === "roomClosed") rec.closed = msg;
      else if (msg.t === "reject") rec.rejects.push(msg);
    });
    ws.rec = rec;
    ws.send(JSON.stringify({ v: 2, t: "joinRoom", code, name, version: 2 }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => {
  console.log((ok ? "PASS" : "FAIL") + ": " + label);
  if (!ok) failures++;
};

try {
  const host = await createRoom("ALICE");
  const code = host.ws.rec.welcome?.code;
  console.log("0) room created: code=" + code + " isHost=" + host.ws.rec.welcome?.isHost);
  check("room code issued (4 chars) + host flag", typeof code === "string" && code.length === 4 && host.ws.rec.welcome?.isHost === true);

  await sleep(800);
  console.log("1) solo lobby: rosters=" + host.ws.rec.rosters.length + " snapshots=" + host.ws.rec.snapshots + " starts=" + host.ws.rec.starts);
  check("solo joiner held in lobby, no game", host.ws.rec.snapshots === 0 && host.ws.rec.starts === 0);
  check("roster has color + hostId", host.ws.rec.rosters.at(-1)?.players?.every((p) => typeof p.color === "string") && typeof host.ws.rec.rosters.at(-1)?.hostId === "number");

  const joiner = await joinRoom("BOB", code);
  check("joiner welcome same code, not host", joiner.ws.rec.welcome?.code === code && joiner.ws.rec.welcome?.isHost === false);
  await sleep(1500);
  console.log("2) two joined, waiting: host starts=" + host.ws.rec.starts + " | joiner starts=" + joiner.ws.rec.starts);
  check("holds briefly before auto-start", host.ws.rec.starts === 0 && joiner.ws.rec.starts === 0);
  await sleep(3000);
  console.log("3) after wait: host starts=" + host.ws.rec.starts + " snaps=" + host.ws.rec.snapshots + " | joiner starts=" + joiner.ws.rec.starts);
  check("auto-starts once 2+ players joined", host.ws.rec.starts >= 1 && joiner.ws.rec.starts >= 1 && host.ws.rec.snapshots > 0);

  const late = await joinRoom("CAROL", code);
  await sleep(800);
  console.log("4) late join: starts=" + late.ws.rec.starts + " snaps=" + late.ws.rec.snapshots);
  check("late join caught up", late.ws.rec.starts >= 1);

  // Bad code rejected.
  const badWs = await rawConnect();
  const badReason = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), 3000);
    badWs.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.t === "reject") { clearTimeout(t); resolve(m.reason); }
      } catch { /* ignore */ }
    });
    badWs.send(JSON.stringify({ v: 2, t: "joinRoom", code: "ZZZZ", name: "DAVE", version: 2 }));
  });
  console.log("5) bad code: " + badReason);
  check("bad code rejected", /not found|bad code/i.test(String(badReason)));
  try { badWs.close(); } catch { /* noop */ }

  // Host delete kicks everyone.
  host.ws.send(JSON.stringify({ v: 2, t: "deleteRoom" }));
  await sleep(600);
  console.log("6) delete: joiner closed=" + JSON.stringify(joiner.ws.rec.closed) + " late closed=" + JSON.stringify(late.ws.rec.closed));
  check("host delete kicks joiners (roomClosed)", !!joiner.ws.rec.closed && !!late.ws.rec.closed);
  check("room removed from server", server.roomCount === 0);

  try { host.ws.close(); } catch { /* noop */ }
  try { joiner.ws.close(); } catch { /* noop */ }
  try { late.ws.close(); } catch { /* noop */ }
  await sleep(300);

  // Host quit auto-deletes.
  const h2 = await createRoom("HOST2");
  const code2 = h2.ws.rec.welcome.code;
  const j2 = await joinRoom("JOIN2", code2);
  await sleep(300);
  h2.ws.close(); // host quit without deleteRoom
  await sleep(600);
  console.log("7) host quit: joiner closed=" + JSON.stringify(j2.ws.rec.closed) + " rooms=" + server.roomCount);
  check("host quit auto-deletes room (joiner kicked)", !!j2.ws.rec.closed && server.roomCount === 0);
  // Rejoining the dead code fails.
  const deadWs = await rawConnect();
  const deadReason = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), 3000);
    deadWs.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.t === "reject") { clearTimeout(t); resolve(m.reason); }
      } catch { /* ignore */ }
    });
    deadWs.send(JSON.stringify({ v: 2, t: "joinRoom", code: code2, name: "GHOST", version: 2 }));
  });
  check("dead room code rejected", /not found/i.test(String(deadReason)));
  try { deadWs.close(); } catch { /* noop */ }
  try { j2.ws.close(); } catch { /* noop */ }
  await sleep(300);
} catch (e) {
  console.error("ERROR:", e);
  failures++;
} finally {
  server.stop();
  console.log(failures === 0 ? "ALL ROOM TESTS PASSED" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
