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
  /** Lobby ready flag (/ready /unready). Not part of the sim. */
  ready: boolean;
}

const send = (ws: WebSocket, msg: ServerMsg): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

async function resolveLevel(id: string): Promise<LevelDef | null> {
  // Canonical pack is statically bundled; no dynamic import needed.
  return LEVELS.find((l) => l.id === id) ?? null;
}

/** Fixed-step host loop tuning (see pumpSim). */
const TICK_WAKE_MS = 10;
const MAX_CATCHUP = 5;
const STALL_CLAMP_MS = 250;
const HEALTH_LOG_MS = 30_000;

export class HostServer {
  private wss: WebSocketServer | null = null;
  private match: Match;
  private clients = new Map<number, ClientInfo>();
  private nextId = 1;
  private timers: ReturnType<typeof setInterval>[] = [];
  private tickAcc = 0;
  private lastTickWall = 0;
  private tickDrops = 0;
  private healthSteps = 0;
  private healthSince = 0;
  private started = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private seed = (Math.random() * 2 ** 31) | 0;
  private customJson: string | null = null;
  /** Sequence for unique runtime bot names (BOT-<n>). */
  private nextBotSeq = 1;

  constructor(
    private port: number,
    private levelId: string,
    private winsTarget = 5,
    private botCount = 0,
    customLevel?: LevelDef | null,
    private tickHz = TICK_RATE,
  ) {
    this.tickHz = Math.max(10, Math.min(120, Math.floor(this.tickHz) || TICK_RATE));
    if (customLevel) {
      this.customJson = JSON.stringify(customLevel);
      this.match = new Match(customLevel, {
        cycle: [customLevel, ...LEVELS.filter((l) => l.id !== customLevel.id)],
        winsTarget: this.winsTarget,
      });
    } else {
      const level = LEVELS.find((l) => l.id === levelId) ?? LEVELS[0];
      this.match = new Match(level, { cycle: [...LEVELS], winsTarget: this.winsTarget });
    }
    this.addInitialBots(botCount);
    this.nextBotSeq = Math.max(0, Math.min(MAX_PLAYERS, Math.floor(botCount) || 0)) + 1;
  }

  start(): void {
    // Upgrade to the real level pack if another module provides it (non-blocking).
    // Skipped for custom levels: the JSON def is already authoritative.
    if (!this.customJson) {
      void resolveLevel(this.levelId).then((lv) => {
        if (lv && this.wss) {
          this.match.level = lv;
        }
      });
    }

    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on("connection", (ws) => this.onConnect(ws));
    this.wss.on("error", (err) => console.error("[host] ws error:", err));

    const dt = 1 / this.tickHz;
    this.tickAcc = 0;
    this.lastTickWall = Date.now();
    this.healthSince = Date.now();
    this.healthSteps = 0;
    this.tickDrops = 0;
    this.timers.push(
      setInterval(() => {
        this.pumpSim(dt);
      }, TICK_WAKE_MS),
    );
    this.timers.push(
      setInterval(() => {
        this.broadcastSnapshot();
      }, 1000 / SNAP_RATE),
    );
    console.log(`[host] listening on port ${this.port} (tick ${this.tickHz}Hz, snap ${SNAP_RATE}Hz)`);
  }

