import { WebSocket, WebSocketServer } from "ws";
import { Match, emptyInput } from "./Match.js";
import type { MatchInput } from "./Match.js";
import { LEVELS } from "../src/levels/levels.js";
import { MAX_PLAYERS, PROTOCOL_VERSION, SNAP_RATE, TICK_RATE } from "../shared/constants.js";
import type { ClientMsg, ServerMsg } from "../shared/protocol.js";
import type { LevelDef } from "../shared/types.js";

interface ClientInfo {
  id: number;
  slot: number;
  name: string;
  ws: WebSocket;
  input: MatchInput;
  helloOk: boolean;
}

const send = (ws: WebSocket, msg: ServerMsg): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

async function resolveLevel(id: string): Promise<LevelDef | null> {
  // Canonical pack is statically bundled; no dynamic import needed.
  return LEVELS.find((l) => l.id === id) ?? null;
}

export class HostServer {
  private wss: WebSocketServer | null = null;
  private match: Match;
  private clients = new Map<number, ClientInfo>();
  private nextId = 1;
  private timers: ReturnType<typeof setInterval>[] = [];
  private started = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private seed = (Math.random() * 2 ** 31) | 0;

  constructor(
    private port: number,
    private levelId: string,
  ) {
    const level = LEVELS.find((l) => l.id === levelId) ?? LEVELS[0];
    this.match = new Match(level, { cycle: [...LEVELS] });
  }

  start(): void {
    // Upgrade to the real level pack if another module provides it (non-blocking).
    void resolveLevel(this.levelId).then((lv) => {
      if (lv && this.wss) {
        this.match.level = lv;
      }
    });

    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on("connection", (ws) => this.onConnect(ws));
    this.wss.on("error", (err) => console.error("[host] ws error:", err));

    const dt = 1 / TICK_RATE;
    this.timers.push(
      setInterval(() => {
        const inputs = new Map<number, MatchInput>();
        for (const c of this.clients.values()) inputs.set(c.id, c.input);
        this.match.step(dt, inputs);
      }, 1000 / TICK_RATE),
    );
    this.timers.push(
      setInterval(() => {
        this.broadcastSnapshot();
      }, 1000 / SNAP_RATE),
    );
    console.log(`[host] listening on port ${this.port}`);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    for (const c of this.clients.values()) {
      try {
        c.ws.close();
      } catch {
        /* noop */
      }
    }
    this.clients.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  private onConnect(ws: WebSocket): void {
    if (this.clients.size >= MAX_PLAYERS) {
      send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "server full (max 4)" });
      ws.close();
      return;
    }
    const id = this.nextId++;
    const slot = this.firstFreeSlot();
    const info: ClientInfo = { id, slot, name: `P${id}`, ws, input: emptyInput(), helloOk: false };
    this.clients.set(id, info);

    const helloTimeout = setTimeout(() => {
      if (!info.helloOk && ws.readyState === WebSocket.OPEN) {
        send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "no hello" });
        ws.close();
      }
    }, 5000);

    ws.on("message", (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null || (msg as { v?: unknown }).v !== PROTOCOL_VERSION) return;
      switch (msg.t) {
        case "hello": {
          if (msg.version !== PROTOCOL_VERSION) {
            send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "protocol mismatch" });
            ws.close();
            return;
          }
          info.name = String(msg.name || info.name).slice(0, 16) || info.name;
          info.helloOk = true;
          clearTimeout(helloTimeout);
          this.match.addPlayer(id, info.name);
          send(ws, { v: PROTOCOL_VERSION, t: "welcome", clientId: id, slot, levelId: this.match.level.id });
          this.broadcastRoster();
          this.chat("server", `${info.name} joined (${this.clients.size}/${MAX_PLAYERS})`);
          this.maybeAutoStart();
          break;
        }
        case "input":
          info.input = {
            left: !!msg.left, right: !!msg.right, jump: !!msg.jump,
            down: !!msg.down, fire: !!msg.fire, block: !!msg.block,
            throwReq: !!msg.throwReq,
            aimX: Number(msg.aimX) || 0, aimY: Number(msg.aimY) || 0,
            seq: msg.seq,
          };
          break;
        case "ping":
          send(ws, { v: PROTOCOL_VERSION, t: "pong", t0: msg.t0 });
          break;
        case "chat": {
          const text = String(msg.text).slice(0, 200);
          // Host `start` command: slot 0 types /start (protocol has no start msg).
          if (text.trim() === "/start" && info.slot === 0 && info.helloOk) {
            this.startMatch(true);
          } else if (info.helloOk) {
            this.chat(info.name, text);
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimeout);
      const had = this.clients.delete(id);
      if (had) {
        this.match.removePlayer(id);
        this.broadcastRoster();
        if (info.helloOk) this.chat("server", `${info.name} left`);
      }
    });
    ws.on("error", () => {
      /* handled by close */
    });
  }

  private firstFreeSlot(): number {
    const used = new Set([...this.clients.values()].map((c) => c.slot));
    for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return 0;
  }

  private broadcastRoster(): void {
    const slots = new Map<number, number>();
    for (const c of this.clients.values()) slots.set(c.id, c.slot);
    const players = this.match.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      slot: slots.get(p.id) ?? i,
      bot: !!p.isBot,
    }));
    const msg: ServerMsg = { v: PROTOCOL_VERSION, t: "roster", players };
    for (const c of this.clients.values()) send(c.ws, msg);
  }

  private chat(from: string, text: string): void {
    const msg: ServerMsg = { v: PROTOCOL_VERSION, t: "chat", from, text };
    for (const c of this.clients.values()) send(c.ws, msg);
  }

  private humans(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.helloOk) n++;
    return n;
  }

  private maybeAutoStart(): void {
    if (this.started || this.humans() < 2 || this.startTimer) return;
    this.chat("server", "starting in 3s… (host can type /start)");
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!this.started && this.humans() >= 2) this.startMatch(false);
    }, 3000);
  }

  private startMatch(forced: boolean): void {
    if (this.started) return;
    this.started = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    const msg: ServerMsg = { v: PROTOCOL_VERSION, t: "start", levelId: this.match.level.id, seed: this.seed };
    for (const c of this.clients.values()) send(c.ws, msg);
    this.chat("server", forced ? "match started by host" : "match started!");
  }

  private broadcastSnapshot(): void {
    if (!this.wss) return;
    const events = this.match.drainEvents();
    // Surface matchEnd to clients as a dedicated message as well.
    for (const e of events) {
      if (e.kind === "matchEnd") {
        const wins: Record<number, number> = {};
        for (const p of this.match.players) wins[p.id] = this.match.wins[p.id] ?? 0;
        const end: ServerMsg = { v: PROTOCOL_VERSION, t: "matchEnd", wins };
        for (const c of this.clients.values()) send(c.ws, end);
      }
    }
    const msg: ServerMsg = {
      v: PROTOCOL_VERSION,
      t: "snapshot",
      tick: this.match.tick,
      time: this.match.time,
      levelId: this.match.level.id,
      round: this.match.round,
      players: this.match.players,
      projectiles: this.match.projectiles,
      crates: this.match.crates,
      barrels: this.match.barrels,
      drops: this.match.drops,
      events,
    };
    const raw = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
    }
  }
}
