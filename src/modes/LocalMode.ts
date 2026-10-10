// LocalMode: self-contained local arena game. No server import.
// Uses canonical LEVELS (9 arenas) + WEAPONS (18) from src data.
// Inline arcade physics kept, but honors all level materials/hazards:
// ice friction, bouncy, conveyor, blink, lava/spikes/laser kills,
// movers/rotators, crates/barrels. Full weapon behaviors: grenade arc+
// explosion, RPG rocket, bouncer bounce, minigun jetpack recoil, laser/
// sniper beams, sword/spear melee arcs, shotgun pellets, flamethrower burn.
// Mechanics: punch-boost, recoil-fly, throw (F, 55 dmg, re-pickup reloads),
// block (RMB, -65% damage).
import { GRAVITY, MOVE_SPEED, JUMP_SPEED, MAX_FALL, WORLD_W as W, WORLD_H as H, PLAYER_COLORS, PLAYER_NAMES, PLAYER_HP, WIN_SCORE_DEFAULT, BOSS_HP, BOSS_SCALE, BOSS_SPEED_MULT, BOSS_DAMAGE_TAKEN_MULT, BOSS_KNOCKBACK_TAKEN_MULT, BOSS_MELEE_MULT, BOSS_ROUND_EVERY, BOSS_STOMP_RADIUS, BOSS_STOMP_DAMAGE, BOSS_STOMP_KNOCKBACK, BOSS_STOMP_COOLDOWN, BOSS_SURVIVE_TIME } from '../../shared/constants.js';
import type { DroppedGun, LevelDef, PlayerState, WeaponId } from '../../shared/types.js';
import type { HudState } from '../ui/hud.js';
import { LEVELS } from '../levels/levels.js';
import { WEAPONS } from '../weapons/defs.js';
import { Sfx } from '../core/audio.js';
import { drawBackground, drawSnakes, drawFrostOverlay, drawGlueOverlay, drawIceGlue } from '../entities/props.js';
import { drawStick } from '../entities/stick.js';

// All 18 minus fists, plus rare snake guns (weighted rare in spawnDrop).
const GUN_POOL: WeaponId[] = ['pistol', 'revolver', 'deagle', 'uzi', 'ak47', 'm16', 'sniper', 'shotgun', 'sawedoff', 'bouncer', 'minigun', 'grenade', 'rpg', 'flamethrower', 'sword', 'spear', 'laser', 'ice', 'glue', 'snake', 'snakeshot'];
const RARE_SET: ReadonlySet<WeaponId> = new Set<WeaponId>(['snake', 'snakeshot']);
const COMMON_POOL: WeaponId[] = GUN_POOL.filter((w) => !RARE_SET.has(w));
const RARE_POOL: WeaponId[] = GUN_POOL.filter((w) => RARE_SET.has(w));

interface Tune { fuse?: number; grav?: number; life?: number; bounces?: number }
const TUNE: Record<WeaponId, Tune> = {
  fists: {}, pistol: { life: 1.6 }, revolver: { life: 1.6 }, deagle: { life: 1.6 },
  uzi: { life: 1.4 }, ak47: { life: 1.5 }, m16: { life: 1.5 },
  sniper: {}, shotgun: { life: 1.1 }, sawedoff: { life: 1.0 },
  bouncer: { life: 2.5 }, minigun: { life: 1.3 },
  grenade: { fuse: 1.6, grav: 1, life: 3.2 },
  rpg: { grav: 0.12, life: 3 },
  flamethrower: { life: 0.32, grav: 0 },
  sword: {}, spear: {}, laser: {},
  snake: { life: 6, grav: 0 },
  snakeshot: { life: 6, grav: 0 },
  ice: { life: 1.2, grav: 0.5 },
  glue: { life: 1.5, grav: 0.375 },
};

const THROW_DAMAGE = 55;
const BLOCK_FACTOR = 0.35; // block reduces damage by 65%
const BURN_DPS = 5;
const BURN_TIME = 1.2;

const isInfinite = (w: WeaponId): boolean => WEAPONS[w].magSize >= 9000;
const fullAmmo = (w: WeaponId): number => (isInfinite(w) ? -1 : WEAPONS[w].magSize);

interface R { id: number; name: string; color: string; x: number; y: number; vx: number; vy: number; hp: number; alive: boolean; weapon: WeaponId; ammo: number; cd: number; face: 1 | -1; ax: number; ay: number; onGround: boolean; wins: number; bot: boolean; walk: number; flash: number; swing: number; block: boolean; dropT: number; fireHeld: boolean; prevFire: boolean; ground: string; st: number; burnT: number; invuln: number; squash: number; deadT: number; muzzle: number; boss: boolean; maxHp: number; stompCd: number; frostT: number; glueT: number; slide: boolean; wallD: 1 | -1 | 0; wallLock: number }
interface Proj { x: number; y: number; vx: number; vy: number; life: number; owner: number; kind: WeaponId | 'thrown'; dmg: number; fuse: number; explosive: number; grav: number; bounces: number; thrownW?: WeaponId; ammo?: number }
interface Solid { x: number; y: number; w: number; h: number; type: string; belt?: number; mi?: number; ri?: number }

// Wall-slide + wall-jump tuning (mirrors src/physics/world.ts).
const WALL_SLIDE_CAP = 180;
const WALL_JUMP_VX = 380;
const WALL_JUMP_VY_SCALE = 0.92;
const WALL_LOCK = 0.18;
const ROTATOR_CARRY = 55;
interface Part { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number }
interface Beam { x1: number; y1: number; x2: number; y2: number; t: number; color: string }
const MAPS = [ // P1: WASD + mouse. P2: arrows + auto-aim.
  { l: 'KeyA', r: 'KeyD', j: 'KeyW', d: 'KeyS', f: 'KeyF', b: 'Slash', fire: 'KeyG', aim: 'mouse' },
  { l: 'ArrowLeft', r: 'ArrowRight', j: 'ArrowUp', d: 'ArrowDown', f: 'Comma', b: 'Period', fire: 'Slash', aim: 'auto' },
];

const PLAT: Record<string, string> = { ice: '#7dd3fc', bouncy: '#4ade80', conveyor: '#a78bfa', mover: '#fb923c', rotator: '#c084fc', blink: '#f472b6' };
const THEME_BG: Record<string, [string, string]> = {
  woods: ['#14532d', '#052e16'], desert: ['#92400e', '#431407'], factory: ['#27272a', '#09090b'],
  windmill: ['#1e3a8a', '#172554'], winter: ['#082f49', '#0c4a6e'], lava: ['#1c0a0a', '#7c2d12'],
  laser: ['#090918', '#312e81'], western: ['#78350f', '#292524'], halloween: ['#2e1065', '#0c0a09'],
};

export class LocalMode {
  onQuit: (() => void) | null = null;
  private ctx: CanvasRenderingContext2D;
  private sfx = new Sfx();
  private raf = 0; private running = false; private last = 0;
  private keys = new Set<string>();
  private mouse = { x: W / 2, y: H / 2, fire: false, block: false };
  private players: R[] = []; private projs: Proj[] = []; private drops: DroppedGun[] = [];
  private crates: { x: number; y: number; w: number; h: number; vy: number }[] = [];
  private barrels: { x: number; y: number; hp: number }[] = [];
  private fuses: { x: number; y: number; t: number; r: number; dmg: number; owner: number }[] = [];
  private parts: Part[] = []; private feed: string[] = []; private beams: Beam[] = [];
  private levelIdx = 0; private time = 0; private round = 1;
  private rotation: LevelDef[] = LEVELS; private hasCustom = false;
  private banner = ''; private bannerT = 0; private roundLock = 0;
  private matchOver = false; private frozen = false; private paused = false;
  private showHelp = false;
  private rematchBtn: HTMLButtonElement | null = null;
  private shake = 0; private dropT = 2; private dropRespawn: number[] = []; private off: (() => void)[] = [];
  private deco: { x: number; y: number; s: number }[] = [];
  private bossId: number | null = null;
  private bossTime = 0;
  private lastPickup = new Map<number, number>();
  private get winScore(): number { return this.opts.winsTarget ?? WIN_SCORE_DEFAULT; }

