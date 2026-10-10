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
import type { LevelDef, PlayerState, ProjectileState } from "../../shared/types.js";
import type { HudState } from "../ui/hud.js";
import { LEVELS } from "../levels/levels.js";
import { WEAPONS } from "../weapons/defs.js";
import { Sfx } from "../core/audio.js";
import { drawBackground, drawBarrels, drawCrates, drawDrops, drawKillRects, drawSnakes } from "../entities/props.js";
import { drawStick } from "../entities/stick.js";

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
  // Canonical pack is statically bundled (9 arenas) — same source of truth
  // as the host server, so snapshots always resolve to the identical def.
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0] ?? FALLBACK_LEVEL;
}

/** Platform fill colors matching LocalMode's PLAT palette. */
const PLAT_COLORS: Record<string, string> = {
  ice: "#7dd3fc",
  bouncy: "#4ade80",
  conveyor: "#a78bfa",
  blink: "#f472b6",
  lava: "#dc2626",
  mover: "#fb923c",
  rotator: "#c084fc",
};
const WOOD_COLOR = "#8b5a2b";

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number }
interface Beam { x1: number; y1: number; x2: number; y2: number; t: number; color: string }

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
  private sfx = new Sfx();
  private shake = 0;
  private parts: Particle[] = [];
  private beams: Beam[] = [];
  private muzzle = new Map<number, number>();
  private prevProjIds = new Set<number>();
  private banner = "";
  private bannerT = 0;

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
    this.sfx.ensure();
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
    this.net.onClose = () => {
      // Auto-reconnect (once) is handled inside NetClient; note it in feed.
      this.pushFeed("connection lost — retrying…");
    };
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
    // Surface server killfeed / round flow (causes ride in [brackets]).
    for (const e of s.events ?? []) {
      if (e.kind === "kill" || e.kind === "death") {
        if (e.text) this.pushFeed(e.text);
        const victim = s.players.find((p) => p.id === e.b) ?? s.players.find((p) => p.id === e.a);
        if (victim) this.burst(victim.x, victim.y + PH / 2, 18, victim.color);
        try { this.sfx.die(); } catch { /* silent */ }
        this.shake = Math.max(this.shake, 0.3);
      } else if (e.kind === "explode") {
        const at = s.players.find((p) => p.id === e.a);
        const ex = at?.x ?? WORLD_W / 2, ey = at ? at.y + PH / 2 : WORLD_H / 2;
        this.burst(ex, ey, 30, "#fb923c");
        this.burst(ex, ey, 16, "#525252");
        this.shake = Math.max(this.shake, 0.5);
        try { this.sfx.boom(); } catch { /* silent */ }
      } else if (e.kind === "beam") {
        const from = s.players.find((p) => p.id === e.a);
        if (from) {
          const l = Math.hypot(from.aimX, from.aimY);
          const dx = l > 1 ? from.aimX / l : from.facing, dy = l > 1 ? from.aimY / l : 0;
          const color = e.text === "laser" ? "#22d3ee" : "#fef08a";
          this.beams.push({
            x1: from.x, y1: from.y + PH / 2 - 6,
            x2: from.x + dx * 220, y2: from.y + PH / 2 - 6 + dy * 220,
            t: 0.18, color,
          });
          if (this.beams.length > 12) this.beams.shift();
        }
        try { this.sfx.shoot(String(e.text ?? "laser")); } catch { /* silent */ }
      } else if (e.kind === "throw") {
        try { this.sfx.throwWeapon(); } catch { /* silent */ }
      } else if (e.kind === "pickup") {
        try { this.sfx.pickup(); } catch { /* silent */ }
      } else if (e.kind === "roundEnd") {
        this.pushFeed(`🏆 ${e.text} takes the round`);
        this.banner = `🏆 ${e.text} TAKES THE ROUND`;
        this.bannerT = 2;
        try { this.sfx.win(); } catch { /* silent */ }
      } else if (e.kind === "matchEnd") {
        this.pushFeed(`🏆 ${e.text} WINS THE MATCH`);
        this.banner = `🏆 ${e.text} WINS THE MATCH!`;
        this.bannerT = 1e9;
        try { this.sfx.win(); } catch { /* silent */ }
      } else if (e.kind === "round") {
        this.pushFeed(`— ${e.text} —`);
        this.banner = `${e.text} — ROUND ${s.round}`;
        this.bannerT = 2;
      } else if (e.text) {
        this.pushFeed(e.text);
      }
    }
    // Round banner fallback: snapshots carry round/levelId even when the
    // round event arrived before we connected.
    if (s.levelId && s.levelId !== this.level.id) {
      this.level = LEVELS.find((l) => l.id === s.levelId) ?? LEVELS[0] ?? FALLBACK_LEVEL;
    }
    if (this.bannerT <= 0 && this.banner === "" && s.round >= 1) {
      this.banner = `${this.level.name} — ROUND ${s.round}`;
      this.bannerT = 2;
    }
    this.snaps.push({ msg: s, at: performance.now() });
    if (this.snaps.length > 4) this.snaps.shift();
    // Server tick doubles as the input-ack watermark (tick ~= seq).
    this.predictor.reconcile(s.players, this.net.clientId, s.tick);
    // New projectiles => muzzle flash (+ shot sound) on their owner.
    const ids = new Set<number>();
    for (const pr of s.projectiles) {
      ids.add(pr.id);
      if (!this.prevProjIds.has(pr.id)) {
        this.muzzle.set(pr.owner, 0.09);
        try { this.sfx.shoot(String(pr.kind)); } catch { /* silent */ }
      }
    }
    this.prevProjIds = ids;
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

  private burst(x: number, y: number, n: number, color: string): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 320;
      this.parts.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120,
        life: 0.5 + Math.random() * 0.4, max: 0.9,
        color, size: 2 + Math.random() * 4,
      });
    }
    if (this.parts.length > 400) this.parts.splice(0, this.parts.length - 400);
  }

  // ---- frame / render ----

  private frame(t: number): void {
    const dt = Math.min(0.05, (t - this.lastFrame) / 1000 || 0.016);
    this.lastFrame = t;
    this.shake = Math.max(0, this.shake - dt * 1.6);
    if (this.bannerT > 0 && this.bannerT < 1e8) this.bannerT -= dt;
    for (const [id, m] of this.muzzle) {
      const v = m - dt;
      if (v <= 0) this.muzzle.delete(id);
      else this.muzzle.set(id, v);
    }
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const q = this.parts[i];
      q.life -= dt;
      if (q.life <= 0) { this.parts.splice(i, 1); continue; }
      q.vy += GRAVITY * 0.5 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
    for (let i = this.beams.length - 1; i >= 0; i--) {
      this.beams[i].t -= dt;
      if (this.beams[i].t <= 0) this.beams.splice(i, 1);
    }
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
    const snap = this.latest();
    const time = snap?.time ?? performance.now() / 1000;
    ctx.save();
    ctx.clearRect(0, 0, cw, ch);
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake * 16, (Math.random() - 0.5) * this.shake * 16);
    }
    // Themed arena backdrop shared with LocalMode.
    drawBackground(ctx, this.level.theme, time);
    // Arena border.
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, WORLD_W, WORLD_H);

    this.drawPlatforms(ctx, time);
    if (snap) {
      drawKillRects(ctx, this.level.killRects ?? [], time);
      drawDrops(ctx, snap.drops, time);
      drawCrates(ctx, snap.crates);
      drawBarrels(ctx, snap.barrels);
      for (const bm of this.beams) {
        ctx.globalAlpha = Math.max(0, bm.t / 0.18);
        ctx.strokeStyle = bm.color;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(bm.x1, bm.y1);
        ctx.lineTo(bm.x2, bm.y2);
        ctx.stroke();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bm.x1, bm.y1);
        ctx.lineTo(bm.x2, bm.y2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      for (const pr of snap.projectiles) this.drawProjectile(ctx, pr, time);
      const players = this.interpPlayers();
      for (const p of players) {
        const show = p.id === this.net.clientId && this.me ? this.me : p;
        // Server PlayerState is center-x / top-y; drawStick takes left/top.
        drawStick(ctx, { ...show, x: show.x - PW / 2 } as PlayerState, time);
        // HP bar + name tag (drawStick has no labels).
        this.drawTag(ctx, show);
        const mz = this.muzzle.get(show.id) ?? 0;
        if (mz > 0 && show.alive && show.weapon !== "fists") this.drawMuzzle(ctx, show, mz);
      }
      for (const q of this.parts) {
        ctx.globalAlpha = Math.max(0, q.life / q.max);
        ctx.fillStyle = q.color;
        ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
      }
      ctx.globalAlpha = 1;
    }
    // Round banner from snapshot round/levelId (high, like LocalMode).
    if (this.bannerT > 0 && this.banner) {
      const matchWin = /WINS THE MATCH/i.test(this.banner);
      const by = WORLD_H * 0.24;
      ctx.textAlign = "center";
      ctx.font = '64px "Luckiest Guy", system-ui, sans-serif';
      ctx.lineWidth = 8;
      ctx.strokeStyle = "#000";
      ctx.strokeText(this.banner, WORLD_W / 2, by);
      ctx.fillStyle = matchWin ? "#fde047" : "#facc15";
      ctx.fillText(this.banner, WORLD_W / 2, by);
    }
    ctx.restore();
    this.drawHUD(ctx, cw, ch);
  }

  /** Static + mover + rotator platforms in LocalMode style. Snapshots carry
   *  no platform anim state, so movers/rotators are computed client-side
   *  from the level def and snapshot time — identical to the host sim. */
  private drawPlatforms(ctx: CanvasRenderingContext2D, t: number): void {
    for (const pl of this.level.platforms) {
      if (pl.type === "blink") {
        const period = pl.period ?? 3, duty = pl.duty ?? 0.6, phase = pl.phase ?? 0;
        if (!(((t + phase) % period) < period * duty)) continue;
      }
      const x = pl.x * WORLD_W, y = pl.y * WORLD_H;
      const w = pl.w * WORLD_W, h = Math.max(6, pl.h * WORLD_H);
      ctx.fillStyle = (pl.type && PLAT_COLORS[pl.type]) ?? WOOD_COLOR;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect(x, y, w, 4);
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(x, y + h - 3, w, 3);
    }
    for (const m of this.level.movers ?? []) {
      const off = Math.sin((t * Math.PI * 2) / Math.max(0.1, m.period) + (m.phase ?? 0)) * m.range * WORLD_W;
      const x = m.x * WORLD_W + (m.axis === "x" ? off : 0);
      const y = m.y * WORLD_H + (m.axis === "y" ? off : 0);
      const w = m.w * WORLD_W, h = Math.max(6, m.h * WORLD_H);
      ctx.fillStyle = PLAT_COLORS["mover"];
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect(x, y, w, 4);
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(x, y + h - 3, w, 3);
    }
    for (const r of this.level.rotators ?? []) {
      ctx.save();
      ctx.translate(r.cx * WORLD_W, r.cy * WORLD_H);
      ctx.rotate(t * r.angleSpeed);
      ctx.fillStyle = PLAT_COLORS["rotator"];
      ctx.fillRect((-r.w * WORLD_W) / 2, (-r.h * WORLD_H) / 2, r.w * WORLD_W, r.h * WORLD_H);
      ctx.restore();
    }
  }

  /** Projectiles in the LocalMode palette: tracers + per-kind bodies. */
  private drawProjectile(ctx: CanvasRenderingContext2D, pr: ProjectileState, time: number): void {
    const kind = String(pr.kind);
    if (kind === "snake" || kind === "snakeshot") {
      drawSnakes(ctx, [pr], time);
    } else if (kind === "grenade") {
      ctx.fillStyle = pr.life < 0.5 ? "#ef4444" : "#1f2937";
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, 7, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "thrown") {
      ctx.save();
      ctx.translate(pr.x, pr.y);
      ctx.rotate(time * 12);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillRect(-12, -3, 24, 6);
      ctx.restore();
    } else if (kind === "flamethrower") {
      ctx.fillStyle = Math.random() < 0.5 ? "#fb923c" : "#fbbf24";
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, 5 + Math.random() * 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "bouncer") {
      ctx.fillStyle = "#4ade80";
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, 6, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "laser") {
      ctx.fillStyle = "#22d3ee";
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, 5, 0, Math.PI * 2);
      ctx.fill();
    } else if (WEAPONS[pr.kind]?.explosive) {
      ctx.fillStyle = "#fb923c";
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, 6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Hitscan-ish tracer along velocity (LocalMode default).
      ctx.strokeStyle = "#fef08a";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pr.x, pr.y);
      ctx.lineTo(pr.x - pr.vx * 0.018, pr.y - pr.vy * 0.018);
      ctx.stroke();
    }
  }

  /** HP bar + name tag above a player (drawStick draws no labels). Coords are
   *  server space: p.x center, p.y top. */
  private drawTag(ctx: CanvasRenderingContext2D, p: PlayerState): void {
    if (!p.alive) return;
    const cx = p.x, top = p.y;
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

  /** Muzzle-flash star at the gun tip (LocalMode style, minimal). */
  private drawMuzzle(ctx: CanvasRenderingContext2D, p: PlayerState, mz: number): void {
    const l = Math.hypot(p.aimX, p.aimY);
    const ang = l > 1 ? Math.atan2(p.aimY, p.aimX) : p.facing < 0 ? Math.PI : 0;
    const shY = p.y + PH / 2 - 6;
    const tx = p.x + Math.cos(ang) * 44;
    const ty = shY + Math.sin(ang) * 44;
    const r = 8 + Math.random() * 6;
    ctx.save();
    ctx.globalAlpha = Math.max(0, mz / 0.09);
    ctx.fillStyle = "#fef08a";
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = ang + (i / 6) * Math.PI * 2;
      const rr = i % 2 === 0 ? r : r * 0.45;
      const px = tx + Math.cos(a) * rr;
      const py = ty + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fff7ed";
    ctx.beginPath();
    ctx.arc(tx, ty, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** DOM HUD state for main.ts: roster + wins + ping. */
  getHudState(): HudState {
    const snap = this.latest();
    return {
      players: (snap?.players ?? []).map((p) => ({
        name: p.id === this.net.clientId ? `${p.name} (you)` : p.name,
        color: p.color,
        wins: p.wins,
        alive: p.alive,
        ammo: p.weapon === "fists" ? -1 : p.ammo,
        weapon: p.weapon,
      })),
      round: snap?.round ?? 1,
      levelName: `${this.level.name} · ONLINE`,
      ping: this.net.pingMs,
      killfeed: [...this.feed],
    };
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
    ctx.fillText(`tick ${snap.tick} · unacked ${this.predictor.unackedCount}`, cw - 18, 48);
    // roster (name + wins) / feed
    ctx.textAlign = "left";
    ctx.fillStyle = "#93c5fd";
    const winsById = new Map(snap.players.map((p) => [p.id, p.wins]));
    this.roster.slice(0, 4).forEach((r, i) => {
      const w = winsById.get(r.id) ?? 0;
      ctx.fillText(`${r.bot ? "[bot]" : ""}${r.name} ★${w}`, 18, ch - 90 + i * 16);
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
