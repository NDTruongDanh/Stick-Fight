import { PROTOCOL_VERSION } from "../../shared/constants.js";
import type { ClientMsg, ServerMsg } from "../../shared/protocol.js";

export type SnapshotMsg = Extract<ServerMsg, { t: "snapshot" }>;
export type RosterMsg = Extract<ServerMsg, { t: "roster" }>;
export type StartMsg = Extract<ServerMsg, { t: "start" }>;
export type WelcomeMsg = Extract<ServerMsg, { t: "welcome" }>;
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

export class NetClient {
  clientId = -1;
  slot = -1;
  levelId = "";
  pingMs = 0;
  /** Raw host-provided custom level JSON (LAN --level-file), if any. */
  customLevel: string | null = null;

  onSnapshot: (s: SnapshotMsg) => void = () => {};
  onRoster: (r: RosterMsg) => void = () => {};
  onStart: (s: StartMsg) => void = () => {};
  onWelcome: (w: WelcomeMsg) => void = () => {};
  onMatchEnd: (wins: Record<number, number>) => void = () => {};
  onClose: () => void = () => {};

  private ws: WebSocket | null = null;
  private url = "";
  private name = "";
  /** Last connection failure (reject reason / error / drop). Null while connected. */
  lastError: string | null = null;
  /** Consecutive auto-reconnect attempts for the current outage. */
  reconnectAttempts = 0;
  /** Fires on each scheduled auto-reconnect with the 1-based attempt number. */
  onReconnect: (attempt: number) => void = () => {};
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private maxReconnectAttempts = 5;
  private reconnectBaseMs = 1000;
  /** Last close followed a server reject (full/version) — do not retry. */
  private rejectFatal = false;
  private manualClose = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((e: Error) => void) | null = null;

  connect(url: string, name: string): Promise<void> {
    this.url = url;
    this.name = name;
    this.manualClose = false;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.rejectFatal = false;
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.open();
      // Safety timeout: reject if no welcome arrives.
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
      const hello: ClientMsg = { v: PROTOCOL_VERSION, t: "hello", name: this.name, version: PROTOCOL_VERSION };
      ws.send(JSON.stringify(hello));
      this.startPing();
    };
    ws.onmessage = (ev) => this.handle(String(ev.data));
    ws.onclose = () => {
      this.stopPing();
      try {
        this.onClose();
      } catch {
        /* listener error — still schedule reconnect below */
      }
      // No retry after a deliberate close or a fatal reject (full/version).
      if (this.manualClose || this.rejectFatal) {
        this.rejectFatal = false;
        if (!this.manualClose && !this.lastError) this.lastError = "disconnected";
        return;
      }
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.lastError = "connection lost (reconnects exhausted)";
        return;
      }
      // Exponential backoff: 1s, 2s, 4s, … capped at 10s.
      this.reconnectAttempts++;
      const delay = Math.min(10000, this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1));
      this.lastError = "connection lost — retrying…";
      const attempt = this.reconnectAttempts;
      try {
        this.onReconnect(attempt);
      } catch {
        /* ignore listener errors */
      }
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => {
      // Errors surface via onclose; if we never got welcome, reject connect().
      if (this.clientId < 0) this.lastError = "websocket error";
      if (this.clientId < 0 && this.connectReject) {
        const rej = this.connectReject;
        this.connectResolve = null;
        this.connectReject = null;
        rej(new Error("websocket error"));
      }
    };
  }

  sendInput(in_: InputPayload): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: ClientMsg = { v: PROTOCOL_VERSION, t: "input", ...in_ };
    ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }

  /**
   * Manually (re)connect, resetting backoff state. Use after a fatal reject
   * (e.g. server full) or exhausted auto-retries, e.g. from a retry button.
   */
  reconnect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.manualClose = false;
    this.rejectFatal = false;
    this.reconnectAttempts = 0;
    this.lastError = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
        // Fatal: the server refused us (full / version) — onclose must not retry.
        this.rejectFatal = true;
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