  constructor(private canvas: HTMLCanvasElement, private opts: { humans: number; bots: number; winsTarget?: number; customLevel?: LevelDef }) {
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('no 2d context'); this.ctx = ctx; let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; this.deco = Array.from({ length: 70 }, () => ({ x: rnd() * W, y: rnd() * H * 0.7, s: 1 + rnd() * 3 }));
    const total = Math.min(4, Math.max(1, opts.humans + opts.bots));
    const nH = Math.min(opts.humans, 2);
    for (let i = 0; i < total; i++) this.players.push({ id: i, name: i === 0 && opts.humans > 0 ? 'YOU' : PLAYER_NAMES[i], color: PLAYER_COLORS[i], x: 0, y: 0, vx: 0, vy: 0, hp: PLAYER_HP, alive: true, weapon: 'fists', ammo: -1, cd: 0, face: i % 2 === 0 ? 1 : -1, ax: 0, ay: 0, onGround: false, wins: 0, bot: i >= nH, walk: 0, flash: 0, swing: 0, block: false, dropT: 0, fireHeld: false, prevFire: false, ground: '', st: 0, burnT: 0, invuln: 0, squash: 0, deadT: 0, muzzle: 0, boss: false, maxHp: PLAYER_HP, stompCd: 0, frostT: 0, glueT: 0, slide: false, wallD: 0, wallLock: 0 });
    // Custom editor level (trusted editor output) goes first in the rotation.
    if (opts.customLevel) {
      this.rotation = [{ ...opts.customLevel, id: 'custom' }, ...LEVELS];
      this.hasCustom = true;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const kd = (e: KeyboardEvent) => {
      this.sfx.ensure();
      if (e.code === 'Escape') this.paused = !this.paused;
      else if (e.code === 'KeyR') this.resetMatch();
      else if (e.code === 'KeyQ') this.onQuit?.();
      else if (e.code === 'KeyH') this.showHelp = !this.showHelp;
      else { this.keys.add(e.code); if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault(); }
    };
    const ku = (e: KeyboardEvent) => this.keys.delete(e.code);
    const mm = (e: MouseEvent) => { const r = this.canvas.getBoundingClientRect(); this.mouse.x = ((e.clientX - r.left) / r.width) * W; this.mouse.y = ((e.clientY - r.top) / r.height) * H; };
    const md = (e: MouseEvent) => { this.sfx.ensure(); if (e.button === 0) this.mouse.fire = true; if (e.button === 2) this.mouse.block = true; };
    const mu = (e: MouseEvent) => { if (e.button === 0) this.mouse.fire = false; if (e.button === 2) this.mouse.block = false; };
    const cx = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('mousemove', mm);
    window.addEventListener('mousedown', md); window.addEventListener('mouseup', mu); this.canvas.addEventListener('contextmenu', cx);
    this.off = [() => window.removeEventListener('keydown', kd), () => window.removeEventListener('keyup', ku), () => window.removeEventListener('mousemove', mm), () => window.removeEventListener('mousedown', md), () => window.removeEventListener('mouseup', mu), () => this.canvas.removeEventListener('contextmenu', cx)];
    this.levelIdx = 0; this.round = 1; this.spawnAll();
    this.banner = this.bossBanner() ?? `${this.levelLabel()} — ROUND 1`; this.bannerT = 2; this.last = performance.now();
    const loop = (t: number) => { if (!this.running) return; this.update(Math.min(0.033, (t - this.last) / 1000)); this.render(); this.last = t; this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void { this.running = false; cancelAnimationFrame(this.raf); this.off.forEach((f) => f()); this.off = []; this.clearRematchBtn(); }

  getHudState(): HudState {
    return { players: this.players.map((p) => ({ name: p.name, color: p.color, wins: p.wins, alive: p.alive, ammo: p.ammo, weapon: p.weapon })), round: this.round, levelName: this.levelLabel(), msg: this.bannerT > 0 ? this.banner : undefined, killfeed: [...this.feed] };
  }

  private level(): LevelDef { return this.rotation[this.levelIdx]; }

  /** Display name for banners/HUD: the custom slot always shows as CUSTOM. */
  private levelLabel(): string {
    return this.hasCustom && this.levelIdx === 0 ? 'CUSTOM' : this.level().name;
  }

  private resetMatch(): void {
    this.players.forEach((p) => (p.wins = 0)); this.round = 1; this.levelIdx = 0; this.matchOver = false; this.frozen = false; this.paused = false;
    this.spawnAll(); this.banner = this.bossBanner() ?? `${this.levelLabel()} — ROUND 1`; this.bannerT = 2;
    this.clearRematchBtn();
  }

  private clearRematchBtn(): void {
    try {
      this.rematchBtn?.remove();
    } catch {
      /* ignore */
    }
    this.rematchBtn = null;
  }

  /** DOM rematch button shown on match win (canvas can't be clicked otherwise). */
  private syncRematchBtn(): void {
    const want = this.matchOver && this.frozen && this.running;
    if (!want) {
      if (this.rematchBtn) this.clearRematchBtn();
      return;
    }
    if (this.rematchBtn) return;
    try {
      const host = this.canvas.parentElement ?? document.body;
      const b = document.createElement('button');
      b.textContent = 'REMATCH (R)';
      b.className = 'font-display tracking-wider px-6 py-3 rounded-lg border-b-4 bg-yellow-500 hover:bg-yellow-400 border-yellow-700 text-black text-xl';
      b.style.cssText = 'position:absolute;left:50%;top:62%;transform:translate(-50%,0);z-index:40;cursor:pointer;';
      b.onclick = (e) => {
        e.stopPropagation();
        this.sfx.ensure();
        this.resetMatch();
      };
      host.appendChild(b);
      this.rematchBtn = b;
    } catch {
      /* headless — ignore */
    }
  }

  private isBossRound(): boolean {
    return this.round % BOSS_ROUND_EVERY === 0;
  }

  private spawnAll(): void {
    const lv = this.level();
    // Static platform boxes (px) so a spawn inside a solid gets lifted on top.
    // Full-world camera (no scroll/zoom) always covers every spawn point.
    const plats = lv.platforms.map((p) => ({ x: p.x * W, y: p.y * H, w: p.w * W, h: p.h * H }));
    // Boss round setup: random player becomes the juggernaut.
    this.bossId = null;
    this.bossTime = 0;
    for (const p of this.players) {
      p.boss = false;
      p.maxHp = PLAYER_HP;
      p.stompCd = 0;
    }
    if (this.isBossRound() && this.players.length >= 2) {
      const pick = this.players[(Math.random() * this.players.length) | 0];
      pick.boss = true;
      pick.maxHp = BOSS_HP;
      this.bossId = pick.id;
    }
    this.players.forEach((p, i) => {
      const s = lv.spawns[i % lv.spawns.length];
      p.x = Math.max(24, Math.min(W - 24, s[0] * W));
      p.y = s[1] * H;
      for (const pl of plats) {
        const insideX = p.x + 11 > pl.x && p.x - 11 < pl.x + pl.w;
        const insideY = p.y > pl.y && p.y - 68 < pl.y + pl.h;
        if (insideX && insideY) p.y = pl.y; // stand on top instead of stuck inside
      }
      p.vx = 0; p.vy = 0; p.hp = p.boss ? BOSS_HP : PLAYER_HP; p.alive = true; p.weapon = 'fists'; p.ammo = -1; p.cd = 0; p.flash = 0; p.block = false; p.burnT = 0; p.invuln = 1.0; p.squash = 0; p.deadT = 0; p.muzzle = 0; p.onGround = false; p.ground = ''; p.stompCd = 0; p.frostT = 0; p.glueT = 0; p.slide = false; p.wallD = 0; p.wallLock = 0;
    });
    this.projs = []; this.fuses = []; this.drops = []; this.beams = []; this.dropRespawn = [];
    this.crates = (lv.crates ?? []).map((c) => ({ x: c.x * W, y: c.y * H, w: c.w * W, h: c.h * H, vy: 0 })); this.barrels = (lv.barrels ?? []).map((b) => ({ x: b.x * W, y: b.y * H, hp: 30 }));
    lv.weaponDrops.slice(0, 2).forEach((d) => this.spawnDrop(d[0] * W));
    if (this.bossId !== null) {
      const boss = this.players.find((p) => p.id === this.bossId);
      if (boss) this.feed.push(`BOSS: ${boss.name} is the BOSS!`);
      if (this.feed.length > 8) this.feed.shift();
    }
  }

  private bossBanner(): string | null {
    if (this.bossId === null) return null;
    const boss = this.players.find((p) => p.id === this.bossId);
    return boss ? `BOSS: ${boss.name} is the BOSS!` : null;
  }

  private spawnDrop(x: number): void {
    // Drops fall from the sky (original Stick Fight style), not at floor spots.
    // Snakes are rare: ~7% of drops.
    const w = Math.random() < 0.07
      ? RARE_POOL[(Math.random() * RARE_POOL.length) | 0]
      : COMMON_POOL[(Math.random() * COMMON_POOL.length) | 0];
    this.drops.push({ x, y: H * 0.02, vx: (Math.random() - 0.5) * 120, vy: 0, weapon: w, ammo: fullAmmo(w) });
  }

  /** Coyote jump off landed gun drops / crate tops (stand-on-gun jumps). */
  private onProp(p: R): boolean {
    for (const g of this.drops) {
      if (g.vy === 0 && Math.abs(g.x - p.x) < 26 && Math.abs(g.y - p.y) <= 8) return true;
    }
    for (const c of this.crates) {
      if (p.x + 11 > c.x && p.x - 11 < c.x + c.w && Math.abs(p.y - c.y) <= 8) return true;
    }
    return false;
  }

  private inLava(x: number, y: number): boolean {
    const lv = this.level();
    for (const k of lv.killRects ?? []) {
      if (k.kind !== 'lava') continue;
      if (x > k.x * W && x < (k.x + k.w) * W && y > k.y * H && y < (k.y + k.h) * H) return true;
    }
    for (const s of this.solids()) {
      if (s.type !== 'lava') continue;
      if (x > s.x && x < s.x + s.w && y > s.y && y < s.y + s.h) return true;
    }
    return false;
  }

  private rotatorBox(cx: number, cy: number, w: number, h: number, angleSpeed: number): Solid {
    const a = this.time * angleSpeed;
    const pw = w * W, ph = h * H;
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const bw = pw * c + ph * s, bh = pw * s + ph * c;
    return { x: cx * W - bw / 2, y: cy * H - bh / 2, w: bw, h: bh, type: 'rotator' };
  }

  private solids(): Solid[] {
    const lv = this.level(); const out: Solid[] = [];
    for (const p of lv.platforms) {
      if (p.type === 'blink') { const per = p.period ?? 3; if ((this.time + (p.phase ?? 0)) % per > (p.duty ?? 0.6) * per) continue; }
      out.push({ x: p.x * W, y: p.y * H, w: p.w * W, h: p.h * H, type: p.type ?? 'static', belt: p.beltSpeed });
    }
    for (const m of lv.movers ?? []) { const o = Math.sin((2 * Math.PI * (this.time + (m.phase ?? 0))) / m.period) * m.range * (m.axis === 'x' ? W : H); out.push({ x: m.x * W + (m.axis === 'x' ? o : 0), y: m.y * H + (m.axis === 'y' ? o : 0), w: m.w * W, h: m.h * H, type: 'mover', mi: (lv.movers ?? []).indexOf(m) }); }
    for (const r of lv.rotators ?? []) { const b = this.rotatorBox(r.cx, r.cy, r.w, r.h, r.angleSpeed); b.ri = (lv.rotators ?? []).indexOf(r); out.push(b); }
    for (const c of this.crates) out.push({ x: c.x, y: c.y, w: c.w, h: c.h, type: 'crate' });
    return out;
  }

  /** Frame delta of mover #mi (pixel space), computed as pos(t) - pos(t-dt). */
  private moverDelta(mi: number, dt: number): { dx: number; dy: number } {
    const m = (this.level().movers ?? [])[mi];
    if (!m || dt <= 0) return { dx: 0, dy: 0 };
    const f = (t: number) => Math.sin((2 * Math.PI * (t + (m.phase ?? 0))) / m.period) * m.range * (m.axis === 'x' ? W : H);
    const d = f(this.time) - f(this.time - dt);
    return m.axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d };
  }

  /** Side-wall probe for wall-slide: solid adjacent on input side? */
  private touchingWall(p: R, solids: Solid[], dir: number): 1 | -1 | 0 {
    if (dir === 0) return 0;
    const px = p.x + dir * 14;
    const ys = [p.y - 60, p.y - 34, p.y - 6];
    for (const s of solids) {
      for (const y of ys) {
        if (px > s.x && px < s.x + s.w && y > s.y && y < s.y + s.h) return dir > 0 ? 1 : -1;
      }
    }
    return 0;
  }

  /** Player-player soft collision: overlap splits apart horizontally, no damage. */
  private separatePlayers(): void {
    const solids = this.solids();
    const inside = (x: number, y: number): boolean => {
      for (const s of solids) {
        if (this.collideBox(x, y, s)) return true;
      }
      return false;
    };
    const ps = this.players.filter((p) => p.alive);
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        const overlapY = Math.min(a.y, b.y) - Math.max(a.y - 68, b.y - 68);
        if (overlapY <= 0) continue;
        const dx = b.x - a.x;
        const overlapX = 24 - Math.abs(dx);
        if (overlapX <= 0) continue;
        const push = overlapX / 2 + 0.5;
        const s = dx >= 0 ? 1 : -1;
        // Wall-aware: never shove a victim through a wall into a sealed area.
        const nax = Math.max(12, Math.min(W - 12, a.x - s * push));
        const nbx = Math.max(12, Math.min(W - 12, b.x + s * push));
        if (!inside(nax, a.y)) a.x = nax;
        else {
          const half = Math.max(12, Math.min(W - 12, a.x - s * (push / 2)));
          if (!inside(half, a.y)) a.x = half;
        }
        if (!inside(nbx, b.y)) b.x = nbx;
        else {
          const half = Math.max(12, Math.min(W - 12, b.x + s * (push / 2)));
          if (!inside(half, b.y)) b.x = half;
        }
      }
    }
    // Final sweep: any residual penetration (knockback / carry) ejects via
    // minimum penetration so sealed areas stay sealed.
    for (const p of ps) this.depenetrate(p, solids);
  }

