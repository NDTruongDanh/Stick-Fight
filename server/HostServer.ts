import { WebSocket, WebSocketServer } from "ws";
import type { Server as HttpServer } from "node:http";
import { Match, emptyInput } from "./Match.js";
import type { MatchInput } from "./Match.js";
import { LEVELS } from "../src/levels/levels.js";
import { MAX_PLAYERS, PROTOCOL_VERSION, SNAP_RATE, TICK_RATE } from "../shared/constants.js";
import type { ClientMsg, ServerMsg } from "../shared/protocol.js";
import type { LevelDef } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Room-based LAN host (protocol v2).
//
// One server process hosts MANY independent rooms. Any client can create a
// room (becoming its host); others join via a short room code. The host can
// delete the room (everyone is kicked); if the host disconnects the room is
// auto-deleted. Each room owns one authoritative Match with its own lobby
// auto-start, roster, and snapshot stream.
//
// This file REPLACES the old single-match HostServer (v1 hello/start flow).
// ---------------------------------------------------------------------------

interface RoomClient {
  id: number;
  slot: number;
  name: string;
  ws: WebSocket;
  input: MatchInput;
  joinedOk: boolean;
}

const send = (ws: WebSocket, msg: ServerMsg): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

/** Fixed-step host loop tuning (see pumpSim). */
const TICK_WAKE_MS = 10;
const MAX_CATCHUP = 5;
const STALL_CLAMP_MS = 250;
const HEALTH_LOG_MS = 30_000;

