import { NetClient } from "../net/NetClient.js";
import type { SnapshotMsg } from "../net/NetClient.js";
import { Predictor } from "../net/predict.js";
import type { PredictedInput } from "../net/predict.js";
import {
  GRAVITY,
  JUMP_SPEED,
  MAX_FALL,
  MOVE_SPEED,
  PLAYER_HP,
  WORLD_H,
  WORLD_W,
} from "../../shared/constants.js";
import type { LevelDef, PlayerState } from "../../shared/types.js";

const PW = 26;
const PH = 54;

const FALLBACK_LEVEL: LevelDef = {
  id: "woods1",
  name: "Woods",
  theme: "woods",
  platforms: [
    { x: 0.05, y: 0.82, w: 0.9, h: 0.05 },
    { x: 0.1, y: 0.6, w: 0.22, h: 0.035 },
    { x: 0.68, y: 0.6, w: 0.22, h: 0.035 },
    { x: 0.32, y: 0.42, w: 0.36, h: 0.035 },
    { x: 0.42, y: 0.22, w: 0.16, h: 0.03, type: "bouncy" },
  ],
  spawns: [[0.15, 0.7], [0.85, 0.7], [0.35, 0.3], [0.65, 0.3]],
  weaponDrops: [[0.5, 0.3], [0.2, 0.5], [0.8, 0.5]],
};

async function resolveLevel(id: string): Promise<LevelDef> {
  try {
    const path = "../levels/index.js"; // src/levels/index.ts if the level pack exists
    const mod = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
    const pick = (lv: unknown): LevelDef | null =>
      lv && typeof lv === "object" && "platforms" in (lv as object) && "spawns" in (lv as object)
        ? (lv as LevelDef)
        : null;
    if (typeof mod["getLevel"] === "function") {
      const lv = pick((mod["getLevel"] as (x: string) => unknown)(id));
      if (lv) return lv;
    }
    const levels = mod["LEVELS"] as unknown;
    const all: unknown[] = Array.isArray(levels)
      ? levels
      : levels && typeof levels === "object"
        ? Object.values(levels as Record<string, unknown>)
        : [];
    for (const l of all) {
      const p = pick(l);
      if (p && p.id === id) return p;
    }
    for (const l of all) {
      const p = pick(l);
      if (p) return p;
    }
  } catch {
    /* use fallback */
  }
  return FALLBACK_LEVEL;
}

interface KeyState {
  left: boolean; right: boolean; jump: boolean; down: boolean;
  fire: boolean; block: boolean; throwReq: boolean;
}

export class OnlineMode {
  private net = new NetClient();
  private predictor = new Predictor();
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private seq = 0;
  private level: LevelDef = FALLBACK_LEVEL;
  private started = false;
  private snaps: { msg: SnapshotMsg; at: number }[] = [];
  private me: PlayerState | null = null; // predicted local copy
  private keys = new Set<string>();
  private mouse = { x: 0, y: 0, down: false, rdown: false };
  private prevThrow = false;
  private feed: string[] = [];
  private roster: { id: number; name: string; bot: boolean }[] = [];
  private lastFrame = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private url: string,
    private name: string,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    this.sizeCanvas();
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    this.canvas.addEventListener("contextmenu", this.onCtxMenu);

    await this.net.connect(this.url, this.name);
    this.level = await resolveLevel(this.net.levelId || FALLBACK_LEVEL.id);

    this.net.onSnapshot = (s) => this.onSnapshot(s);
    this.net.onStart = () => {
      this.started = true;
      void resolveLevel(this.net.levelId).then((lv) => {
        this.level = lv;
      });
      this.pushFeed("match started!");
    };
    this.net.onRoster = (r) => {
      this.roster = r.players;
    };
    this.net.onChat = (c) => this.pushFeed(`${c.from}: ${c.text}`);
    this.net.onMatchEnd = (wins) => {
      const best = Object.entries(wins).sort((a, b) => b[1] - a[1])[0];
      this.pushFeed(best ? `match won by #${best[0]} (${best[1]})` : "match over");
    };

    this.running = true;
    this.lastFrame = performance.now();
    this.sendTimer = setInterval(() => this.sendInput(), 1000 / 30);
    const loop = (t: number) => {
      if (!this.running) return;
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("contextmenu", this.onCtxMenu);
    this.net.close();
  }

