import { PROTOCOL_VERSION } from "../../shared/constants.js";
import type { ClientMsg, ServerMsg } from "../../shared/protocol.js";

export type SnapshotMsg = Extract<ServerMsg, { t: "snapshot" }>;
export type RosterMsg = Extract<ServerMsg, { t: "roster" }>;
export type ChatMsg = Extract<ServerMsg, { t: "chat" }>;
export type StartMsg = Extract<ServerMsg, { t: "start" }>;
export type WelcomeMsg = Extract<ServerMsg, { t: "welcome" }>;

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

  onSnapshot: (s: SnapshotMsg) => void = () => {};
  onRoster: (r: RosterMsg) => void = () => {};
  onChat: (c: ChatMsg) => void = () => {};
  onStart: (s: StartMsg) => void = () => {};
  onWelcome: (w: WelcomeMsg) => void = () => {};
  onMatchEnd: (wins: Record<number, number>) => void = () => {};
  onClose: () => void = () => {};

  private ws: WebSocket | null = null;
  private url = "";
  private name = "";
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnected = false; // auto-reconnect once
  private manualClose = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((e: Error) => void) | null = null;

  connect(url: string, name: string): Promise<void> {
    this.url = url;
    this.name = name;
    this.manualClose = false;
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
      this.onClose();
      // Auto-reconnect once (unless the user closed deliberately).
      if (!this.manualClose && !this.reconnected) {
        this.reconnected = true;
        this.reconnectTimer = setTimeout(() => this.open(), 1000);
      }
    };
    ws.onerror = () => {
      // Errors surface via onclose; if we never got welcome, reject connect().
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

  sendChat(text: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg: ClientMsg = { v: PROTOCOL_VERSION, t: "chat", text: text.slice(0, 200) };
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
        this.onWelcome(msg);
        if (this.connectResolve) {
          const res = this.connectResolve;
          this.connectResolve = null;
          this.connectReject = null;
          res();
        }
        break;
      case "reject":
        if (this.connectReject) {
          const rej = this.connectReject;
          this.connectResolve = null;
          this.connectReject = null;
          rej(new Error(msg.reason));
        }
        break;
      case "snapshot":
        this.onSnapshot(msg);
        break;
      case "roster":
        this.onRoster(msg);
        break;
      case "chat":
        this.onChat(msg);
        break;
      case "start":
        this.levelId = msg.levelId;
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
