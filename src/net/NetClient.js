import { PROTOCOL_VERSION } from "../../shared/constants.js";
export class NetClient {
    constructor() {
        Object.defineProperty(this, "clientId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: -1
        });
        Object.defineProperty(this, "slot", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: -1
        });
        Object.defineProperty(this, "levelId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ""
        });
        Object.defineProperty(this, "pingMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        /** Raw host-provided custom level JSON (LAN --level-file), if any. */
        Object.defineProperty(this, "customLevel", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "onSnapshot", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "onRoster", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "onChat", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "onStart", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "onWelcome", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "onMatchEnd", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "onClose", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "ws", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "url", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ""
        });
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ""
        });
        /** Last connection failure (reject reason / error / drop). Null while connected. */
        Object.defineProperty(this, "lastError", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        /** Consecutive auto-reconnect attempts for the current outage. */
        Object.defineProperty(this, "reconnectAttempts", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        /** Fires on each scheduled auto-reconnect with the 1-based attempt number. */
        Object.defineProperty(this, "onReconnect", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "pingTimer", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "reconnectTimer", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "maxReconnectAttempts", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 5
        });
        Object.defineProperty(this, "reconnectBaseMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 1000
        });
        /** Last close followed a server reject (full/kicked/version) — do not retry. */
        Object.defineProperty(this, "rejectFatal", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "manualClose", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "connectResolve", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "connectReject", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
    }
    connect(url, name) {
        this.url = url;
        this.name = name;
        this.manualClose = false;
        this.lastError = null;
        this.reconnectAttempts = 0;
        this.rejectFatal = false;
        return new Promise((resolve, reject) => {
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
    open() {
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.onopen = () => {
            const hello = { v: PROTOCOL_VERSION, t: "hello", name: this.name, version: PROTOCOL_VERSION };
            ws.send(JSON.stringify(hello));
            this.startPing();
        };
        ws.onmessage = (ev) => this.handle(String(ev.data));
        ws.onclose = () => {
            this.stopPing();
            try {
                this.onClose();
            }
            catch {
                /* listener error — still schedule reconnect below */
            }
            // No retry after a deliberate close or a fatal reject (full/kicked/version).
            if (this.manualClose || this.rejectFatal) {
                this.rejectFatal = false;
                if (!this.manualClose && !this.lastError)
                    this.lastError = "disconnected";
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
            }
            catch {
                /* ignore listener errors */
            }
            this.reconnectTimer = setTimeout(() => this.open(), delay);
        };
        ws.onerror = () => {
            // Errors surface via onclose; if we never got welcome, reject connect().
            if (this.clientId < 0)
                this.lastError = "websocket error";
            if (this.clientId < 0 && this.connectReject) {
                const rej = this.connectReject;
                this.connectResolve = null;
                this.connectReject = null;
                rej(new Error("websocket error"));
            }
        };
    }
    sendInput(in_) {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        const msg = { v: PROTOCOL_VERSION, t: "input", ...in_ };
        ws.send(JSON.stringify(msg));
    }
    sendChat(text) {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        const msg = { v: PROTOCOL_VERSION, t: "chat", text: text.slice(0, 200) };
        ws.send(JSON.stringify(msg));
    }
    close() {
        this.manualClose = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopPing();
        try {
            this.ws?.close();
        }
        catch {
            /* noop */
        }
        this.ws = null;
    }
    /**
     * Manually (re)connect, resetting backoff state. Use after a fatal reject
     * (e.g. kick) or exhausted auto-retries, e.g. from a retry button.
     */
    reconnect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))
            return;
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
    startPing() {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN)
                return;
            const msg = { v: PROTOCOL_VERSION, t: "ping", t0: Date.now() };
            ws.send(JSON.stringify(msg));
        }, 2000);
    }
    stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }
    handle(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (typeof msg !== "object" || msg === null || msg.v !== PROTOCOL_VERSION)
            return;
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
                // Fatal: the server refused us (full / kicked / version) — onclose must not retry.
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
            case "chat":
                this.onChat(msg);
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
