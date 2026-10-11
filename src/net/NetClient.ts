import { PROTOCOL_VERSION } from "../../shared/constants.js";
import type { ClientMsg, ServerMsg } from "../../shared/protocol.js";

export type SnapshotMsg = Extract<ServerMsg, { t: "snapshot" }>;
export type RosterMsg = Extract<ServerMsg, { t: "roster" }>;
export type StartMsg = Extract<ServerMsg, { t: "start" }>;
export type WelcomeMsg = Extract<ServerMsg, { t: "welcome" }>;
export type RoomClosedMsg = Extract<ServerMsg, { t: "roomClosed" }>;
/** Roster entry from the host broadcast. */
export type RosterPlayer = RosterMsg["players"][number];

export interface InputPayload {
  seq: number;
  left: boolean;
  right: boolean;
  jump: boolean;
  down: boolean;
  fire: boolean;
  block: boolean;
  throwReq: boolean;
  aimX: number;
  aimY: number;
}

export interface CreateRoomOpts {
  wins?: number;
  bots?: number;
  levelId?: string;
  levelJson?: string;
}

/**
 * Room-aware LAN client (protocol v2).
 *
 * One socket == one room visit: createRoom() makes you the host, joinRoom()
 * joins via code. deleteRoom() (host only) closes the room; roomClosed means
 * kicked/deleted (fatal, no retry). Unexpected drops are fatal too — the
 * caller returns to the menu (no auto-reconnect: a host drop deletes the
 * room, so retrying would need a new code anyway).
 */
export class NetClient {
  clientId = -1;
  slot = -1;
  levelId = "";
  roomCode = "";
  isHost = false;
  hostId = -1;
  pingMs = 0;
  /** Raw host-provided custom level JSON, if any. */
  customLevel: string | null = null;

  onSnapshot: (s: SnapshotMsg) => void = () => {};
  onRoster: (r: RosterMsg) => void = () => {};
  onStart: (s: StartMsg) => void = () => {};
  onWelcome: (w: WelcomeMsg) => void = () => {};
  onMatchEnd: (wins: Record<number, number>) => void = () => {};
  onRoomClosed: (reason: string, code: string) => void = () => {};
  onClose: () => void = () => {};

  private ws: WebSocket | null = null;
  private url = "";
  private name = "";
  private pendingCreate: CreateRoomOpts | null = null;
  private pendingJoinCode: string | null = null;
  /** Last connection failure (reject reason / roomClosed / drop). Null while connected. */
  lastError: string | null = null;
  /** Kept for HUD compat — room mode never auto-reconnects, always 0. */
  reconnectAttempts = 0;
  /** Fires when the server closes our room (kicked / deleted). */
  onReconnect: (attempt: number) => void = () => {};
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Last close followed a fatal message (reject/roomClosed) — informational only. */
  private fatalClose = false;
  private manualClose = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((e: Error) => void) | null = null;

  createRoom(url: string, name: string, opts: CreateRoomOpts = {}): Promise<void> {
    this.url = url;
    this.name = name;
    this.pendingCreate = { ...opts };
    this.pendingJoinCode = null;
    return this.dial();
  }

  joinRoom(url: string, code: string, name: string): Promise<void> {
    this.url = url;
    this.name = name;
    this.pendingJoinCode = code.trim().toUpperCase();
    this.pendingCreate = null;
    return this.dial();
  }

  /** Back-compat: old hello flow is gone — use createRoom/joinRoom. */
  connect(): Promise<void> {
    return Promise.reject(new Error("use createRoom() or joinRoom()"));
  }