  get ping(): number {
    return this.net.pingMs;
  }

  // ---- input ----

  private onResize = (): void => this.sizeCanvas();

  private sizeCanvas(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };
  private onMouseMove = (e: MouseEvent): void => {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - r.left;
    this.mouse.y = e.clientY - r.top;
  };
  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.mouse.down = true;
    if (e.button === 2) this.mouse.rdown = true;
  };
  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouse.down = false;
    if (e.button === 2) this.mouse.rdown = false;
  };
  private onCtxMenu = (e: Event): void => e.preventDefault();

  private readKeys(): KeyState {
    const k = this.keys;
    const left = k.has("ArrowLeft") || k.has("KeyA");
    const right = k.has("ArrowRight") || k.has("KeyD");
    const jump = k.has("ArrowUp") || k.has("KeyW") || k.has("Space");
    const down = k.has("ArrowDown") || k.has("KeyS");
    const block = k.has("ShiftLeft") || k.has("ShiftRight") || this.mouse.rdown;
    const throwReq = k.has("KeyQ") || k.has("KeyE") || k.has("KeyF");
    return { left, right, jump, down, fire: this.mouse.down, block, throwReq };
  }

  private view(): { s: number; ox: number; oy: number } {
    const cw = this.canvas.width, ch = this.canvas.height;
    const s = Math.min(cw / WORLD_W, ch / WORLD_H);
    return { s, ox: (cw - WORLD_W * s) / 2, oy: (ch - WORLD_H * s) / 2 };
  }

  private screenToWorld(px: number, py: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, r.width);
    const { s, ox, oy } = this.view();
    return { x: ((px * dpr - ox) / s), y: ((py * dpr - oy) / s) };
  }

  private sendInput(): void {
    if (!this.running) return;
    const ks = this.readKeys();
    const m = this.me;
    const mw = this.screenToWorld(this.mouse.x, this.mouse.y);
    const aimX = m ? mw.x - m.x : 0;
    const aimY = m ? mw.y - (m.y + PH / 2) : 0;
    const throwEdge = ks.throwReq && !this.prevThrow;
    this.prevThrow = ks.throwReq;
    const input: PredictedInput = {
      seq: ++this.seq,
      left: ks.left, right: ks.right, jump: ks.jump, down: ks.down,
      fire: ks.fire, block: ks.block, throwReq: throwEdge,
      aimX, aimY,
    };
    this.predictor.pushLocal(input);
    this.net.sendInput(input);
    // Apply immediately to the local predicted copy.
    if (this.me) this.simulateMe(this.me, input, 1 / 30);
  }

  // ---- snapshots / prediction ----

  private onSnapshot(s: SnapshotMsg): void {
    if (s.levelId && s.levelId !== this.level.id) {
      void resolveLevel(s.levelId).then((lv) => {
        this.level = lv;
      });
    }
    this.snaps.push({ msg: s, at: performance.now() });
    if (this.snaps.length > 4) this.snaps.shift();
    this.predictor.reconcile(s.players, this.net.clientId);
    const srv = s.players.find((p) => p.id === this.net.clientId) ?? null;
    if (srv) {
      if (!this.me) {
        this.me = { ...srv };
      } else {
        // Snap toward server, then replay unacked inputs (light rewind).
        const dx = srv.x - this.me.x, dy = srv.y - this.me.y;
        if (Math.hypot(dx, dy) > 120) {
          this.me = { ...srv };
        } else {
          const keepHp = this.me.hp;
          Object.assign(this.me, { ...srv, hp: srv.hp <= 0 ? 0 : keepHp > srv.hp ? keepHp : srv.hp });
          for (const u of this.predictor.unacked()) this.simulateMe(this.me, u, 1 / 60);
        }
      }
    }
  }

  private solidsAt(): { x: number; y: number; w: number; h: number }[] {
    const t = this.snaps.length ? this.snaps[this.snaps.length - 1].msg.time : 0;
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const pl of this.level.platforms) {
      if (pl.type === "blink") {
        const period = pl.period ?? 3, duty = pl.duty ?? 0.6, phase = pl.phase ?? 0;
        if (!(((t + phase) % period) < period * duty)) continue;
      }
      out.push({ x: pl.x * WORLD_W, y: pl.y * WORLD_H, w: pl.w * WORLD_W, h: pl.h * WORLD_H });
    }
    for (const m of this.level.movers ?? []) {
      const off = Math.sin((t * Math.PI * 2) / Math.max(0.1, m.period) + (m.phase ?? 0)) * m.range * WORLD_W;
      out.push({
        x: m.x * WORLD_W + (m.axis === "x" ? off : 0),
        y: m.y * WORLD_H + (m.axis === "y" ? off : 0),
        w: m.w * WORLD_W, h: m.h * WORLD_H,
      });
    }
    return out;
  }

  private simulateMe(p: PlayerState, inp: PredictedInput, dt: number): void {
    const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    if (dir !== 0) p.facing = dir;
    p.vx += (dir * MOVE_SPEED - p.vx) * Math.min(1, (p.onGround ? 14 : 7) * dt);
    p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * dt);
    const solids = this.solidsAt();
    p.x += p.vx * dt;
    for (const s of solids) {
      if (p.x - PW / 2 < s.x + s.w && p.x + PW / 2 > s.x && p.y < s.y + s.h && p.y + PH > s.y) {
        if (p.vx > 0) p.x = s.x - PW / 2;
        else if (p.vx < 0) p.x = s.x + s.w + PW / 2;
        p.vx = 0;
      }
    }
    p.y += p.vy * dt;
    p.onGround = false;
    for (const s of solids) {
      if (p.x - PW / 2 < s.x + s.w && p.x + PW / 2 > s.x && p.y < s.y + s.h && p.y + PH > s.y) {
        if (p.vy > 0) {
          p.y = s.y - PH;
          p.vy = 0;
          p.onGround = true;
        } else if (p.vy < 0) {
          p.y = s.y + s.h;
          p.vy = 0;
        }
      }
    }
    if (inp.jump && p.onGround) {
      p.vy = -JUMP_SPEED;
      p.onGround = false;
    }
    p.aimX = inp.aimX;
    p.aimY = inp.aimY;
  }

  // ---- frame / render ----

  private frame(t: number): void {
    const dt = Math.min(0.05, (t - this.lastFrame) / 1000 || 0.016);
    this.lastFrame = t;
    void dt;
    this.render();
  }

  private interpPlayers(): PlayerState[] {
    if (!this.snaps.length) return [];
    const renderAt = performance.now() - 100;
    let a = this.snaps[0], b = this.snaps[this.snaps.length - 1];
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].at <= renderAt && this.snaps[i + 1].at >= renderAt) {
        a = this.snaps[i];
        b = this.snaps[i + 1];
      }
    }
    const span = Math.max(1, b.at - a.at);
    const alpha = Math.min(1, Math.max(0, (renderAt - a.at) / span));
    const byId = new Map(a.msg.players.map((p) => [p.id, p]));
    return b.msg.players.map((pb) => {
      const pa = byId.get(pb.id);
      if (!pa) return { ...pb };
      return { ...pb, x: pa.x + (pb.x - pa.x) * alpha, y: pa.y + (pb.y - pa.y) * alpha };
    });
  }

  private latest(): SnapshotMsg | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1].msg : null;
  }

  private pushFeed(text: string): void {
    this.feed.push(text);
    if (this.feed.length > 5) this.feed.shift();
  }

  private render(): void {
    const { ctx } = this;
    const cw = this.canvas.width, ch = this.canvas.height;
    const { s, ox, oy } = this.view();
    // bg
    const theme = this.level.theme;
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    if (theme === "foundry") {
      g.addColorStop(0, "#1c1210");
      g.addColorStop(1, "#3a1f14");
    } else {
      g.addColorStop(0, "#0b1a12");
      g.addColorStop(1, "#132b1d");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    // arena border
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, WORLD_W, WORLD_H);

    this.drawPlatforms(ctx);
    const snap = this.latest();
    if (snap) {
      for (const k of this.level.killRects ?? []) this.drawKillRect(ctx, k, snap.time);
      for (const d of snap.drops) this.drawDrop(ctx, d.x, d.y, d.weapon);
      for (const c of snap.crates) this.drawCrate(ctx, c.x, c.y, c.w, c.h, c.angle);
      for (const b of snap.barrels) this.drawBarrel(ctx, b.x, b.y);
      for (const pr of snap.projectiles) this.drawProjectile(ctx, pr.x, pr.y, pr.kind);
      const players = this.interpPlayers();
      for (const p of players) {
        const show = p.id === this.net.clientId && this.me ? this.me : p;
        this.drawPlayer(ctx, show);
      }
    }
    ctx.restore();
    this.drawHUD(ctx, cw, ch);
  }

  private drawPlatforms(ctx: CanvasRenderingContext2D): void {
    const t = this.latest()?.time ?? 0;
    for (const pl of this.level.platforms) {
      if (pl.type === "blink") {
        const period = pl.period ?? 3, duty = pl.duty ?? 0.6, phase = pl.phase ?? 0;
        if (!(((t + phase) % period) < period * duty)) continue;
      }
      const x = pl.x * WORLD_W, y = pl.y * WORLD_H, w = pl.w * WORLD_W, h = Math.max(6, pl.h * WORLD_H);
      ctx.fillStyle =
        pl.type === "ice" ? "#9fd8ff" :
        pl.type === "bouncy" ? "#f472b6" :
        pl.type === "conveyor" ? "#a78bfa" :
        pl.type === "lava" ? "#ef4444" : "#4b6b4f";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(x, y, w, 3);
    }
    for (const m of this.level.movers ?? []) {
      const off = Math.sin((t * Math.PI * 2) / Math.max(0.1, m.period) + (m.phase ?? 0)) * m.range * WORLD_W;
      ctx.fillStyle = "#d9a441";
      ctx.fillRect(
        m.x * WORLD_W + (m.axis === "x" ? off : 0),
        m.y * WORLD_H + (m.axis === "y" ? off : 0),
        m.w * WORLD_W, Math.max(6, m.h * WORLD_H),
      );
    }
  }

  private drawKillRect(
    ctx: CanvasRenderingContext2D,
    k: { x: number; y: number; w: number; h: number; kind: string; period?: number; duty?: number; phase?: number },
    t: number,
  ): void {
    let active = true;
    if (k.kind === "laser" && k.period) {
      active = ((t + (k.phase ?? 0)) % k.period) < k.period * (k.duty ?? 0.5);
    }
    if (!active) return;
    ctx.fillStyle = k.kind === "laser" ? "rgba(255,60,60,0.8)" : "rgba(255,120,20,0.55)";
    ctx.fillRect(k.x * WORLD_W, k.y * WORLD_H, k.w * WORLD_W, k.h * WORLD_H);
  }

  private drawDrop(ctx: CanvasRenderingContext2D, x: number, y: number, weapon: string): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "#1f2937";
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(-16, -8, 32, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fbbf24";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(weapon.slice(0, 6), 0, 3);
    ctx.restore();
  }

  private drawCrate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, angle: number): void {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(angle);
    ctx.fillStyle = "#8b5a2b";
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = "#5b3a17";
    ctx.lineWidth = 2;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(w / 2, h / 2);
    ctx.moveTo(w / 2, -h / 2);
    ctx.lineTo(-w / 2, h / 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawBarrel(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.fillStyle = "#b91c1c";
    ctx.beginPath();
    ctx.ellipse(x, y, 14, 24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fbbf24";
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "center";
    ctx.fillText("!", x, y + 4);
  }

  private drawProjectile(ctx: CanvasRenderingContext2D, x: number, y: number, kind: string): void {
    ctx.fillStyle = kind === "laser" ? "#22d3ee" : "#fde047";
    ctx.beginPath();
    ctx.arc(x, y, kind === "laser" ? 5 : 4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerState): void {
    if (!p.alive) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x - 12, p.y + 10);
      ctx.lineTo(p.x + 12, p.y + 34);
      ctx.moveTo(p.x + 12, p.y + 10);
      ctx.lineTo(p.x - 12, p.y + 34);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const cx = p.x, top = p.y;
    const midY = top + 22, hipY = top + 38;
    const run = Math.min(1, Math.abs(p.vx) / MOVE_SPEED);
    const t = performance.now() / 140;
    const swing = p.onGround ? Math.sin(t) * 9 * run : 5;
    ctx.strokeStyle = p.color === "#eab308" ? "#eab308" : p.color;
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    // legs
    ctx.beginPath();
    ctx.moveTo(cx, hipY);
    ctx.lineTo(cx - 8 - swing, top + PH);
    ctx.moveTo(cx, hipY);
    ctx.lineTo(cx + 8 + swing, top + PH);
    ctx.stroke();
    // body
    ctx.beginPath();
    ctx.moveTo(cx, midY);
    ctx.lineTo(cx, hipY);
    ctx.stroke();
    // gun arm toward aim
    const l = Math.hypot(p.aimX, p.aimY);
    const ax = l > 1 ? p.aimX / l : p.facing, ay = l > 1 ? p.aimY / l : 0;
    ctx.beginPath();
    ctx.moveTo(cx, midY);
    ctx.lineTo(cx + ax * 22, midY + ay * 22);
    ctx.stroke();
    if (p.weapon !== "fists") {
      ctx.fillStyle = "#111827";
      ctx.fillRect(cx + ax * 22 - 7, midY + ay * 22 - 3, 14, 6);
    }
    // head
    ctx.beginPath();
    ctx.arc(cx, top + 9, 9, 0, Math.PI * 2);
    ctx.fillStyle = "#f5f5f5";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#111";
    ctx.stroke();
    // hp bar + name
    const w = 44;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(cx - w / 2, top - 16, w, 6);
    ctx.fillStyle = p.hp > 50 ? "#22c55e" : p.hp > 25 ? "#eab308" : "#ef4444";
    ctx.fillRect(cx - w / 2, top - 16, (w * Math.max(0, p.hp)) / PLAYER_HP, 6);
    ctx.fillStyle = "#fff";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(p.id === this.net.clientId ? `${p.name} (you)` : p.name, cx, top - 20);
  }

  private drawHUD(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const snap = this.latest();
    const me = snap?.players.find((p) => p.id === this.net.clientId) ?? this.me;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(8, 8, 300, 76);
    ctx.fillStyle = "#fff";
    ctx.font = "13px monospace";
    ctx.textAlign = "left";
    const dpr = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width);
    void dpr;
    if (!snap) {
      ctx.fillText("connecting…", 18, 34);
      return;
    }
    // hp pips
    const hp = me?.hp ?? 0;
    const pips = 10;
    for (let i = 0; i < pips; i++) {
      ctx.fillStyle = i < Math.ceil((hp / PLAYER_HP) * pips) ? "#22c55e" : "#334155";
      ctx.fillRect(18 + i * 22, 20, 18, 10);
    }
    ctx.fillStyle = "#fff";
    ctx.fillText(
      `HP ${Math.max(0, Math.ceil(hp))}  AMMO ${me?.weapon === "fists" ? "—" : me?.ammo ?? "—"}  ${me?.weapon ?? ""}`,
      18, 48,
    );
    ctx.fillText(
      `round ${snap.round}  wins ${me?.wins ?? 0}  ping ${this.net.pingMs}ms`,
      18, 64,
    );
    // wins leaderboard
    ctx.textAlign = "right";
    const board = [...snap.players].sort((x, y) => y.wins - x.wins).map((p) => `${p.name}:${p.wins}`).join("  ");
    ctx.fillText(board, cw - 18, 30);
    ctx.fillText(`tick ${snap.tick}`, cw - 18, 48);
    // roster / feed
    ctx.textAlign = "left";
    ctx.fillStyle = "#93c5fd";
    this.roster.slice(0, 4).forEach((r, i) => {
      ctx.fillText(`${r.bot ? "[bot]" : ""}${r.name}`, 18, ch - 90 + i * 16);
    });
    ctx.fillStyle = "#e5e7eb";
    this.feed.slice(-5).forEach((f, i) => {
      ctx.fillText(f.slice(0, 60), 18, ch - 24 - (this.feed.slice(-5).length - 1 - i) * 16);
    });
    if (!this.started) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(cw / 2 - 220, ch / 2 - 30, 440, 60);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "15px monospace";
      ctx.fillText("waiting for players… (need 2 to start)", cw / 2, ch / 2 + 5);
    }
    if (me && !me.alive) {
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "bold 28px monospace";
      ctx.fillText("ELIMINATED", cw / 2, ch / 2 - 60);
    }
  }
}