  /** Eject a body left inside a solid (knockback / soft-push / carry). */
  private depenetrate(p: R, solids: Solid[]): void {
    for (let iter = 0; iter < 4; iter++) {
      let hit: Solid | null = null;
      for (const s of solids) {
        if (this.collideBox(p.x, p.y, s)) { hit = s; break; }
      }
      if (!hit) break;
      const s = hit;
      const penL = p.x + 12 - s.x;
      const penR = s.x + s.w - (p.x - 12);
      const penT = p.y - s.y;
      const penB = s.y + s.h - (p.y - 68);
      const penX = Math.min(penL, penR);
      const penY = Math.min(penT, penB);
      if (penX < penY) {
        p.x = penL < penR ? s.x - 12 : s.x + s.w + 12;
        p.vx = 0;
        p.x = Math.max(12, Math.min(W - 12, p.x));
      } else {
        // One-way decks: never pull a rising body down through a platform.
        if (penT < penB) {
          if (p.vy < 0) break;
          p.y = s.y; p.vy = 0; p.onGround = true; p.ground = s.type;
        } else {
          p.y = s.y + s.h + 68; p.vy = 0;
        }
      }
    }
  }

  /** True when a wall sits between two points (melee / blast line-of-sight). */
  private segmentBlocked(x1: number, y1: number, x2: number, y2: number, solids: Solid[]): boolean {
    const dx = x2 - x1, dy = y2 - y1;
    for (const s of solids) {
      if (x1 > s.x && x1 < s.x + s.w && y1 > s.y && y1 < s.y + s.h) continue;
      if (x2 > s.x && x2 < s.x + s.w && y2 > s.y && y2 < s.y + s.h) continue;
      let tmin = 0, tmax = 1;
      if (Math.abs(dx) < 1e-9) {
        if (x1 < s.x || x1 > s.x + s.w) continue;
      } else {
        let t1 = (s.x - x1) / dx, t2 = (s.x + s.w - x1) / dx;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) continue;
      }
      if (Math.abs(dy) < 1e-9) {
        if (y1 < s.y || y1 > s.y + s.h) continue;
      } else {
        let t1 = (s.y - y1) / dy, t2 = (s.y + s.h - y1) / dy;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) continue;
      }
      const tHit = Math.max(tmin, 0);
      if (tmax > 0 && tmin < 1 && tHit > 0.001 && tHit < 0.999) return true;
    }
    return false;
  }

  private burst(x: number, y: number, n: number, color: string, spd = 380): void {
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, v = spd * (0.3 + Math.random() * 0.7); this.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 150, life: 0.5 + Math.random() * 0.4, max: 0.9, color, size: 2 + Math.random() * 3 }); }
  }

  private hurt(v: R, dmg: number, kx: number, ky: number, owner: number, cause: string, headshot = false): void {
    if (!v.alive || this.frozen) return;
    // Headshot x2: hit within top 25% of victim AABB (feet-based y, 68px tall).
    if (headshot) dmg *= 2;
    if (v.boss) dmg *= BOSS_DAMAGE_TAKEN_MULT;
    // Spawn invuln (1s) absorbs combat damage but not falls/lava.
    if (v.invuln > 0 && cause !== 'fell' && cause !== 'lava' && dmg < 900) return;
    const wasBlock = v.block;
    if (wasBlock) { dmg *= BLOCK_FACTOR; kx *= 0.3; ky *= 0.3; }
    if (v.boss) { kx *= BOSS_KNOCKBACK_TAKEN_MULT; ky *= BOSS_KNOCKBACK_TAKEN_MULT; }
    v.hp -= dmg; v.flash = 0.18; v.vx += kx; v.vy += ky;
    // Hit feedback: particles + shake + sound (clang when blocked).
    this.burst(v.x, v.y - 40, wasBlock ? 6 : 8, wasBlock ? '#93c5fd' : '#f87171', 300);
    this.shake = Math.max(this.shake, wasBlock ? 0.12 : 0.18);
    if (v.hp > 0) {
      if (wasBlock) this.sfx.block();
      else this.sfx.hit();
      return;
    }
    v.alive = false; v.hp = 0; v.deadT = 0; v.frostT = 0; v.glueT = 0;
    this.sfx.die();
    if (v.weapon !== 'fists') this.drops.push({ x: v.x, y: v.y - 40, vx: (Math.random() - 0.5) * 200, vy: -200, weapon: v.weapon, ammo: v.ammo });
    this.burst(v.x, v.y - 34, 22, v.color); this.shake = Math.max(this.shake, 0.35);
    const killer = this.players[owner];
    this.feed.push(killer && owner !== v.id ? `${killer.name} ▸ ${v.name} [${cause}]` : `${v.name} died [${cause}]`);
    if (this.feed.length > 8) this.feed.shift();
    const alive = this.players.filter((p) => p.alive);
    if (alive.length > 1 || this.roundLock > 0) return;
    this.roundLock = 1.5;
    if (alive.length === 1) { const w = alive[0]; w.wins++; this.matchOver = w.wins >= this.winScore; this.banner = this.matchOver ? `${w.name} WINS THE MATCH!  [R] REMATCH · [Q] MENU` : `${w.name} SCORES  (${w.wins}/${this.winScore})`; this.sfx.win(); }
    else { this.banner = 'DRAW!'; this.sfx.win(); }
    this.bannerT = this.matchOver ? 1e9 : this.roundLock;
  }

  private explode(x: number, y: number, r: number, dmg: number, owner: number): void {
    this.burst(x, y, 30, '#fb923c'); this.burst(x, y, 16, '#525252'); this.shake = Math.max(this.shake, 0.5);
    this.sfx.boom();
    const solids = this.solids();
    for (const p of this.players) {
      const dx = p.x - x, dy = (p.y - 34) - y, d = Math.hypot(dx, dy);
      if (p.alive && d < r) {
        // Blast is blocked by walls: no knocking victims through a pillar.
        if (this.segmentBlocked(x, y, p.x, p.y - 34, solids)) continue;
        const f = 1 - (d / r) * 0.6; const dealt = p.id === owner ? Math.min(dmg * f, 50) : dmg * f; this.hurt(p, dealt, (dx / (d || 1)) * 650 * f, -380 * f, owner, 'explosion');
      }
    }
    for (const b of this.barrels) if (b.hp > 0 && Math.hypot(b.x - x, b.y - y) < r) { b.hp = 0; this.fuses.push({ x: b.x, y: b.y, t: 0.12, r: 150, dmg: 55, owner }); }
  }

  private doStomp(p: R): void {
    const cx = p.x, cy = p.y - 34;
    this.burst(cx, p.y - 6, 18, '#fbbf24', 420);
    this.burst(cx, cy, 10, '#78716c', 300);
    this.shake = Math.max(this.shake, 0.4);
    this.sfx.boom();
    for (const e of this.players) {
      if (e === p || !e.alive) continue;
      const dx = e.x - cx, dy = (e.y - 34) - cy;
      const d = Math.hypot(dx, dy);
      if (d > BOSS_STOMP_RADIUS + 20) continue;
      const a = Math.atan2(dy, dx);
      this.hurt(e, BOSS_STOMP_DAMAGE, Math.cos(a) * BOSS_STOMP_KNOCKBACK, Math.sin(a) * BOSS_STOMP_KNOCKBACK * 0.5 - 200, p.id, 'stomp');
    }
  }

  private nearestEnemy(b: R): R | null {
    let best: R | null = null, bd = 1e9;
    for (const p of this.players) { if (p === b || !p.alive) continue; const d = Math.abs(p.x - b.x) + Math.abs(p.y - b.y); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  /** Snake homing: steer velocity toward nearest living enemy (not owner), ~3 rad/s. */
  private steerSnake(pr: Proj, dt: number): void {
    let best: R | null = null, bd = Infinity;
    for (const p of this.players) {
      if (!p.alive || p.id === pr.owner) continue;
      const d = Math.hypot(p.x - pr.x, (p.y - 34) - pr.y);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    const speed = Math.hypot(pr.vx, pr.vy) || 260;
    const cur = Math.atan2(pr.vy, pr.vx);
    const want = Math.atan2((best.y - 34) - pr.y, best.x - pr.x);
    let da = want - cur;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const maxTurn = 3 * dt;
    const na = cur + Math.max(-maxTurn, Math.min(maxTurn, da));
    pr.vx = Math.cos(na) * speed;
    pr.vy = Math.sin(na) * speed;
  }

  private botInput(b: R, dt: number): { l: boolean; r: boolean; j: boolean; fire: boolean; blk: boolean; d: boolean } {
    const o = { l: false, r: false, j: false, fire: false, blk: false, d: false };
    const foe = this.nearestEnemy(b);
    if (!foe) return o;
    if (b.boss) {
      // Juggernaut: chase the nearest foe, punch up close, stomp when clustered.
      const dx = foe.x - b.x;
      o.l = dx < -8; o.r = dx > 8;
      if (foe.y < b.y - 70 && b.onGround) o.j = true;
      b.ax = foe.x; b.ay = foe.y - 34;
      const dist = Math.hypot(foe.x - b.x, foe.y - b.y);
      if (dist < 90) o.fire = true;
      if (dist < BOSS_STOMP_RADIUS + 10 && b.stompCd <= 0) { o.d = true; o.fire = true; }
    } else if (b.weapon === 'fists') {
      let tx = foe.x, ty = foe.y, bd = 1e9;
      for (const g of this.drops) { const dd = Math.abs(g.x - b.x) + Math.abs(g.y - b.y); if (dd < bd) { bd = dd; tx = g.x; ty = g.y; } }
      o.l = tx < b.x - 8; o.r = tx > b.x + 8;
      if (ty < b.y - 70 && b.onGround) o.j = true;
    } else {
      const dx = foe.x - b.x;
      if (Math.abs(dx) > 260) { o.l = dx < 0; o.r = dx > 0; }
      else if (Math.random() < 0.008) { o.l = dx > 0; o.r = dx < 0; }
      if (foe.y < b.y - 90 && b.onGround && Math.random() < 0.06) o.j = true;
      b.ax = foe.x; b.ay = foe.y - 34;
      if (Math.abs(foe.y - 34 - (b.y - 40)) < 90 && Math.random() < 0.09) o.fire = true;
      if (Math.random() < 0.004) o.blk = true;
    }
    b.st += dt;
    if ((o.l || o.r) && Math.abs(b.vx) < 30 && b.onGround && b.st > 0.4) { o.j = true; b.st = 0; }
    else if (Math.abs(b.vx) > 60) b.st = 0;
    if (Math.random() < 0.002) o.j = true;
    // Bots wall-jump when sliding (slide flag is refreshed each tick in update).
    if (b.slide && b.wallLock <= 0) o.j = true;
    return o;
  }

  private rayWallDist(sx: number, sy: number, dx: number, dy: number, maxD: number): number {
    let best = maxD;
    for (const s of this.solids()) {
      // Slab test for ray vs AABB.
      let tmin = 0, tmax = best, ok = true;
      if (Math.abs(dx) < 1e-9) { if (sx < s.x || sx > s.x + s.w) ok = false; }
      else { let t1 = (s.x - sx) / dx, t2 = (s.x + s.w - sx) / dx; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) ok = false; }
      if (!ok) continue;
      if (Math.abs(dy) < 1e-9) { if (sy < s.y || sy > s.y + s.h) continue; }
      else { let t1 = (s.y - sy) / dy, t2 = (s.y + s.h - sy) / dy; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) continue; }
      if (tmin > 0 && tmin < best) best = tmin;
    }
    return best;
  }

  private fireBeam(p: R, aim: number): void {
    const w = WEAPONS[p.weapon];
    const sx = p.x, sy = p.y - 46;
    const dx = Math.cos(aim), dy = Math.sin(aim);
    const maxD = 2200;
    // Laser burns through walls (original behavior); sniper is stopped by cover.
    const wallD = p.weapon === 'laser' ? maxD : this.rayWallDist(sx, sy, dx, dy, maxD);
    const laserHits: { e: R; t: number }[] = [];
    let best: R | null = null, bestD = wallD, bestT = 0;
    for (const e of this.players) {
      if (e === p || !e.alive) continue;
      const rx = e.x - sx, ry = (e.y - 34) - sy;
      const t = rx * dx + ry * dy;
      if (t < 0 || t > bestD) continue;
      const perp = Math.abs(rx * dy - ry * dx);
      if (perp >= 20) continue;
      if (p.weapon === 'laser') laserHits.push({ e, t });
      else if (t < bestD) { best = e; bestD = t; bestT = t; }
    }
    const ex = sx + dx * wallD, ey = sy + dy * wallD;
    const color = p.weapon === 'laser' ? '#22d3ee' : '#fef08a';
    this.beams.push({ x1: sx, y1: sy, x2: ex, y2: ey, t: 0.18, color });
    this.burst(ex, ey, 8, color, 260);
    // Headshot x2: beam strike within top 25% of victim (head = top 17px of 68px body).
    if (best) this.hurt(best, w.damage, dx * w.knockback, -220, p.id, p.weapon, sy + dy * bestT < best.y - 51);
    else for (const h of laserHits) this.hurt(h.e, w.damage, dx * w.knockback, -220, p.id, p.weapon, sy + dy * h.t < h.e.y - 51);
    if (!isInfinite(p.weapon) && p.ammo > 0) p.ammo--;
    if (!isInfinite(p.weapon) && p.ammo === 0) { p.weapon = 'fists'; p.ammo = -1; }
    p.cd = w.fireInterval;
    // Recoil-fly: firing down lifts the shooter (jetpack-style).
    p.vx -= dx * w.recoil; p.vy -= dy * w.recoil * 0.5;
    p.muzzle = 0.09;
    this.sfx.shoot(p.weapon);
    this.burst(sx + dx * 26, sy + dy * 26, 5, '#fde047', 260);
    this.shake = Math.max(this.shake, 0.14);
  }

  private tryFire(p: R): void {
    const w = WEAPONS[p.weapon];
    if (p.cd > 0 || p.block || !p.alive) return;
    const sx = p.x, sy = p.y - 46, aim = Math.atan2(p.ay - sy, p.ax - sx);
    p.face = Math.cos(aim) >= 0 ? 1 : -1;
    if (w.melee) {
      // Finite melee (sword/spear 25): broken at 0 -> fists. Fists infinite.
      if (!isInfinite(p.weapon) && p.ammo <= 0) { p.weapon = 'fists'; p.ammo = -1; return; }
      p.swing = 0.18; p.cd = w.melee.interval;
      this.sfx.shoot(p.weapon);
      this.burst(sx + Math.cos(aim) * w.melee.range * 0.7, sy + Math.sin(aim) * w.melee.range * 0.7, 4, '#e5e5e5', 150);
      const solids = this.solids();
      for (const e of this.players) {
        if (e === p || !e.alive) continue;
        const dx = e.x - sx, dy = (e.y - 34) - sy, d = Math.hypot(dx, dy);
        let da = Math.abs(Math.atan2(dy, dx) - aim); if (da > Math.PI) da = 2 * Math.PI - da;
        if (d < w.melee.range + 20 && da < w.melee.arc / 2 + 0.35) {
          // Walls block melee: no spear/sword/fist hits through a pillar.
          if (this.segmentBlocked(sx, sy, e.x, e.y - 34, solids)) continue;
          this.hurt(e, p.boss ? w.damage * BOSS_MELEE_MULT : w.damage, Math.cos(aim) * w.knockback, -260, p.id, p.weapon, sy < e.y - 51);
        }
      };
      // Punch-boost: swinging fists airborne kicks the attacker (mobility).
      if (p.weapon === 'fists' && !p.onGround) {
        p.vx += Math.cos(aim) * 240; p.vy += Math.sin(aim) * 180;
        p.vx = Math.max(-700, Math.min(700, p.vx)); p.vy = Math.max(-900, Math.min(900, p.vy));
      }
      if (!isInfinite(p.weapon)) {
        p.ammo--;
        if (p.ammo <= 0) {
          p.weapon = 'fists'; p.ammo = -1;
          try { this.sfx.block(); } catch { /* silent */ }
          this.burst(sx, sy, 8, '#e5e7eb', 200);
        }
      }
      return;
    }
    if (w.beam) { // laser + sniper: hitscan beam
      if (!isInfinite(p.weapon) && p.ammo <= 0) { p.weapon = 'fists'; p.ammo = -1; return; }
      this.fireBeam(p, aim);
      return;
    }
    if (!isInfinite(p.weapon) && p.ammo <= 0) { p.weapon = 'fists'; p.ammo = -1; return; }
    const tune = TUNE[p.weapon];
    const n = w.pellets ?? 1;
    const explosiveR = w.explosive?.radius ?? 0;
    // Quickdraw: firing within 0.35s of pickup gets zero spread.
    const qd = this.time - (this.lastPickup.get(p.id) ?? -10) < 0.35;
    const effSpread = qd ? 0 : w.spread;
    for (let i = 0; i < n; i++) {
      const a = aim + (Math.random() - 0.5) * 2 * effSpread + (n > 1 ? (i / (n - 1) - 0.5) * 0.35 : 0);
      const sp = w.projectileSpeed * (0.92 + Math.random() * 0.16);
      this.projs.push({
        x: sx + Math.cos(a) * 18, y: sy + Math.sin(a) * 18,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: tune.life ?? 1.6, owner: p.id, kind: p.weapon, dmg: w.damage,
        fuse: tune.fuse ?? 0, explosive: explosiveR, grav: tune.grav ?? 0,
        bounces: w.bounce ?? tune.bounces ?? 0,
      });
    }
    if (!isInfinite(p.weapon) && p.ammo > 0) p.ammo--;
    if (!isInfinite(p.weapon) && p.ammo === 0) { /* empty -> fists on next trigger (kept one frame for throw) */ }
    p.cd = w.fireInterval;
    // Recoil incl. minigun jetpack: sustained downward fire lifts the player.
    p.vx -= Math.cos(aim) * w.recoil; p.vy -= Math.sin(aim) * w.recoil * 0.5;
    p.muzzle = 0.09;
    this.sfx.shoot(p.weapon);
    // Muzzle flash: bright core + smoke.
    this.burst(sx + Math.cos(aim) * 24, sy + Math.sin(aim) * 24, p.weapon === 'flamethrower' ? 6 : 3, p.weapon === 'flamethrower' ? '#fb923c' : '#fde047', 220);
    this.burst(sx + Math.cos(aim) * 30, sy + Math.sin(aim) * 30, 2, '#fff7ed', 140);
    this.shake = Math.max(this.shake, p.weapon === 'rpg' || p.weapon === 'sniper' ? 0.25 : 0.06);
  }

  private throwGun(p: R): void {
    if (p.weapon === 'fists' || !p.alive) return;
    const a = Math.atan2(p.ay - (p.y - 46), p.ax - p.x);
    this.projs.push({ x: p.x, y: p.y - 46, vx: Math.cos(a) * 800 + p.vx * 0.5, vy: Math.sin(a) * 800 - 150, life: 2.2, owner: p.id, kind: 'thrown', dmg: THROW_DAMAGE, fuse: 0, explosive: 0, grav: 1, bounces: 0, thrownW: p.weapon, ammo: p.ammo });
    p.weapon = 'fists'; p.ammo = -1;
    this.sfx.throwWeapon();
  }

  private collideBox(x: number, y: number, s: Solid): boolean { return x + 12 > s.x && x - 12 < s.x + s.w && y > s.y + 4 && y - 68 < s.y + s.h; }

  private checkHazards(p: R): void {
    if (!p.alive) return;
    const lv = this.level();
    const bx = p.x, top = p.y - 68, bot = p.y;
    for (const k of lv.killRects ?? []) {
      if (k.kind === 'laser' && k.period) {
        if (((this.time + (k.phase ?? 0)) % k.period) >= k.period * (k.duty ?? 0.5)) continue;
      }
      const kx = k.x * W, ky = k.y * H, kw = k.w * W, kh = k.h * H;
      if (bx + 11 > kx && bx - 11 < kx + kw && bot > ky && top < ky + kh) {
        this.hurt(p, 999, 0, -400, p.id, k.kind);
        return;
      }
    }
  }

  private update(dt: number): void {
    this.time += dt;
    if (this.bannerT > 0 && this.bannerT < 1e8) this.bannerT -= dt;
    this.shake = Math.max(0, this.shake - dt * 1.6);
    for (const q of this.parts) { q.life -= dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 900 * dt; }
    this.parts = this.parts.filter((q) => q.life > 0);
    for (const b of this.beams) b.t -= dt;
    this.beams = this.beams.filter((b) => b.t > 0);
    for (const f of this.fuses) { f.t -= dt; if (f.t <= 0) this.explode(f.x, f.y, f.r, f.dmg, f.owner); }
    this.fuses = this.fuses.filter((f) => f.t > 0);
    for (const p of this.players) {
      if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      if (p.squash > 0) p.squash = Math.max(0, p.squash - dt * 3.5);
      if (p.muzzle > 0) p.muzzle = Math.max(0, p.muzzle - dt);
      if (!p.alive) p.deadT += dt;
    }
    this.syncRematchBtn();
    if (this.paused || this.frozen) return;
    if (this.roundLock > 0) {
      this.roundLock -= dt;
      if (this.roundLock > 0) return;
      if (this.matchOver) { this.frozen = true; return; }
      this.round++;
      // Random (non-sequential) next arena, like the original.
      if (this.rotation.length > 1) {
        let n = this.levelIdx;
        do { n = (Math.random() * this.rotation.length) | 0; } while (n === this.levelIdx);
        this.levelIdx = n;
      }
      this.spawnAll(); // clears projectiles, fresh spawns
      this.banner = this.bossBanner() ?? `${this.levelLabel()} — ROUND ${this.round}`; this.bannerT = 2;
      return;
    }
    // Boss survive timer: boss alive for 45s wins the round.
    if (this.bossId !== null && this.roundLock <= 0) {
      const boss = this.players.find((p) => p.id === this.bossId);
      if (boss && boss.alive) {
        this.bossTime += dt;
        if (this.bossTime >= BOSS_SURVIVE_TIME) {
          boss.wins++;
          this.matchOver = boss.wins >= this.winScore;
          this.banner = this.matchOver ? `${boss.name} WINS THE MATCH!  [R] REMATCH · [Q] MENU` : `${boss.name} SURVIVES!  (${boss.wins}/${this.winScore})`;
          this.bannerT = this.matchOver ? 1e9 : 1.5;
          this.feed.push(`${boss.name} survived the hunt!`);
          if (this.feed.length > 8) this.feed.shift();
          this.sfx.win();
          this.roundLock = 1.5;
          return;
        }
      }
    }
    const solids = this.solids();
    for (const c of this.crates) { c.vy = Math.min(1400, c.vy + GRAVITY * dt); c.y += c.vy * dt; for (const s of solids) { if (s.type !== 'crate' && c.x < s.x + s.w && c.x + c.w > s.x && c.y < s.y + s.h && c.y + c.h > s.y && c.vy > 0 && c.y + c.h - s.y < 30) { c.y = s.y - c.h; c.vy = 0; } } }
    this.dropT -= dt;
    if (this.dropT <= 0) { this.dropT = 3.5; const lv = this.level(); if (this.drops.length < 4) { const d = lv.weaponDrops[(Math.random() * lv.weaponDrops.length) | 0]; this.spawnDrop(d[0] * W); } }
    for (const g of this.drops) {
      g.vy = Math.min(1400, g.vy + GRAVITY * dt);
      // Parachute sway while falling (original-style drop-in).
      if (g.vy !== 0) g.x += Math.sin(this.time * 3 + g.y * 0.02) * 40 * dt;
      g.x += g.vx * dt; g.y += g.vy * dt; g.vx *= 0.99;
      for (const s of solids) {
        if (g.x > s.x - 8 && g.x < s.x + s.w + 8 && g.y > s.y - 6 && g.y < s.y + s.h && g.vy > 0) {
          g.y = s.y - 2;
          g.vy = -g.vy * 0.35; // small bounce on landing
          if (Math.abs(g.vy) < 70) g.vy = 0;
          g.vx *= 0.6;
        }
      }
      // Lava/void swallows the drop: a fresh one falls from the sky after 3s.
      if (g.y > H + 40 || this.inLava(g.x, g.y)) { g.y = H + 999; g.vy = 0; this.dropRespawn.push(3); }
    }
    // Delayed respawns for drops lost to lava/void.
    for (let i = this.dropRespawn.length - 1; i >= 0; i--) {
      this.dropRespawn[i] -= dt;
      if (this.dropRespawn[i] <= 0) {
        this.dropRespawn.splice(i, 1);
        const lv = this.level();
        const d = lv.weaponDrops[(Math.random() * lv.weaponDrops.length) | 0];
        this.spawnDrop(d[0] * W);
      }
    }
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.boss) continue; // boss is fists-only, never picks up guns
      const g = this.drops.find((g) => g.vy >= 0 && Math.hypot(g.x - p.x, g.y - (p.y - 30)) < 30);
      if (!g) continue;
      // Re-pickup reloads to a full mag (thrown/empty guns become useful again).
      const fresh = fullAmmo(g.weapon);
      if (p.weapon === 'fists') { p.weapon = g.weapon; p.ammo = fresh; g.y = H + 999; this.sfx.pickup(); this.burst(p.x, p.y - 40, 6, '#facc15', 200); this.lastPickup.set(p.id, this.time); }
      else { const tw = p.weapon; p.weapon = g.weapon; p.ammo = fresh; g.weapon = tw; g.ammo = fullAmmo(tw); g.vy = -150; this.sfx.pickup(); this.lastPickup.set(p.id, this.time); }
    }
    this.drops = this.drops.filter((g) => g.y < H + 900);
    this.players.forEach((p, idx) => {
      p.cd = Math.max(0, p.cd - dt); p.flash = Math.max(0, p.flash - dt); p.swing = Math.max(0, p.swing - dt);
      p.stompCd = Math.max(0, p.stompCd - dt);
      // Flamethrower burn DoT.
      if (p.burnT > 0 && p.alive) {
        p.burnT -= dt; p.hp -= BURN_DPS * dt;
        if (Math.random() < 0.35) this.parts.push({ x: p.x + (Math.random() - 0.5) * 20, y: p.y - 20 - Math.random() * 30, vx: 0, vy: -120, life: 0.3, max: 0.3, color: '#fb923c', size: 3 });
        if (p.hp <= 0) this.hurt(p, 1, 0, -100, p.id, 'burn');
      }
      // Status timers: frost slows, glue roots. Cleared on death/spawn.
      if (p.frostT > 0) p.frostT = Math.max(0, p.frostT - dt);
      if (p.glueT > 0) p.glueT = Math.max(0, p.glueT - dt);
      let L = false, Rr = false, J = false, D = false, F = false, B = false, T = false;
      if (p.bot) { const c = this.botInput(p, dt); L = c.l; Rr = c.r; J = c.j; F = c.fire; B = c.blk; D = c.d; }
      else {
        const m = MAPS[idx];
        L = this.keys.has(m.l); Rr = this.keys.has(m.r); J = this.keys.has(m.j); D = this.keys.has(m.d); T = this.keys.has(m.f);
        if (m.aim === 'mouse') { p.ax = this.mouse.x; p.ay = this.mouse.y; F = this.mouse.fire; B = this.mouse.block || this.keys.has(m.b); }
        else { const foe = this.nearestEnemy(p); if (foe) { p.ax = foe.x; p.ay = foe.y - 34; } F = this.keys.has(m.fire); B = this.keys.has(m.b); D = this.keys.has(m.d); }
      }
      if (T && !p.prevFire) this.throwGun(p);
      p.prevFire = T; p.block = B;
      const glued = p.glueT > 0 && p.alive;
      const frosted = p.frostT > 0 && p.alive;
      const dir = glued ? 0 : (Rr ? 1 : 0) - (L ? 1 : 0);
      if (dir !== 0) p.face = dir > 0 ? 1 : -1;
      const spdMult = (p.boss ? BOSS_SPEED_MULT : 1) * (frosted ? 0.5 : 1);
      if (glued) {
        // Rooted: no accel, strong friction (can still fire/block).
        p.vx *= Math.pow(0.7, dt * 60);
        if (Math.abs(p.vx) < 4) p.vx = 0;
      } else if (dir !== 0) p.vx += dir * MOVE_SPEED * spdMult * 4 * (p.onGround ? 1 : 0.65) * dt;
      else p.vx *= p.onGround ? Math.pow(p.ground === 'ice' ? 0.94 : 0.8, dt * 60) : 0.995;
      p.vx = Math.max(-MOVE_SPEED * spdMult, Math.min(MOVE_SPEED * spdMult, p.vx));
      if (p.ground === 'conveyor') { const s = solids.find((q) => q.type === 'conveyor'); if (s?.belt) p.vx += s.belt * W * dt; }
      const wasGround = p.onGround;
      const fallSpeed = p.vy;
      // Wall-slide probe: airborne, falling, pressing into a side wall.
      p.wallLock = Math.max(0, p.wallLock - dt);
      p.wallD = !wasGround && dir !== 0 && p.vy > 0 && p.wallLock <= 0 ? this.touchingWall(p, solids, dir) : 0;
      p.slide = p.wallD !== 0;
      if (!glued && J && (p.onGround || this.onProp(p))) { p.vy = -JUMP_SPEED * (frosted ? 0.8 : 1); p.onGround = false; p.slide = false; this.sfx.jump(); }
      else if (!glued && J && p.slide) {
        // Wall-jump: push off away from the wall, slightly weaker vertically.
        p.vx = -p.wallD * WALL_JUMP_VX;
        p.vy = -JUMP_SPEED * WALL_JUMP_VY_SCALE * (frosted ? 0.8 : 1);
        p.face = p.vx >= 0 ? 1 : -1;
        p.onGround = false; p.slide = false; p.wallD = 0; p.wallLock = WALL_LOCK;
        this.sfx.jump();
        this.burst(p.x, p.y - 34, 5, '#d6d3d1', 180);
      }
      if (D) p.dropT = 0.25; else p.dropT = Math.max(0, p.dropT - dt);
      p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * dt);
      if (p.slide && !p.onGround && p.vy > WALL_SLIDE_CAP) p.vy = WALL_SLIDE_CAP;
      if (p.slide && !p.onGround && Math.random() < 0.4) {
        // Wall-slide dust on the contact side.
        this.parts.push({ x: p.x + p.wallD * 12, y: p.y - 24 - Math.random() * 28, vx: -p.wallD * 70, vy: 70, life: 0.3, max: 0.3, color: '#d6d3d1', size: 2 });
      }
      // Substep X so one frame can never tunnel through a thin pillar.
      const xDist = Math.abs(p.vx * dt);
      const xSteps = Math.max(1, Math.min(8, Math.ceil(xDist / 8)));
      const xh = dt / xSteps;
      for (let xs = 0; xs < xSteps; xs++) {
        p.x += p.vx * xh;
        // One-way decks: only resolve a side hit when X motion caused the
        // overlap. If the body already overlapped vertically (jumping up
        // through a deck from below), X must not eject it sideways to the
        // platform edge — Y (land/drop-through) owns that axis.
        const oldX = p.x - p.vx * xh;
        for (const s of solids) {
          if (!this.collideBox(p.x, p.y, s)) continue;
          if (this.collideBox(oldX, p.y, s)) continue;
          p.x = p.vx > 0 ? s.x - 12 : p.vx < 0 ? s.x + s.w + 12 : p.x; p.vx = 0;
        }
      }
      p.x = Math.max(12, Math.min(W - 12, p.x));
      const prevY = p.y; p.y += p.vy * dt; p.onGround = false; p.ground = '';
      if (p.dropT <= 0) for (const s of solids) {
        if (p.x + 11 > s.x && p.x - 11 < s.x + s.w && p.y >= s.y && prevY <= s.y + 12 && p.vy >= 0) {
          p.y = s.y; p.onGround = true; p.ground = s.type; p.slide = false; p.wallD = 0;
          // Mover carry: ride the platform's frame delta; rotators push tangentially.
          if (s.type === 'mover' && s.mi !== undefined) {
            const d = this.moverDelta(s.mi, dt);
            p.x = Math.max(12, Math.min(W - 12, p.x + d.dx)); p.y += d.dy;
          } else if (s.type === 'rotator' && s.ri !== undefined) {
            const r = (this.level().rotators ?? [])[s.ri];
            if (r) p.x = Math.max(12, Math.min(W - 12, p.x + r.angleSpeed * ROTATOR_CARRY * dt));
          }
          if (s.type === 'bouncy') { p.vy = -1150; p.onGround = false; this.sfx.jump(); }
          else if (s.type === 'lava') this.hurt(p, 999, 0, -400, p.id, 'lava');
          else {
            // Squash on land scaled by impact speed + dust puff.
            if (!wasGround && fallSpeed > 350) {
              p.squash = Math.max(p.squash, Math.min(1, fallSpeed / 1100));
              this.burst(p.x, p.y, 5, '#d6d3d1', 140);
            }
            p.vy = 0;
          }
        }
      }
      // Knockback / soft-push / carry can leave the body inside a side wall
      // where the X "oldX" guard above intentionally skips — eject so sealed
      // areas (Box Fort interior) can never be entered.
      this.depenetrate(p, solids);
      if (p.y > H + 80) this.hurt(p, 999, 0, 0, p.id, 'fell');
      this.checkHazards(p);
      if (Math.abs(p.vx) > 40 && p.onGround) p.walk += dt * 11;
      const w = WEAPONS[p.weapon];
      // Boss shockwave stomp: down+fire, 1.5s cooldown. Suppresses normal fire.
      let stomped = false;
      if (p.boss && p.alive && D && F && p.stompCd <= 0) {
        p.stompCd = BOSS_STOMP_COOLDOWN;
        this.doStomp(p);
        stomped = true;
      }
      if (!stomped && F && (w.auto || !p.fireHeld)) this.tryFire(p);
      // Empty non-melee gun falls back to fists (throw first if you want the 55dmg toss).
      if (!isInfinite(p.weapon) && p.ammo <= 0 && !w.melee && !w.beam) { p.weapon = 'fists'; p.ammo = -1; }
      p.fireHeld = F;
    });
    // Player-player soft collision so fighters can't share one body.
    this.separatePlayers();
    const s2 = this.solids();
    for (const pr of this.projs) {
      pr.life -= dt;
      if (pr.kind === 'snake' || pr.kind === 'snakeshot') this.steerSnake(pr, dt);
      if (pr.fuse > 0) { pr.fuse -= dt; if (pr.fuse <= 0) { if (pr.explosive) this.explode(pr.x, pr.y, pr.explosive, pr.dmg, pr.owner); pr.life = 0; continue; } }
      pr.vy += GRAVITY * pr.grav * dt; pr.x += pr.vx * dt; pr.y += pr.vy * dt;
      let hit = pr.x < 0 || pr.x > W || pr.y < -60 || pr.y > H + 40;
      let wall: Solid | null = null;
      if (!hit) for (const s of s2) if (pr.x > s.x && pr.x < s.x + s.w && pr.y > s.y && pr.y < s.y + s.h) { wall = s; hit = true; break; }
      if (hit) {
        if (wall && pr.bounces > 0 && !pr.explosive) {
          pr.bounces--;
          if (Math.abs(pr.vx) > Math.abs(pr.vy)) pr.vx *= -1; else pr.vy *= -1;
          pr.x += pr.vx * dt * 2; pr.y += pr.vy * dt * 2; pr.life = Math.max(pr.life, 0.2);
          this.burst(pr.x, pr.y, 3, '#4ade80', 180);
          continue;
        }
        if (pr.explosive) this.explode(pr.x, pr.y, pr.explosive, pr.dmg, pr.owner);
        else if (pr.kind === 'thrown' && pr.thrownW) { this.drops.push({ x: pr.x, y: pr.y, vx: 0, vy: 0, weapon: pr.thrownW, ammo: pr.ammo ?? fullAmmo(pr.thrownW) }); this.burst(pr.x, pr.y, 4, '#d4d4d4', 150); }
        else this.burst(pr.x, pr.y, 4, '#fde047', 200);
        pr.life = 0; continue;
      }
      for (const e of this.players) {
        if (!e.alive || e.id === pr.owner || pr.life <= 0) continue;
        if (Math.abs(pr.x - e.x) >= 14 || pr.y <= e.y - 70 || pr.y >= e.y) continue;
        const head = pr.y < e.y - 51;
        if (pr.kind === 'thrown' && pr.thrownW) { this.hurt(e, pr.dmg, pr.vx * 0.5, -250, pr.owner, 'thrown', head); this.drops.push({ x: pr.x, y: pr.y - 10, vx: pr.vx * 0.2, vy: -150, weapon: pr.thrownW, ammo: pr.ammo ?? 0 }); }
        else if (pr.explosive) this.explode(pr.x, pr.y, pr.explosive, pr.dmg, pr.owner);
        else {
          this.hurt(e, pr.dmg, pr.vx * 0.28, -120, pr.owner, String(pr.kind), head);
          if (pr.kind === 'flamethrower') { e.burnT = BURN_TIME; this.burst(pr.x, pr.y, 3, '#fb923c', 160); }
          else if (pr.kind === 'ice') { e.frostT = 2; this.burst(pr.x, pr.y, 6, '#7dd3fc', 180); }
          else if (pr.kind === 'glue') { e.glueT = Math.min(3, e.glueT + 1); this.burst(pr.x, pr.y, 6, '#d6a85c', 160); }
        }
        pr.life = 0; break;
      }
      for (const b of this.barrels) {
        if (b.hp <= 0 || pr.life <= 0 || Math.abs(pr.x - b.x) >= 16 || Math.abs(pr.y - b.y) >= 22) continue;
        b.hp -= pr.dmg; pr.life = 0;
        if (b.hp <= 0) this.fuses.push({ x: b.x, y: b.y, t: 0.1, r: 150, dmg: 55, owner: pr.owner });
        else this.burst(pr.x, pr.y, 3, '#f87171', 180);
        break;
      }
    }
    this.projs = this.projs.filter((p) => p.life > 0);
  }

  private toPlayerState(p: R): PlayerState & Record<string, unknown> {
    // LocalMode uses feet-based y; PlayerState uses top-based y (PH=54).
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x - 13,
      y: p.y - 54,
      vx: p.vx,
      vy: p.vy,
      facing: p.face,
      aimX: p.ax - p.x,
      aimY: p.ay - (p.y - 46),
      hp: p.hp,
      alive: p.alive,
      weapon: p.weapon,
      ammo: p.ammo,
      cooldown: p.cd,
      onGround: p.onGround,
      wins: p.wins,
      kills: 0,
      boss: p.boss,
      maxHp: p.maxHp,
      hpBlink: p.flash,
      blockHeld: p.block,
      invulnT: p.invuln,
      squash: p.squash,
      deadT: p.deadT,
    };
  }

  private stick(p: R): void {
    const c = this.ctx;
    if (p.boss && p.alive) {
      // Juggernaut: draw 1.8x scaled around the feet, then crown/horns + HP bar.
      c.save();
      c.translate(p.x, p.y);
      c.scale(BOSS_SCALE, BOSS_SCALE);
      c.translate(-p.x, -p.y);
      drawStick(c, this.toPlayerState(p) as PlayerState, this.time);
      c.restore();
      this.drawBossAdornments(p);
    } else {
      drawStick(this.ctx, this.toPlayerState(p) as PlayerState, this.time);
    }
    // Muzzle flash star at the gun tip while firing.
    if (p.muzzle > 0 && p.alive && p.weapon !== 'fists') {
      const shY = p.y - 46;
      const aim = Math.atan2(p.ay - shY, p.ax - p.x);
      const tx = p.x + Math.cos(aim) * 44;
      const ty = shY + Math.sin(aim) * 44;
      const r = 8 + Math.random() * 6;
      c.save();
      c.globalAlpha = Math.max(0, p.muzzle / 0.09);
      c.fillStyle = '#fef08a';
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = aim + (i / 6) * Math.PI * 2;
        const rr = i % 2 === 0 ? r : r * 0.45;
        const px = tx + Math.cos(a) * rr;
        const py = ty + Math.sin(a) * rr;
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.closePath();
      c.fill();
      c.fillStyle = '#fff7ed';
      c.beginPath();
      c.arc(tx, ty, 3.5, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  private drawBossAdornments(p: R): void {
    const c = this.ctx;
    // Scaled head sits at feet - 48*1.8; crown floats just above.
    const headY = p.y - 48 * BOSS_SCALE;
    const cx = p.x;
    c.save();
    // Horns (red devils) + gold crown.
    c.fillStyle = '#dc2626';
    c.beginPath();
    c.moveTo(cx - 14, headY - 6);
    c.lineTo(cx - 20, headY - 20);
    c.lineTo(cx - 8, headY - 12);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(cx + 14, headY - 6);
    c.lineTo(cx + 20, headY - 20);
    c.lineTo(cx + 8, headY - 12);
    c.closePath();
    c.fill();
    c.fillStyle = '#facc15';
    c.strokeStyle = '#0a0a0a';
    c.lineWidth = 2;
    const cw = 26, ch = 12, cy = headY - 22;
    c.beginPath();
    c.moveTo(cx - cw / 2, cy);
    c.lineTo(cx - cw / 2, cy - ch);
    c.lineTo(cx - cw / 4, cy - ch + 5);
    c.lineTo(cx, cy - ch - 3);
    c.lineTo(cx + cw / 4, cy - ch + 5);
    c.lineTo(cx + cw / 2, cy - ch);
    c.lineTo(cx + cw / 2, cy);
    c.closePath();
    c.fill();
    c.stroke();
    // HP bar above crown.
    const bw = 84, bx = cx - bw / 2, by = cy - ch - 16;
    const frac = Math.max(0, Math.min(1, p.hp / Math.max(1, p.maxHp)));
    c.fillStyle = 'rgba(0,0,0,0.65)';
    c.fillRect(bx - 2, by - 2, bw + 4, 10);
    c.fillStyle = '#3f3f46';
    c.fillRect(bx, by, bw, 6);
    c.fillStyle = frac > 0.5 ? '#22c55e' : frac > 0.25 ? '#facc15' : '#ef4444';
    c.fillRect(bx, by, bw * frac, 6);
    c.fillStyle = '#fff';
    c.font = 'bold 9px sans-serif';
    c.textAlign = 'center';
    c.fillText(`BOSS ${Math.ceil(p.hp)}/${p.maxHp}`, cx, by - 4);
    // Boss survive countdown.
    if (this.bossId === p.id && this.bossTime < BOSS_SURVIVE_TIME) {
      c.fillStyle = '#fde047';
      c.font = 'bold 11px sans-serif';
      c.fillText(`${Math.ceil(BOSS_SURVIVE_TIME - this.bossTime)}s`, cx, by + 22);
    }
    c.restore();
  }

  private render(): void {
    const c = this.ctx, lv = this.level();
    c.save(); c.clearRect(0, 0, W, H);
    if (this.shake > 0) c.translate((Math.random() - 0.5) * this.shake * 16, (Math.random() - 0.5) * this.shake * 16);
    drawBackground(c, lv.theme, this.time);
    // Hazards underlay: lava / spikes / laser gates.
    for (const k of lv.killRects ?? []) {
      const kx = k.x * W, ky = k.y * H, kw = k.w * W, kh = k.h * H;
      if (k.kind === 'laser' && k.period) {
        const on = ((this.time + (k.phase ?? 0)) % k.period) < k.period * (k.duty ?? 0.5);
        c.fillStyle = on ? '#ef4444' : 'rgba(239,68,68,0.15)';
        c.fillRect(kx, ky, kw, Math.max(3, kh));
        continue;
      }
      c.fillStyle = k.kind === 'lava' ? '#dc2626' : '#9ca3af';
      c.fillRect(kx, ky, kw, kh);
      if (k.kind === 'lava') { c.fillStyle = '#fbbf24'; c.fillRect(kx, ky, kw, 4); }
      else { c.fillStyle = '#4b5563'; for (let x = kx; x < kx + kw; x += 14) { c.beginPath(); c.moveTo(x, ky + kh); c.lineTo(x + 7, ky); c.lineTo(x + 14, ky + kh); c.fill(); } }
    }
    for (const s of this.solids()) {
      if (s.type === 'crate') continue;
      if (s.type === 'lava') { c.fillStyle = '#dc2626'; c.fillRect(s.x, s.y, s.w, s.h); c.fillStyle = '#fbbf24'; c.fillRect(s.x, s.y, s.w, 4); continue; }
      c.fillStyle = PLAT[s.type] ?? '#8b5a2b'; c.fillRect(s.x, s.y, s.w, s.h);
      c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(s.x, s.y, s.w, 4); c.fillStyle = 'rgba(0,0,0,0.4)'; c.fillRect(s.x, s.y + s.h - 3, s.w, 3);
    }
    for (const r of lv.rotators ?? []) { c.save(); c.translate(r.cx * W, r.cy * H); c.rotate(this.time * r.angleSpeed); c.fillStyle = '#c084fc'; c.fillRect((-r.w * W) / 2, (-r.h * H) / 2, r.w * W, r.h * H); c.restore(); }
    for (const t of this.crates) { c.fillStyle = '#92600f'; c.fillRect(t.x, t.y, t.w, t.h); c.strokeStyle = '#451a03'; c.lineWidth = 3; c.strokeRect(t.x, t.y, t.w, t.h); c.beginPath(); c.moveTo(t.x, t.y); c.lineTo(t.x + t.w, t.y + t.h); c.moveTo(t.x + t.w, t.y); c.lineTo(t.x, t.y + t.h); c.stroke(); }
    c.textAlign = 'center';
    for (const b of this.barrels.filter((b) => b.hp > 0)) {
      c.fillStyle = '#dc2626'; c.beginPath(); c.arc(b.x, b.y, 15, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fbbf24'; c.font = 'bold 14px sans-serif'; c.fillText('!', b.x, b.y + 5);
    }
    for (const d of this.drops.filter((d) => d.y <= H + 800)) {
      c.fillStyle = '#111827'; c.fillRect(d.x - 20, d.y - 12, 40, 12);
      c.fillStyle = '#facc15'; c.font = 'bold 9px sans-serif'; c.fillText(String(d.weapon).toUpperCase(), d.x, d.y - 3);
    }
    for (const bm of this.beams) {
      c.globalAlpha = Math.max(0, bm.t / 0.18);
      c.strokeStyle = bm.color; c.lineWidth = 5; c.beginPath(); c.moveTo(bm.x1, bm.y1); c.lineTo(bm.x2, bm.y2); c.stroke();
      c.strokeStyle = '#ffffff'; c.lineWidth = 2; c.beginPath(); c.moveTo(bm.x1, bm.y1); c.lineTo(bm.x2, bm.y2); c.stroke();
      c.globalAlpha = 1;
    }
    for (const pr of this.projs) {
      if (pr.kind === 'snake' || pr.kind === 'snakeshot') continue;
      if (pr.kind === 'ice' || pr.kind === 'glue') continue; // drawn by drawIceGlue below
      if (pr.kind === 'grenade') { c.fillStyle = pr.fuse < 0.5 ? '#ef4444' : '#1f2937'; c.beginPath(); c.arc(pr.x, pr.y, 7, 0, Math.PI * 2); c.fill(); }
      else if (pr.kind === 'thrown') { c.save(); c.translate(pr.x, pr.y); c.rotate(this.time * 12); c.fillStyle = '#e5e7eb'; c.fillRect(-12, -3, 24, 6); c.restore(); }
      else if (pr.kind === 'flamethrower') { c.fillStyle = Math.random() < 0.5 ? '#fb923c' : '#fbbf24'; c.beginPath(); c.arc(pr.x, pr.y, 5 + Math.random() * 3, 0, Math.PI * 2); c.fill(); }
      else if (pr.kind === 'bouncer') { c.fillStyle = '#4ade80'; c.beginPath(); c.arc(pr.x, pr.y, 6, 0, Math.PI * 2); c.fill(); }
      else if (pr.explosive) { c.fillStyle = '#fb923c'; c.beginPath(); c.arc(pr.x, pr.y, 6, 0, Math.PI * 2); c.fill(); }
      else { c.strokeStyle = '#fef08a'; c.lineWidth = 3; c.beginPath(); c.moveTo(pr.x, pr.y); c.lineTo(pr.x - pr.vx * 0.018, pr.y - pr.vy * 0.018); c.stroke(); }
    }
    drawSnakes(c, this.projs, this.time);
    drawIceGlue(c, this.projs, this.time);
    for (const p of this.players) {
      this.stick(p);
      if (!p.alive) continue;
      if (p.frostT > 0) drawFrostOverlay(c, p.x, p.y, this.time);
      if (p.glueT > 0) drawGlueOverlay(c, p.x, p.y, this.time);
    }
    for (const q of this.parts) { c.globalAlpha = Math.max(0, q.life / q.max); c.fillStyle = q.color; c.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size); }
    c.globalAlpha = 1;
    if (this.bannerT > 0 && this.banner) {
      const matchWin = /WINS THE MATCH/i.test(this.banner);
      // High banner (upper third) so mid-map spawns stay visible underneath.
      const by = H * 0.24;
      c.textAlign = 'center';
      c.font = '64px "Luckiest Guy", system-ui, sans-serif'; c.lineWidth = 8; c.strokeStyle = '#000'; c.strokeText(this.banner, W / 2, by); c.fillStyle = matchWin ? '#fde047' : '#facc15'; c.fillText(this.banner, W / 2, by);
      if (matchWin) {
        c.font = 'bold 20px system-ui, sans-serif'; c.lineWidth = 4;
        const sub = `FIRST TO ${this.winScore} — click REMATCH or press R · Q for menu`;
        c.strokeText(sub, W / 2, by + 44); c.fillStyle = '#fff'; c.fillText(sub, W / 2, by + 44);
      }
    }
    if (this.paused) {
      c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(-20, -20, W + 40, H + 40);
      c.textAlign = 'center';
      c.font = '56px "Luckiest Guy", system-ui, sans-serif'; c.lineWidth = 8; c.strokeStyle = '#000'; c.strokeText('PAUSED', W / 2, H / 2 - 60); c.fillStyle = '#fff'; c.fillText('PAUSED', W / 2, H / 2 - 60);
      c.font = '20px system-ui, sans-serif'; c.fillStyle = '#d4d4d4'; c.fillText('Esc resume · R restart · Q quit to menu', W / 2, H / 2 - 16);
      c.font = '16px system-ui, sans-serif'; c.fillStyle = '#93c5fd';
      c.fillText('P1: WASD + mouse (LMB fire · RMB block · F throw) · P2: arrows + / fire', W / 2, H / 2 + 14);
      c.fillStyle = '#fbbf24';
      c.fillText('H toggles help · first to 5 wins takes the match', W / 2, H / 2 + 38);
    }
    if (this.showHelp && !this.paused) {
      c.fillStyle = 'rgba(0,0,0,0.72)'; c.fillRect(W / 2 - 300, 90, 600, 300);
      c.strokeStyle = '#facc15'; c.lineWidth = 2; c.strokeRect(W / 2 - 300, 90, 600, 300);
      c.textAlign = 'left';
      c.font = 'bold 22px system-ui, sans-serif'; c.fillStyle = '#facc15';
      c.fillText('CONTROLS  (H to close)', W / 2 - 280, 122);
      c.font = '15px system-ui, sans-serif'; c.fillStyle = '#e5e7eb';
      const rows = [
        'P1 move: A/D · jump: W · drop: S · aim: mouse',
        'P1 fire: LMB · block: RMB · throw: F',
        'P2 move: ←/→ · jump: ↑ · drop: ↓ · fire: /',
        'P2 block: . · throw: , · global: H help',
        'Esc pause · R rematch · Q quit to menu',
        'Grab guns, block to survive, first to 5 wins!',
      ];
      rows.forEach((r, i) => c.fillText(r, W / 2 - 280, 152 + i * 28));
      c.textAlign = 'center';
    }
    c.restore();
  }
}