  private dial(): Promise<void> {
    this.manualClose = false;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.fatalClose = false;
    this.clientId = -1;
    this.slot = -1;
    this.roomCode = "";
    this.isHost = false;
    this.hostId = -1;
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.open();
      setTimeout(() => {
        if (this.clientId < 0 && this.connectReject) {
          const rej = this.connectReject;
          this.connectResolve = null;
          this.connectReject = null;
          this.lastError = "connect timeout (no welcome)";
          rej(new Error("connect timeout (no welcome)"));
        }
      }, 6000);
    });
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      let msg: ClientMsg;
      if (this.pendingCreate) {
        msg = {
          v: PROTOCOL_VERSION, t: "createRoom",
          name: this.name, version: PROTOCOL_VERSION,
          ...(this.pendingCreate.wins !== undefined ? { wins: this.pendingCreate.wins } : {}),
          ...(this.pendingCreate.bots !== undefined ? { bots: this.pendingCreate.bots } : {}),
          ...(this.pendingCreate.levelId ? { levelId: this.pendingCreate.levelId } : {}),
          ...(this.pendingCreate.levelJson ? { levelJson: this.pendingCreate.levelJson } : {}),
        };
      } else {
        msg = {
          v: PROTOCOL_VERSION, t: "joinRoom",
          code: this.pendingJoinCode ?? "", name: this.name, version: PROTOCOL_VERSION,
        };
      }
      ws.send(JSON.stringify(msg));
      this.startPing();
    };
    ws.onmessage = (ev) => this.handle(String(ev.data));
    ws.onclose = () => {
      this.stopPing();
      try {
        this.onClose();
      } catch {
        /* listener error */
      }
      if (this.manualClose || this.fatalClose) {
        if (!this.manualClose && !this.lastError) this.lastError = "disconnected";
        return;
      }
      // Unexpected drop: fatal in room mode (no auto-reconnect).
      if (!this.lastError) this.lastError = "connection lost";
    };
    ws.onerror = () => {
      if (this.clientId < 0) this.lastError = "websocket error";
      if (this.clientId < 0 && this.connectReject) {
        const rej = this.connectReject;
        this.connectResolve = null;
        this.connectReject = null;
        rej(new Error("websocket error"));
      }
    };
  }

  /** Host-only: delete the room (kicks everyone, including self). */
  deleteRoom(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: ClientMsg = { v: PROTOCOL_VERSION, t: "deleteRoom" };
    ws.send(JSON.stringify(msg));
  }

  sendInput(in_: InputPayload): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: ClientMsg = { v: PROTOCOL_VERSION, t: "input", ...in_ };
    ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.manualClose = true;
    this.stopPing();
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }

  /**
   * Manual reconnect: re-dial with the same intent (join reuses the code;
   * create makes a NEW room with a NEW code).
   */
  reconnect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.manualClose = false;
    this.fatalClose = false;
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.open();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg: ClientMsg = { v: PROTOCOL_VERSION, t: "ping", t0: Date.now() };
      ws.send(JSON.stringify(msg));
    }, 2000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handle(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || msg.v !== PROTOCOL_VERSION) return;
    switch (msg.t) {
      case "welcome":
        this.clientId = msg.clientId;
        this.slot = msg.slot;
        this.levelId = msg.levelId;
        this.roomCode = msg.code;
        this.isHost = !!msg.isHost;
        this.lastError = null;
        this.reconnectAttempts = 0;
        this.onWelcome(msg);
        if (this.connectResolve) {
          const res = this.connectResolve;
          this.connectResolve = null;
          this.connectReject = null;
          res();
        }
        break;
      case "reject":
        this.lastError = msg.reason;
        this.fatalClose = true;
        if (this.connectReject) {
          const rej = this.connectReject;
          this.connectResolve = null;
          this.connectReject = null;
          rej(new Error(msg.reason));
        }
        break;
      case "roomClosed":
        this.lastError = msg.reason;
        this.fatalClose = true;
        try {
          this.onRoomClosed(msg.reason, msg.code);
        } catch {
          /* ignore listener errors */
        }
        // Fail a pending connect too (e.g. joined a room that closed instantly).
        if (this.connectReject) {
          const rej = this.connectReject;
          this.connectResolve = null;
          this.connectReject = null;
          rej(new Error(msg.reason));
        }
        break;
      case "snapshot":
        this.customLevel = msg.levelJson ?? null;
        this.onSnapshot(msg);
        break;
      case "roster":
        this.hostId = msg.hostId;
        // Keep isHost in sync (host never changes, but stay truthful).
        if (this.clientId >= 0) this.isHost = msg.hostId === this.clientId;
        this.onRoster(msg);
        break;
      case "start":
        this.levelId = msg.levelId;
        this.customLevel = msg.levelJson ?? null;
        this.onStart(msg);
        break;
      case "pong":
        this.pingMs = Date.now() - msg.t0;
        break;
      case "matchEnd":
        this.onMatchEnd(msg.wins);
        break;
    }
  }
}