  /**
   * Fixed-step accumulator: each 10ms wake converts real elapsed wall-clock
   * time into fixed-dt Match steps, so a starved event loop (server + clients
   * sharing one Windows loop) catches up instead of running the sim slow.
   * At most MAX_CATCHUP steps run per wake; surplus backlog is dropped and
   * counted (slow-motion under extreme load, never a death spiral). The tick
   * counter increments per executed step, so snapshot tick semantics are
   * unchanged. Snapshot broadcast stays on its own 20Hz wall-clock timer.
   */
  private pumpSim(dt: number): void {
    const now = Date.now();
    let elapsed = now - this.lastTickWall;
    this.lastTickWall = now;
    if (!(elapsed >= 0)) elapsed = 0;
    if (elapsed > STALL_CLAMP_MS) elapsed = STALL_CLAMP_MS;
    this.tickAcc += elapsed / 1000;
    let steps = 0;
    while (this.tickAcc >= dt && steps < MAX_CATCHUP) {
      const inputs = new Map<number, MatchInput>();
      for (const c of this.clients.values()) inputs.set(c.id, c.input);
      this.match.step(dt, inputs);
      this.tickAcc -= dt;
      steps++;
    }
    this.healthSteps += steps;
    if (this.tickAcc >= dt) {
      const dropped = Math.floor(this.tickAcc / dt);
      this.tickDrops += dropped;
      this.tickAcc -= dropped * dt;
    }
    if (now - this.healthSince >= HEALTH_LOG_MS) {
      const secs = (now - this.healthSince) / 1000;
      console.log(
        `[host] tick health: ${(this.healthSteps / secs).toFixed(1)} steps/s, ${this.tickDrops} drops (tick ${this.match.tick})`,
      );
      this.healthSteps = 0;
      this.tickDrops = 0;
      this.healthSince = now;
    }
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
    const info: ClientInfo = { id, slot, name: `P${id}`, ws, input: emptyInput(), helloOk: false, ready: false };
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
          this.trimBots();
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
          if (info.helloOk) this.handleChat(info, text);
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
        // A non-ready player leaving may leave everyone else all-ready.
        this.checkReadyStart();
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

  /** Prefill bots so small LAN parties start with a full arena. */
  private addInitialBots(n: number): void {
    const count = Math.max(0, Math.min(MAX_PLAYERS, Math.floor(n) || 0));
    for (let i = 0; i < count; i++) {
      // Negative IDs outside Match's auto-bot range (-1, -2, …).
      this.match.addPlayer(-1000 - i, `BOT-${i + 1}`, undefined, true);
    }
  }

  /** Keep total fighters (humans + bots) within MAX_PLAYERS. */
  private trimBots(): void {
    while (this.match.players.length > MAX_PLAYERS) {
      const bot = this.match.players.find((p) => p.isBot);
      if (!bot) return;
      this.match.removePlayer(bot.id);
    }
  }

  private broadcastRoster(): void {
    const slots = new Map<number, number>();
    for (const c of this.clients.values()) slots.set(c.id, c.slot);
    // `ready` is an additive optional flag: old clients ignore unknown JSON
    // fields, new clients read it via an optional cast. No version bump.
    const players: { id: number; name: string; slot: number; bot: boolean; ready?: boolean }[] =
      this.match.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        slot: slots.get(p.id) ?? i,
        bot: !!p.isBot,
        ready: p.isBot ? true : (this.clients.get(p.id)?.ready ?? false),
      }));
    const msg = { v: PROTOCOL_VERSION, t: "roster", players } as unknown as ServerMsg;
    for (const c of this.clients.values()) send(c.ws, msg);
  }

  private chat(from: string, text: string): void {
    const msg: ServerMsg = { v: PROTOCOL_VERSION, t: "chat", from, text };
    for (const c of this.clients.values()) send(c.ws, msg);
  }

  /** Host = slot 0, i.e. the first client to join. Host-only chat commands. */
  private isHost(info: ClientInfo): boolean {
    return info.slot === 0;
  }

  /** Private server note to one client (usage errors, unknown commands). */
  private tell(info: ClientInfo, text: string): void {
    send(info.ws, { v: PROTOCOL_VERSION, t: "chat", from: "server", text });
  }

  private readyCount(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.helloOk && c.ready) n++;
    return n;
  }

  /**
   * Slash-command lobby controls. Plain (non-slash) text is broadcast as chat;
   * slash input is consumed as a command and never rebroadcast.
   */
  private handleChat(info: ClientInfo, text: string): void {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      this.chat(info.name, text);
      return;
    }
    const [rawCmd, ...rest] = trimmed.slice(1).split(/\s+/);
    const cmd = (rawCmd || "").toLowerCase();
    const arg = rest.join(" ").slice(0, 32);
    switch (cmd) {
      case "ready": {
        info.ready = true;
        this.broadcastRoster();
        this.chat("server", `${info.name} is READY (${this.readyCount()}/${this.humans()}) — /unready to cancel`);
        this.checkReadyStart();
        break;
      }
      case "unready": {
        info.ready = false;
        this.broadcastRoster();
        this.chat("server", `${info.name} is not ready (${this.readyCount()}/${this.humans()})`);
        break;
      }
      case "start": {
        if (!this.isHost(info)) {
          this.tell(info, "only the host can use /start");
          break;
        }
        this.startMatch(true);
        break;
      }
      case "restart": {
        if (!this.isHost(info)) {
          this.tell(info, "only the host can use /restart");
          break;
        }
        this.doRestart(info.name);
        break;
      }
      case "kick": {
        if (!this.isHost(info)) {
          this.tell(info, "only the host can use /kick");
          break;
        }
        if (!arg) {
          this.tell(info, "usage: /kick <name>");
          break;
        }
        const target = [...this.clients.values()].find(
          (c) => c.helloOk && c.name.toLowerCase() === arg.toLowerCase(),
        );
        if (!target) {
          this.tell(info, `no player named "${arg}"`);
          break;
        }
        if (target.slot === 0) {
          this.tell(info, "cannot kick the host");
          break;
        }
        this.chat("server", `${target.name} was kicked by the host`);
        send(target.ws, { v: PROTOCOL_VERSION, t: "reject", reason: "kicked by host" });
        try {
          target.ws.close();
        } catch {
          /* handled by close */
        }
        break;
      }
      case "bots": {
        if (!this.isHost(info)) {
          this.tell(info, "only the host can use /bots");
          break;
        }
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 0 || n > MAX_PLAYERS) {
          this.tell(info, `usage: /bots <0-${MAX_PLAYERS}>`);
          break;
        }
        const applied = this.setBotCount(n);
        this.broadcastRoster();
        this.chat("server", `bots set to ${applied} by ${info.name}`);
        break;
      }
      default: {
        const hostCmds = this.isHost(info) ? " /start /restart /kick <name> /bots <n>" : "";
        this.tell(info, `unknown command "/${cmd}" — try /ready /unready${hostCmds}`);
        break;
      }
    }
  }

  /** Auto-start when every connected human (min 2) is /ready. */
  private checkReadyStart(): void {
    if (this.started) return;
    const humans = [...this.clients.values()].filter((c) => c.helloOk);
    if (humans.length >= 2 && humans.every((c) => c.ready)) {
      this.chat("server", "all players ready — starting!");
      this.startMatch(false);
    }
  }

  /** Host /restart: clear match scores and open a fresh round 1. */
  private doRestart(by: string): void {
    this.match.wins = {};
    for (const p of this.match.players) {
      p.wins = 0;
      p.kills = 0;
    }
    this.match.round = 1;
    // resetArena is Match-internal; snapshots carry the fresh arena.
    (this.match as unknown as { resetArena(): void }).resetArena();
    this.broadcastRoster();
    this.chat("server", `match restarted by ${by} — scores cleared, round 1`);
  }

  /** Host /bots: set bot count, clamped so humans + bots stay within MAX_PLAYERS. */
  private setBotCount(n: number): number {
    const capped = Math.max(0, Math.min(MAX_PLAYERS - this.humans(), n));
    const bots = this.match.players.filter((p) => p.isBot);
    if (bots.length < capped) {
      const used = new Set(this.match.players.map((p) => p.id));
      let need = capped - bots.length;
      let cand = -1000;
      while (need > 0) {
        if (!used.has(cand)) {
          this.match.addPlayer(cand, `BOT-${this.nextBotSeq++}`, undefined, true);
          used.add(cand);
          need--;
        }
        cand--;
      }
    } else if (bots.length > capped) {
      let excess = bots.length - capped;
      for (const b of bots) {
        if (excess <= 0) break;
        this.match.removePlayer(b.id);
        excess--;
      }
    }
    this.trimBots();
    return capped;
  }

  private humans(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.helloOk) n++;
    return n;
  }

  private maybeAutoStart(): void {
    if (this.started || this.humans() < 2 || this.startTimer) return;
    this.chat("server", "lobby: type /ready (host: /start) — starting in 3s…");
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
    if (this.customJson) msg.levelJson = this.customJson;
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
    if (this.customJson) msg.levelJson = this.customJson;
    const raw = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
    }
  }
}