/** Room code alphabet: unambiguous uppercase alphanumerics (no 0/O/1/I). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 4;
const MAX_ROOMS = 32;

function makeCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
  }
  return s;
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 4 || s.length > 6) return null;
  if (!/^[A-Z0-9]+$/.test(s)) return null;
  return s;
}

function clampWins(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(10, n));
}

function clampBots(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_PLAYERS, n));
}

function parseCustomLevel(raw: unknown): { level: LevelDef; json: string } | null {
  if (typeof raw !== "string" || raw.length < 10 || raw.length > 200_000) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (!Array.isArray(rec.spawns) || rec.spawns.length === 0) return null;
    if (!Array.isArray(rec.weaponDrops) || rec.weaponDrops.length === 0) return null;
    return { level: parsed as LevelDef, json: raw };
  } catch {
    return null;
  }
}

class Room {
  clients = new Map<number, RoomClient>();
  match: Match;
  started = false;
  startTimer: ReturnType<typeof setTimeout> | null = null;
  seed = (Math.random() * 2 ** 31) | 0;
  customJson: string | null = null;
  tickAcc = 0;
  lastSnapTick = 0;
  winsTarget: number;

  constructor(
    public code: string,
    public hostId: number,
    level: LevelDef,
    opts: { cycle: LevelDef[]; winsTarget: number; customJson: string | null },
  ) {
    this.match = new Match(level, { cycle: opts.cycle, winsTarget: opts.winsTarget });
    this.winsTarget = opts.winsTarget;
    this.customJson = opts.customJson;
  }

  destroy(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  firstFreeSlot(): number {
    const used = new Set([...this.clients.values()].map((c) => c.slot));
    for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return 0;
  }

  addInitialBots(n: number): void {
    const count = Math.max(0, Math.min(MAX_PLAYERS, Math.floor(n) || 0));
    for (let i = 0; i < count; i++) {
      this.match.addPlayer(-1000 - i - Math.abs(this.hostId) * 10, `BOT-${i + 1}`, undefined, true);
    }
  }

  trimBots(): void {
    while (this.match.players.length > MAX_PLAYERS) {
      const bot = this.match.players.find((p) => p.isBot);
      if (!bot) return;
      this.match.removePlayer(bot.id);
    }
  }

  humans(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.joinedOk) n++;
    return n;
  }

  broadcastRoster(): void {
    const slots = new Map<number, number>();
    for (const c of this.clients.values()) slots.set(c.id, c.slot);
    const players = this.match.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      slot: slots.get(p.id) ?? i,
      bot: !!p.isBot,
      color: p.color,
    }));
    const msg = {
      v: PROTOCOL_VERSION,
      t: "roster",
      players,
      code: this.code,
      hostId: this.hostId,
    } as unknown as ServerMsg;
    for (const c of this.clients.values()) send(c.ws, msg);
  }

  maybeAutoStart(startFn: () => void): void {
    if (this.started || this.humans() < 2 || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!this.started && this.humans() >= 2) startFn();
    }, 3000);
  }

  cancelPendingStartIfLonely(): void {
    if (!this.started && this.humans() < 2 && this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  startMatch(): void {
    if (this.started) return;
    this.started = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    const msg: ServerMsg = {
      v: PROTOCOL_VERSION,
      t: "start",
      levelId: this.match.level.id,
      seed: this.seed,
      code: this.code,
    };
    if (this.customJson) msg.levelJson = this.customJson;
    for (const c of this.clients.values()) send(c.ws, msg);
  }

  sendStartTo(ws: WebSocket): void {
    const msg: ServerMsg = {
      v: PROTOCOL_VERSION,
      t: "start",
      levelId: this.match.level.id,
      seed: this.seed,
      code: this.code,
    };
    if (this.customJson) msg.levelJson = this.customJson;
    send(ws, msg);
  }

  broadcastSnapshot(): void {
    if (!this.started) return;
    const events = this.match.drainEvents();
    for (const e of events) {
      if (e.kind === "matchEnd") {
        const wins: Record<number, number> = {};
        for (const p of this.match.players) wins[p.id] = this.match.wins[p.id] ?? 0;
        const end: ServerMsg = { v: PROTOCOL_VERSION, t: "matchEnd", wins };
        for (const c of this.clients.values()) send(c.ws, end);
      }
    }
    const acks: Record<number, number> = {};
    for (const c of this.clients.values()) {
      const seq = c.input.seq;
      if (typeof seq === "number" && Number.isFinite(seq)) acks[c.id] = Math.floor(seq);
    }
    const players = this.match.players.map((p) => ({
      id: p.id, name: p.name, color: p.color,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      facing: p.facing, aimX: p.aimX, aimY: p.aimY,
      hp: p.hp, alive: p.alive,
      weapon: p.weapon, ammo: p.ammo, cooldown: p.cooldown,
      onGround: p.onGround, wins: p.wins, kills: p.kills,
      isBot: p.isBot, boss: p.boss, maxHp: p.maxHp,
    }));
    const projectiles = this.match.projectiles.map((pr) => ({
      id: pr.id, kind: pr.kind, x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy,
      life: pr.life, owner: pr.owner, bounces: pr.bounces,
    }));
    const msg: ServerMsg = {
      v: PROTOCOL_VERSION,
      t: "snapshot",
      tick: this.match.tick,
      time: this.match.time,
      levelId: this.match.level.id,
      round: this.match.round,
      players,
      projectiles,
      crates: this.match.crates,
      barrels: this.match.barrels,
      drops: this.match.drops,
      events,
      acks,
    };
    const raw = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
    }
  }
}

export class HostServer {
  private wss: WebSocketServer | null = null;
  private rooms = new Map<string, Room>();
  /** Socket -> room membership (only set after create/join succeeds). */
  private sockRoom = new Map<WebSocket, { roomCode: string; clientId: number }>();
  private pendingHello = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private nextId = 1;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastTickWall = 0;
  private tickDrops = 0;
  private healthSteps = 0;
  private healthSince = 0;

  constructor(
    private port: number,
    private defaultLevelId = "woods1",
    private defaultWins = 5,
    private defaultBots = 0,
    private tickHz = TICK_RATE,
  ) {
    this.tickHz = Math.max(10, Math.min(120, Math.floor(this.tickHz) || TICK_RATE));
    this.defaultWins = Math.max(1, Math.min(10, Math.floor(this.defaultWins) || 5));
    this.defaultBots = Math.max(0, Math.min(MAX_PLAYERS, Math.floor(this.defaultBots) || 0));
  }

  /** Room count (tests / health). */
  get roomCount(): number {
    return this.rooms.size;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  start(httpServer?: HttpServer): void {
    this.wss = httpServer
      ? new WebSocketServer({ server: httpServer })
      : new WebSocketServer({ port: this.port });
    this.wss.on("connection", (ws) => this.onConnect(ws));
    this.wss.on("error", (err) => console.error("[host] ws error:", err));

    this.lastTickWall = Date.now();
    this.healthSince = Date.now();
    this.healthSteps = 0;
    this.tickDrops = 0;
    const dt = 1 / this.tickHz;
    this.timers.push(setInterval(() => this.pumpSim(dt), TICK_WAKE_MS));
    console.log(
      httpServer
        ? `[host] room server attached (tick ${this.tickHz}Hz, snap ${SNAP_RATE}Hz, max ${MAX_ROOMS} rooms)`
        : `[host] room server on port ${this.port} (tick ${this.tickHz}Hz, snap ${SNAP_RATE}Hz)`,
    );
  }

  /**
   * Fixed-step accumulator shared across rooms: each 10ms wake converts real
   * elapsed wall-clock time into fixed-dt Match steps per started room.
   * Lobby rooms stay frozen (no bot fights) until their match starts.
   */
  private pumpSim(dt: number): void {
    const now = Date.now();
    let elapsed = now - this.lastTickWall;
    this.lastTickWall = now;
    if (!(elapsed >= 0)) elapsed = 0;
    if (elapsed > STALL_CLAMP_MS) elapsed = STALL_CLAMP_MS;
    const snapEvery = Math.max(1, Math.round(this.tickHz / SNAP_RATE));
    for (const room of this.rooms.values()) {
      if (!room.started) {
        room.tickAcc = 0;
        continue;
      }
      room.tickAcc += elapsed / 1000;
      let steps = 0;
      while (room.tickAcc >= dt && steps < MAX_CATCHUP) {
        const inputs = new Map<number, MatchInput>();
        for (const c of room.clients.values()) inputs.set(c.id, c.input);
        room.match.step(dt, inputs);
        room.tickAcc -= dt;
        steps++;
      }
      this.healthSteps += steps;
      if (room.tickAcc >= dt) {
        const dropped = Math.floor(room.tickAcc / dt);
        this.tickDrops += dropped;
        room.tickAcc -= dropped * dt;
      }
      if (steps > 0 && room.match.tick - room.lastSnapTick >= snapEvery) {
        room.lastSnapTick = room.match.tick;
        room.broadcastSnapshot();
      }
    }
    if (now - this.healthSince >= HEALTH_LOG_MS) {
      const secs = (now - this.healthSince) / 1000;
      console.log(
        `[host] tick health: ${(this.healthSteps / secs).toFixed(1)} steps/s, ${this.tickDrops} drops (rooms ${this.rooms.size})`,
      );
      this.healthSteps = 0;
      this.tickDrops = 0;
      this.healthSince = now;
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const room of this.rooms.values()) {
      room.destroy();
      for (const c of room.clients.values()) {
        try {
          c.ws.close();
        } catch {
          /* noop */
        }
      }
    }
    this.rooms.clear();
    for (const t of this.pendingHello.values()) clearTimeout(t);
    this.pendingHello.clear();
    this.sockRoom.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  private onConnect(ws: WebSocket): void {
    const helloTimeout = setTimeout(() => {
      this.pendingHello.delete(ws);
      if (!this.sockRoom.has(ws) && ws.readyState === WebSocket.OPEN) {
        send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "no hello (send createRoom or joinRoom)" });
        ws.close();
      }
    }, 5000);
    this.pendingHello.set(ws, helloTimeout);

    ws.on("message", (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null || (msg as { v?: unknown }).v !== PROTOCOL_VERSION) return;
      switch (msg.t) {
        case "createRoom":
          this.handleCreate(ws, msg);
          break;
        case "joinRoom":
          this.handleJoin(ws, msg);
          break;
        case "input": {
          const mem = this.sockRoom.get(ws);
          if (!mem) return;
          const room = this.rooms.get(mem.roomCode);
          const c = room?.clients.get(mem.clientId);
          if (!room || !c) return;
          c.input = {
            left: !!msg.left, right: !!msg.right, jump: !!msg.jump,
            down: !!msg.down, fire: !!msg.fire, block: !!msg.block,
            throwReq: !!msg.throwReq,
            aimX: Number(msg.aimX) || 0, aimY: Number(msg.aimY) || 0,
            seq: msg.seq,
          };
          break;
        }
        case "leaveRoom":
          this.handleLeave(ws);
          break;
        case "deleteRoom":
          this.handleDelete(ws);
          break;
        case "ping":
          send(ws, { v: PROTOCOL_VERSION, t: "pong", t0: msg.t0 });
          break;
      }
    });

    ws.on("close", () => this.handleClose(ws));
    ws.on("error", () => {
      /* handled by close */
    });
  }

  private clearPending(ws: WebSocket): void {
    const t = this.pendingHello.get(ws);
    if (t) {
      clearTimeout(t);
      this.pendingHello.delete(ws);
    }
  }

  private generateCode(): string | null {
    for (let i = 0; i < 100; i++) {
      const c = makeCode();
      if (!this.rooms.has(c)) return c;
    }
    return null;
  }

  private handleCreate(ws: WebSocket, msg: Extract<ClientMsg, { t: "createRoom" }>): void {
    if (this.sockRoom.has(ws)) return;
    if (msg.version !== PROTOCOL_VERSION) {
      send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "protocol mismatch" });
      ws.close();
      return;
    }
    if (this.rooms.size >= MAX_ROOMS) {
      send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "server full (max rooms)" });
      ws.close();
      return;
    }
    const code = this.generateCode();
    if (!code) {
      send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "server full (max rooms)" });
      ws.close();
      return;
    }
    const id = this.nextId++;
    const name = String(msg.name || `P${id}`).slice(0, 16) || `P${id}`;
    const winsTarget = clampWins(msg.wins, this.defaultWins);
    const botCount = msg.bots === undefined ? this.defaultBots : clampBots(msg.bots);
    const levelId = typeof msg.levelId === "string" && msg.levelId ? msg.levelId : this.defaultLevelId;

    let level: LevelDef = LEVELS.find((l) => l.id === levelId)
      ?? LEVELS.find((l) => l.id === this.defaultLevelId)
      ?? LEVELS[0];
    let cycle: LevelDef[] = [...LEVELS];
    let customJson: string | null = null;
    if (msg.levelJson) {
      const custom = parseCustomLevel(msg.levelJson);
      if (custom) {
        level = custom.level;
        customJson = custom.json;
        cycle = [custom.level, ...LEVELS.filter((l) => l.id !== custom.level.id)];
      }
    }

    const room = new Room(code, id, level, { cycle, winsTarget, customJson });
    room.addInitialBots(botCount);
    const info: RoomClient = { id, slot: 0, name, ws, input: emptyInput(), joinedOk: true };
    room.clients.set(id, info);
    // Host takes slot 0; Match color follows slot order.
    room.match.addPlayer(id, name);
    room.trimBots();
    this.rooms.set(code, room);
    this.sockRoom.set(ws, { roomCode: code, clientId: id });
    this.clearPending(ws);

    send(ws, {
      v: PROTOCOL_VERSION, t: "welcome",
      clientId: id, slot: 0, levelId: room.match.level.id, code, isHost: true,
    });
    room.broadcastRoster();
    room.maybeAutoStart(() => room.startMatch());
  }

  private handleJoin(ws: WebSocket, msg: Extract<ClientMsg, { t: "joinRoom" }>): void {
    if (this.sockRoom.has(ws)) return;
    if (msg.version !== PROTOCOL_VERSION) {
      send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "protocol mismatch" });
      ws.close();
      return;
    }
    const code = normalizeRoomCode(msg.code);
    if (!code) {
      send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "bad room code" });
      ws.close();
      return;
    }
    const room = this.rooms.get(code);
    if (!room) {
      send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "room not found (bad code)" });
      ws.close();
      return;
    }
    if (room.clients.size >= MAX_PLAYERS) {
      send(ws, { v: PROTOCOL_VERSION, t: "reject", reason: "room full (max 4)" });
      ws.close();
      return;
    }
    const id = this.nextId++;
    const name = String(msg.name || `P${id}`).slice(0, 16) || `P${id}`;
    const slot = room.firstFreeSlot();
    const info: RoomClient = { id, slot, name, ws, input: emptyInput(), joinedOk: true };
    room.clients.set(id, info);
    room.match.addPlayer(id, name);
    room.trimBots();
    this.sockRoom.set(ws, { roomCode: code, clientId: id });
    this.clearPending(ws);

    send(ws, {
      v: PROTOCOL_VERSION, t: "welcome",
      clientId: id, slot, levelId: room.match.level.id, code, isHost: id === room.hostId,
    });
    room.broadcastRoster();
    room.maybeAutoStart(() => room.startMatch());
    if (room.started) room.sendStartTo(ws);
  }

  /** Voluntary leave: remove the sender; host leaving deletes the room. */
  private handleLeave(ws: WebSocket): void {
    const mem = this.sockRoom.get(ws);
    if (!mem) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      return;
    }
    const room = this.rooms.get(mem.roomCode);
    if (!room) {
      this.sockRoom.delete(ws);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      return;
    }
    const isHost = mem.clientId === room.hostId;
    // Detach the leaver first so close() below is a no-op for them.
    room.clients.delete(mem.clientId);
    room.match.removePlayer(mem.clientId);
    this.sockRoom.delete(ws);
    try {
      ws.close();
    } catch {
      /* noop */
    }
    if (isHost) {
      // Host quit -> auto-delete: kick everyone else out.
      this.closeRoom(room, "host left — room closed");
    } else {
      room.cancelPendingStartIfLonely();
      if (room.clients.size === 0) {
        room.destroy();
        this.rooms.delete(room.code);
      } else {
        room.broadcastRoster();
      }
    }
  }

  /** Host-only: delete the room, kicking everyone out. */
  private handleDelete(ws: WebSocket): void {
    const mem = this.sockRoom.get(ws);
    if (!mem) return;
    const room = this.rooms.get(mem.roomCode);
    if (!room) return;
    if (mem.clientId !== room.hostId) return;
    this.closeRoom(room, "room deleted by host");
  }

  private closeRoom(room: Room, reason: string): void {
    if (!this.rooms.has(room.code)) return;
    room.destroy();
    this.rooms.delete(room.code);
    const msg: ServerMsg = { v: PROTOCOL_VERSION, t: "roomClosed", reason, code: room.code };
    for (const c of room.clients.values()) {
      this.sockRoom.delete(c.ws);
      send(c.ws, msg);
      try {
        c.ws.close();
      } catch {
        /* noop */
      }
    }
    room.clients.clear();
  }

  private handleClose(ws: WebSocket): void {
    const t = this.pendingHello.get(ws);
    if (t) {
      clearTimeout(t);
      this.pendingHello.delete(ws);
    }
    const mem = this.sockRoom.get(ws);
    if (!mem) return;
    const room = this.rooms.get(mem.roomCode);
    this.sockRoom.delete(ws);
    if (!room) return;
    const wasHost = mem.clientId === room.hostId;
    const had = room.clients.delete(mem.clientId);
    if (had) room.match.removePlayer(mem.clientId);
    if (wasHost) {
      // Host quit (disconnect) -> auto-delete the room.
      this.closeRoom(room, "host left — room closed");
      return;
    }
    room.cancelPendingStartIfLonely();
    if (room.clients.size === 0) {
      room.destroy();
      this.rooms.delete(room.code);
    } else {
      room.broadcastRoster();
    }
  }
}
