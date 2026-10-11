import {
  AIR_CONTROL,
  GRAVITY,
  JUMP_SPEED,
  MAX_FALL,
  MOVE_SPEED,
  PLAYER_COLORS,
  PLAYER_HP,
  WORLD_H,
  WORLD_W,
} from "../shared/constants.js";
import type {
  BarrelState,
  CrateState,
  DroppedGun,
  LevelDef,
  PlayerState,
  ProjectileState,
  WeaponId,
} from "../shared/types.js";
import type { SnapshotEvent } from "../shared/protocol.js";
import { LEVELS } from "../src/levels/levels.js";
import { WEAPONS as CANON_WEAPONS } from "../src/weapons/defs.js";
import { separatePlayers } from "../src/entities/player.js";

export interface MatchInput {
  left: boolean;
  right: boolean;
  jump: boolean;
  down: boolean;
  fire: boolean;
  block: boolean;
  throwReq: boolean;
  aimX: number;
  aimY: number;
  seq?: number;
}

export const emptyInput = (): MatchInput => ({
  left: false,
  right: false,
  jump: false,
  down: false,
  fire: false,
  block: false,
  throwReq: false,
  aimX: 0,
  aimY: 0,
});

export const PW = 26;
export const PH = 54;
// Wall-slide + wall-jump tuning (mirrors src/physics/world.ts).
const WALL_SLIDE_CAP = 180;
const WALL_JUMP_VX = 380;
const WALL_JUMP_VY_SCALE = 0.92;
const WALL_LOCK = 0.18;
const ROTATOR_CARRY = 55;
const WIN_SCORE = 5;
const DROP_INTERVAL = 4;
const MAX_DROPS = 6;
const THROW_DAMAGE = 55;
// Explosive barrels (top-left anchored, 22x30). One pistol-class hit + one
// weak hit detonates (HP 30, min 25 chip); thrown guns one-shot.
const BARREL_W = 22;
const BARREL_H = 30;
const BARREL_HP = 30;
const BARREL_CHIP = 25;
const BARREL_BLAST_R = 135;
const BARREL_BLAST_DMG = 85;

interface GunDef {
  damage: number;
  interval: number;
  mag: number;
  speed: number;
  spread: number;
  recoil: number;
  knockback: number;
  auto: boolean;
  pellets?: number;
  life?: number;
  gravity?: number;
  bounce?: number;
  melee?: { range: number; arc: number; interval: number };
  explosive?: { radius: number; damage: number };
  beam?: boolean;
}

const F = (p: Partial<GunDef> & Pick<GunDef, "damage" | "interval" | "mag" | "speed">): GunDef => ({
  spread: 0,
  recoil: 60,
  knockback: 320,
  auto: false,
  ...p,
});

export const WEAPONS: Record<WeaponId, GunDef> = buildCanonicalWeapons();

function buildCanonicalWeapons(): Record<WeaponId, GunDef> {
  // Per-weapon projectile tuning. Lives aligned with LocalMode TUNE so both
  // modes feel identical (bouncer 2.5/bounce-6, flamethrower 0.32, etc).
  const tune: Record<WeaponId, Partial<GunDef>> = {
    fists: {},
    pistol: { life: 1.6 },
    revolver: { life: 1.6 },
    deagle: { life: 1.6 },
    uzi: { life: 1.4 },
    ak47: { life: 1.5 },
    m16: { life: 1.5 },
    sniper: { life: 1.6 },
    shotgun: { life: 1.1 },
    sawedoff: { life: 1.0 },
    bouncer: { life: 2.5, bounce: 6 },
    minigun: { life: 1.3 },
    grenade: { life: 3.2, gravity: 2400, explosive: { radius: 130, damage: 65 } },
    rpg: { life: 3, gravity: 288, explosive: { radius: 150, damage: 150 } },
    flamethrower: { life: 0.32 },
    sword: {},
    spear: {},
    snake: { life: 6 },
    snakeshot: { life: 6 },
    ice: { life: 1.2, gravity: 1200 },
    glue: { life: 1.5, gravity: 900 },
  };
  const out = {} as Record<WeaponId, GunDef>;
  (Object.keys(CANON_WEAPONS) as WeaponId[]).forEach((id) => {
    const c = CANON_WEAPONS[id];
    const t = tune[id] ?? {};
    out[id] = {
      damage: c.damage,
      interval: c.fireInterval,
      mag: c.melee && c.magSize >= 9000 ? 0 : c.magSize,
      speed: c.projectileSpeed,
      spread: c.spread,
      recoil: c.recoil,
      knockback: c.knockback,
      auto: c.auto,
      pellets: c.pellets,
      life: t.life,
      gravity: t.gravity,
      bounce: t.bounce ?? c.bounce,
      melee: c.melee ? { ...c.melee } : undefined,
      explosive: c.explosive ? { radius: c.explosive.radius, damage: t.explosive?.damage ?? c.damage } : t.explosive,
      beam: !!c.beam,
    };
  });
  return out;
}

const DROP_CYCLE: WeaponId[] = [
  "pistol", "shotgun", "uzi", "ak47", "sniper", "revolver", "deagle",
  "grenade", "rpg", "sword", "spear", "minigun", "bouncer",
  "sawedoff", "flamethrower", "m16", "ice", "glue", "snake", "snakeshot",
];
const DROP_COMMON: WeaponId[] = DROP_CYCLE.filter((w) => w !== "snake" && w !== "snakeshot");
const DROP_RARE: WeaponId[] = ["snake", "snakeshot"];

interface Proj extends ProjectileState {
  damage: number;
  thrown?: boolean;
  gravity?: number;
  explosiveDmg?: number;
  explosiveRadius?: number;
  fuse?: number;
  ammo?: number;
}

interface Solid {
  x: number; y: number; w: number; h: number;
  type?: string;
  beltPx?: number;
  mi?: number;
  ri?: number;
}

export class Match {
  tick = 0;
  time = 0;
  round = 1;
  players: PlayerState[] = [];
  projectiles: Proj[] = [];
  crates: CrateState[] = [];
  barrels: BarrelState[] = [];
  drops: DroppedGun[] = [];
  level: LevelDef;
  wins: Record<number, number> = {};
  private events: SnapshotEvent[] = [];
  private nextProjId = 1;
  private nextBotId = -1;
  private dropTimer = 2;
  private dropIndex = 0;
  private dropRespawns: number[] = [];
  private burns = new Map<number, number>();
  private burnOwners = new Map<number, number>();
  private frosts = new Map<number, number>();
  private glues = new Map<number, number>();
  private resetTimer = -1;
  private prevJump = new Map<number, boolean>();
  private prevThrow = new Map<number, boolean>();
  private blocking = new Map<number, boolean>();
  private cycle: LevelDef[];
  private cycleIndex = 0;
  private winScore: number;
  private lastPickup = new Map<number, number>();
  private wallLocks = new Map<number, number>();

  constructor(level: LevelDef, opts?: { cycle?: LevelDef[]; winsTarget?: number }) {
    this.level = level;
    this.cycle = opts?.cycle?.length ? opts.cycle : [level];
    this.winScore = opts?.winsTarget ?? WIN_SCORE;
    this.cycleIndex = Math.max(0, this.cycle.findIndex((l) => l.id === level.id));
    this.resetArena();
  }

  addPlayer(id: number, name: string, color?: string, isBot = false): PlayerState {
    const slot = this.players.length % 4;
    const p: PlayerState = {
      id, name, color: color ?? PLAYER_COLORS[slot % PLAYER_COLORS.length],
      x: 0, y: 0, vx: 0, vy: 0, facing: slot % 2 === 0 ? 1 : -1,
      aimX: 0, aimY: 0, hp: PLAYER_HP, alive: true,
      weapon: "fists", ammo: 0, cooldown: 0,
      onGround: false, wins: this.wins[id] ?? 0, kills: 0, isBot,
    };
    this.players.push(p);
    this.spawnPlayer(p);
    return p;
  }

  removePlayer(id: number): void {
    this.players = this.players.filter((p) => p.id !== id);
    delete this.wins[id];
    this.prevJump.delete(id);
    this.prevThrow.delete(id);
    this.blocking.delete(id);
    this.lastPickup.delete(id);
    this.wallLocks.delete(id);
    this.burns.delete(id);
    this.burnOwners.delete(id);
    this.frosts.delete(id);
    this.glues.delete(id);
  }

  ensureBots(): void {
    let n = 0;
    while (this.players.length < 2 && n < 2) {
      n++;
      this.addPlayer(this.nextBotId--, `BOT-${n}`, undefined, true);
    }
  }

  drainEvents(): SnapshotEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  step(dt: number, inputs: Map<number, MatchInput>): void {
    this.tick++;
    this.time += dt;
    this.ensureBots();

    // Synthesize bot inputs
    for (const p of this.players) {
      if (p.isBot && p.alive) inputs.set(p.id, this.botInput(p));
    }

    // Drop timer
    this.dropTimer -= dt;
    if (this.dropTimer <= 0) {
      this.dropTimer = DROP_INTERVAL;
      this.spawnDrop();
    }
    // Delayed respawns for drops lost to lava/void.
    for (let i = this.dropRespawns.length - 1; i >= 0; i--) {
      this.dropRespawns[i] -= dt;
      if (this.dropRespawns[i] <= 0) {
        this.dropRespawns.splice(i, 1);
        this.spawnDrop();
      }
    }

    // Flamethrower burn DoT (5 dps for 1.2s, refreshable) — matches LocalMode.
    for (const p of this.players) {
      const bt = this.burns.get(p.id) ?? 0;
      if (bt > 0 && p.alive) {
        if (bt - dt <= 0) this.burns.delete(p.id);
        else this.burns.set(p.id, bt - dt);
        this.damage(p, 5 * dt, this.burnOwners.get(p.id) ?? p.id, 0, 0, "burn");
      }
    }
    // Status timers tick down (frost 2s slow, glue stacking root max 3s).
    for (const [id, t] of this.frosts) {
      if (t - dt <= 0) this.frosts.delete(id);
      else this.frosts.set(id, t - dt);
    }
    for (const [id, t] of this.glues) {
      if (t - dt <= 0) this.glues.delete(id);
      else this.glues.set(id, t - dt);
    }

    // Players
    for (const p of this.players) {
      const inp = inputs.get(p.id) ?? emptyInput();
      this.blocking.set(p.id, inp.block);
      if (p.cooldown > 0) p.cooldown -= dt;
      if (!p.alive) continue;
      p.aimX = inp.aimX;
      p.aimY = inp.aimY;
      this.movePlayer(p, inp, dt);
      const pj = this.prevJump.get(p.id) ?? false;
      void pj;
      this.prevJump.set(p.id, inp.jump);
      const pt = this.prevThrow.get(p.id) ?? false;
      if (inp.throwReq && !pt) this.tryThrow(p, inp);
      this.prevThrow.set(p.id, inp.throwReq);
      if (inp.fire) {
        this.tryFire(p, inp);
      }
      this.tryPickup(p);
      this.checkHazards(p);
    }

    // Player-player soft collision so fighters can't share one body.
    // Wall-aware: never shove a victim through a wall into a sealed area.
    separatePlayers(this.players, this.solids());
    for (const p of this.players) {
      if (p.alive) this.depenetrate(p, this.solids());
    }

    this.stepProjectiles(dt);
    this.stepCrates(dt);
    this.stepBarrels(dt);
    this.stepDrops(dt);
    this.checkRound(dt);
  }

  // ---- setup ----

  private resetArena(): void {
    this.projectiles = [];
    this.drops = [];
    this.dropTimer = 2;
    this.burns.clear();
    this.burnOwners.clear();
    this.frosts.clear();
    this.glues.clear();
    this.wallLocks.clear();
    this.crates = (this.level.crates ?? []).map((c) => ({
      x: (c.x * WORLD_W) | 0, y: (c.y * WORLD_H) | 0,
      w: Math.max(20, c.w * WORLD_W), h: Math.max(20, c.h * WORLD_H),
      vx: 0, vy: 0, angle: 0,
    }));
    this.barrels = (this.level.barrels ?? []).map((b) => ({
      x: b.x * WORLD_W, y: b.y * WORLD_H, hp: BARREL_HP, vx: 0, vy: 0,
    }));
    for (const p of this.players) {
      p.hp = PLAYER_HP;
      p.alive = true; p.vx = 0; p.vy = 0;
      p.weapon = "fists"; p.ammo = 0; p.cooldown = 0;
      p.wins = this.wins[p.id] ?? 0;
      this.spawnPlayer(p);
    }
  }

  private spawnPlayer(p: PlayerState): void {
    const spawns = this.level.spawns.length ? this.level.spawns : [[0.2, 0.2], [0.8, 0.2], [0.3, 0.2], [0.7, 0.2]];
    const idx = Math.abs(p.id) % spawns.length;
    const s = spawns[(this.players.indexOf(p) + spawns.length) % spawns.length] ?? spawns[idx % spawns.length];
    p.x = s[0] * WORLD_W;
    p.y = s[1] * WORLD_H - PH;
    p.vx = 0; p.vy = 0;
    p.hp = PLAYER_HP;
    p.alive = true;
  }

  private spawnDrop(): void {
    // Drops fall from the sky (original Stick Fight style): fixed x from the
    // level's drop spots, y near the top, gravity + sway do the rest.
    const spots = this.level.weaponDrops.length ? this.level.weaponDrops : [[0.5, 0.2]];
    const s = spots[this.dropIndex++ % spots.length];
    // Snakes are rare: ~7% of drops.
    const pool = Math.random() < 0.07 ? DROP_RARE : DROP_COMMON;
    const weapon = pool[(Math.random() * pool.length) | 0];
    if (this.drops.length >= MAX_DROPS) this.drops.shift();
    this.drops.push({
      x: s[0] * WORLD_W, y: WORLD_H * 0.02,
      vx: (Math.random() - 0.5) * 120, vy: 0,
      weapon, ammo: WEAPONS[weapon].mag,
    });
    this.events.push({ kind: "drop", text: weapon });
  }

  // ---- physics ----

  private solids(includeCrates = true): Solid[] {
    const out: Solid[] = [];
    for (const pl of this.level.platforms) {
      let on = true;
      if (pl.type === "blink") {
        const period = pl.period ?? 3, duty = pl.duty ?? 0.6, phase = pl.phase ?? 0;
        on = ((this.time + phase) % period) < period * duty;
      }
      if (!on) continue;
      out.push({
        x: pl.x * WORLD_W, y: pl.y * WORLD_H,
        w: pl.w * WORLD_W, h: pl.h * WORLD_H,
        type: pl.type ?? "static",
        beltPx: (pl.beltSpeed ?? 0) * WORLD_W,
      });
    }
    for (const m of this.level.movers ?? []) {
      const off = Math.sin((this.time * Math.PI * 2) / Math.max(0.1, m.period) + (m.phase ?? 0)) * m.range * (m.axis === "x" ? WORLD_W : WORLD_H);
      out.push({
        x: m.x * WORLD_W + (m.axis === "x" ? off : 0),
        y: m.y * WORLD_H + (m.axis === "y" ? off : 0),
        w: m.w * WORLD_W, h: m.h * WORLD_H, type: "mover",
        mi: (this.level.movers ?? []).indexOf(m),
      });
    }
    for (const r of this.level.rotators ?? []) {
      const a = this.time * r.angleSpeed;
      const pw = r.w * WORLD_W, ph = r.h * WORLD_H;
      const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      const bw = pw * c + ph * s, bh = pw * s + ph * c;
      out.push({ x: r.cx * WORLD_W - bw / 2, y: r.cy * WORLD_H - bh / 2, w: bw, h: bh, type: "rotator", ri: (this.level.rotators ?? []).indexOf(r) });
    }
    for (const c of this.crates) {
      if (includeCrates) out.push({ x: c.x, y: c.y, w: c.w, h: c.h, type: "static" });
    }
    return out;
  }

  /** Frame delta of mover #mi (pixel space), computed as pos(t) - pos(t-dt). */
  private moverDelta(mi: number, dt: number): { dx: number; dy: number } {
    const m = (this.level.movers ?? [])[mi];
    if (!m || dt <= 0) return { dx: 0, dy: 0 };
    const per = Math.max(0.1, m.period);
    const f = (t: number) => Math.sin((t * Math.PI * 2) / per + (m.phase ?? 0)) * m.range * (m.axis === "x" ? WORLD_W : WORLD_H);
    const d = f(this.time) - f(this.time - dt);
    return m.axis === "x" ? { dx: d, dy: 0 } : { dx: 0, dy: d };
  }

  /** Side-wall probe for wall-slide: solid adjacent on input side? */
  private touchingWall(p: PlayerState, solids: Solid[], dir: number): 1 | -1 | 0 {
    if (dir === 0) return 0;
    const px = p.x + dir * (PW / 2 + 2);
    const ys = [p.y + 8, p.y + PH / 2, p.y + PH - 4];
    for (const s of solids) {
      for (const y of ys) {
        if (px > s.x && px < s.x + s.w && y > s.y && y < s.y + s.h) return dir > 0 ? 1 : -1;
      }
    }
    return 0;
  }

  private movePlayer(p: PlayerState, inp: MatchInput, dt: number): void {
    const glued = (this.glues.get(p.id) ?? 0) > 0;
    const frosted = (this.frosts.get(p.id) ?? 0) > 0;
    const rawDir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    // Glued players cannot move (can still aim/fire/block).
    const dir = glued ? 0 : rawDir;
    if (dir !== 0) p.facing = dir;
    const accel = p.onGround ? 1 : AIR_CONTROL;
    const speedMult = frosted ? 0.5 : 1;
    const target = dir * MOVE_SPEED * speedMult;
    p.vx += (target - p.vx) * Math.min(1, (p.onGround ? 14 : 7) * accel * dt);
    if (glued && p.onGround) p.vx *= 1 - Math.min(1, 8 * dt);
    const solids = this.solids();
    // Wall-slide probe: airborne, falling, pressing into a side wall.
    // p.onGround / p.vy here still hold last tick's post-collision values.
    const lock = (this.wallLocks.get(p.id) ?? 0) - dt;
    this.wallLocks.set(p.id, Math.max(0, lock));
    const wallSide = !p.onGround && dir !== 0 && p.vy > 0 && lock <= 0
      ? this.touchingWall(p, solids, dir)
      : 0;
    const sliding = wallSide !== 0;
    (p as any).sliding = sliding;
    (p as any).wallDir = wallSide;
    p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * dt);
    // Slide friction: cap fall speed while sliding.
    if (sliding && !p.onGround && p.vy > WALL_SLIDE_CAP) p.vy = WALL_SLIDE_CAP;
    const wasGround = p.onGround;
    const prevJump = this.prevJump.get(p.id) ?? false;
    if (!glued && inp.jump && !prevJump && (p.onGround || this.propTop(p))) {
      p.vy = -JUMP_SPEED * (frosted ? 0.8 : 1);
      p.onGround = false;
      (p as any).sliding = false;
    } else if (!glued && inp.jump && !prevJump && sliding && !p.onGround) {
      // Wall-jump: push off away from the wall, slightly weaker vertically.
      p.vx = -wallSide * WALL_JUMP_VX;
      p.vy = -JUMP_SPEED * WALL_JUMP_VY_SCALE * (frosted ? 0.8 : 1);
      p.facing = p.vx >= 0 ? 1 : -1;
      p.onGround = false;
      (p as any).sliding = false;
      (p as any).wallDir = 0;
      this.wallLocks.set(p.id, WALL_LOCK);
    }
    void wasGround;

    // Substep integration so one frame can never tunnel through a thin wall.
    const dist = Math.max(Math.abs(p.vx * dt), Math.abs(p.vy * dt));
    const steps = Math.max(1, Math.min(8, Math.ceil(dist / 8)));
    const h = dt / steps;
    let ground: Solid | null = null;
    for (let st = 0; st < steps; st++) {
      // X axis (only when X motion caused the overlap — a pre-existing
      // vertical overlap from jumping up into a platform must not eject the
      // body sideways to the platform edge; Y owns that axis).
      const oldX = p.x;
      p.x += p.vx * h;
      for (const s of solids) {
        if (!this.overlap(p.x - PW / 2, p.y, PW, PH, s)) continue;
        if (this.overlap(oldX - PW / 2, p.y, PW, PH, s)) continue;
        if (p.vx > 0) p.x = s.x - PW / 2;
        else if (p.vx < 0) p.x = s.x + s.w + PW / 2;
        else {
          // No horizontal motion but X caused it (carried by a mover):
          // push out along the smallest penetration, not across the body.
          const penL = (p.x + PW / 2) - s.x;
          const penR = (s.x + s.w) - (p.x - PW / 2);
          p.x = penL < penR ? s.x - PW / 2 : s.x + s.w + PW / 2;
        }
        p.vx = 0;
      }
      // Y axis
      p.y += p.vy * h;
      p.onGround = false;
      ground = null;
      for (const s of solids) {
        if (this.overlap(p.x - PW / 2, p.y, PW, PH, s)) {
          if (p.vy > 0) {
            p.y = s.y - PH;
            p.vy = 0;
            p.onGround = true;
            ground = s;
          } else if (p.vy < 0) {
            p.y = s.y + s.h;
            p.vy = 0;
          } else {
            // Resting overlap with no velocity (spawned/carried inside):
            // escape along the smallest vertical penetration so the next
            // X pass never sees a stale overlap and teleports sideways.
            const penT = (p.y + PH) - s.y;
            const penB = (s.y + s.h) - p.y;
            if (penT < penB) { p.y = s.y - PH; p.vy = 0; p.onGround = true; ground = s; }
            else { p.y = s.y + s.h; p.vy = 0; }
          }
        }
      }
    }
    // Final depenetration: knockback / soft-push / carry can leave the body
    // inside a solid where the X "oldX" guard intentionally skips. Eject via
    // minimum penetration so sealed areas (Box Fort interior) stay sealed.
    this.depenetrate(p, solids);
    if (p.onGround) {
      (p as any).sliding = false;
      (p as any).wallDir = 0;
      // Mover carry: ride the platform's frame delta; rotators push tangentially.
      if (ground?.type === "mover" && ground.mi !== undefined) {
        const d = this.moverDelta(ground.mi, dt);
        p.x += d.dx;
        p.y += d.dy;
      } else if (ground?.type === "rotator" && ground.ri !== undefined) {
        const r = (this.level.rotators ?? [])[ground.ri];
        if (r) p.x += r.angleSpeed * ROTATOR_CARRY * dt;
      }
    }
    if (ground?.type === "bouncy") {
      p.vy = -1050;
      p.onGround = false;
    } else if (ground?.type === "conveyor") {
      p.x += (ground.beltPx ?? 0) * dt;
    } else if (ground?.type === "ice") {
      // keep sliding: re-add a bit of velocity
      p.vx *= 1 + Math.min(0.5, dt * 2);
    }
    if (inp.down && p.onGround) p.y += 2; // squeeze through thin decks next tick
    p.x = Math.max(-60, Math.min(WORLD_W + 60, p.x));
    // Mover / conveyor carry can shove the body into an adjacent wall.
    this.depenetrate(p, solids);
  }

  private overlap(x: number, y: number, w: number, h: number, s: Solid): boolean {
    return x < s.x + s.w && x + w > s.x && y < s.y + s.h && y + h > s.y;
  }

  /** Eject a body that ended inside a solid (knockback / soft-push / carry). */
  private depenetrate(p: PlayerState, solids: Solid[]): void {
    for (let iter = 0; iter < 4; iter++) {
      let hit: Solid | null = null;
      for (const s of solids) {
        if (this.overlap(p.x - PW / 2, p.y, PW, PH, s)) { hit = s; break; }
      }
      if (!hit) break;
      const s = hit;
      const penX = Math.min(p.x + PW / 2 - s.x, s.x + s.w - (p.x - PW / 2));
      const penY = Math.min(p.y + PH - s.y, s.y + s.h - p.y);
      if (penX < penY) {
        p.x = p.x < s.x + s.w / 2 ? s.x - PW / 2 : s.x + s.w + PW / 2;
        p.vx = 0;
      } else {
        if (p.y + PH / 2 < s.y + s.h / 2) {
          p.y = s.y - PH; p.vy = 0; p.onGround = true;
        } else {
          p.y = s.y + s.h; p.vy = 0;
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

  /** Coyote jump off landed gun drops / crate tops (stand-on-gun jumps). */
  private propTop(p: PlayerState): boolean {
    const feet = p.y + PH;
    for (const d of this.drops) {
      if (d.vy === 0 && Math.abs(d.x - p.x) < 30 && Math.abs(d.y - feet) <= 8) return true;
    }
    for (const c of this.crates) {
      if (p.x + PW / 2 > c.x && p.x - PW / 2 < c.x + c.w && Math.abs(feet - c.y) <= 8) return true;
    }
    return false;
  }

  private inLava(x: number, y: number): boolean {
    for (const pl of this.level.platforms) {
      if (pl.type !== "lava") continue;
      const sx = pl.x * WORLD_W, sy = pl.y * WORLD_H;
      if (x > sx && x < sx + pl.w * WORLD_W && y > sy && y < sy + pl.h * WORLD_H) return true;
    }
    for (const k of this.level.killRects ?? []) {
      if (k.kind !== "lava") continue;
      const sx = k.x * WORLD_W, sy = k.y * WORLD_H;
      if (x > sx && x < sx + k.w * WORLD_W && y > sy && y < sy + k.h * WORLD_H) return true;
    }
    return false;
  }

  // ---- combat ----

  private aimDir(p: PlayerState, inp: MatchInput): [number, number] {
    let dx = inp.aimX, dy = inp.aimY;
    if (dx === 0 && dy === 0) {
      dx = p.facing; dy = 0;
    }
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  private tryFire(p: PlayerState, inp: MatchInput): void {
    if (p.cooldown > 0 || !p.alive) return;
    const def = WEAPONS[p.weapon];
    const [dx, dy] = this.aimDir(p, inp);
    if (def.melee) {
      // Finite melee (sword/spear 25): broken at 0 -> fists. Fists infinite.
      if (p.weapon !== "fists" && p.ammo <= 0) {
        p.weapon = "fists"; p.ammo = 0;
        this.events.push({ kind: "break", a: p.id });
        return;
      }
      p.cooldown = def.melee.interval;
      const cx = p.x, cy = p.y + PH / 2;
      const aimAng = Math.atan2(dy, dx);
      const solids = this.solids();
      for (const q of this.players) {
        if (q.id === p.id || !q.alive) continue;
        const ddx = q.x - cx, ddy = q.y + PH / 2 - cy;
        const dist = Math.hypot(ddx, ddy);
        if (dist > def.melee.range + 20) continue;
        let da = Math.atan2(ddy, ddx) - aimAng;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        if (Math.abs(da) > def.melee.arc / 2 + 0.25) continue;
        // Walls block melee: no spear/sword/fist hits through a pillar into
        // a sealed area (Box Fort). Matches sniper cover behavior.
        if (this.segmentBlocked(cx, cy, q.x, q.y + PH / 2, solids)) continue;
        this.damage(q, def.damage, p.id, dx * def.knockback, -260, p.weapon, p.y + PH / 2 < q.y + PH * 0.25);
      }
      // Melee also cracks explosive barrels (same arc, walls block).
      for (let i = this.barrels.length - 1; i >= 0; i--) {
        const b = this.barrels[i];
        const c = this.barrelCenter(b);
        const ddx = c.x - cx, ddy = c.y - cy;
        if (Math.hypot(ddx, ddy) > def.melee.range + 20) continue;
        let da = Math.atan2(ddy, ddx) - aimAng;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        if (Math.abs(da) > def.melee.arc / 2 + 0.25) continue;
        if (this.segmentBlocked(cx, cy, c.x, c.y, solids)) continue;
        this.damageBarrel(i, def.damage, p.id);
      }
      // Punch-boost: airborne fists swing kicks the attacker (mobility).
      if (p.weapon === "fists" && !p.onGround) {
        p.vx += dx * 240;
        p.vy += dy * 180;
      }
      this.events.push({ kind: "swing", a: p.id });
      if (p.weapon !== "fists") {
        p.ammo--;
        if (p.ammo <= 0) {
          const broke = p.weapon;
          p.weapon = "fists"; p.ammo = 0;
          this.events.push({ kind: "break", a: p.id, text: broke });
        }
      }
      return;
    }
    if (def.beam) {
      // Sniper is hitscan (no projectiles) — matches LocalMode.
      if (p.ammo <= 0) {
        p.cooldown = 0.25;
        this.events.push({ kind: "dry", a: p.id });
        return;
      }
      this.fireBeam(p, dx, dy);
      return;
    }
    if (p.ammo <= 0) {
      p.cooldown = 0.25;
      this.events.push({ kind: "dry", a: p.id });
      return;
    }
    p.ammo--;
    const pellets = def.pellets ?? 1;
    const gx = p.x + dx * 24, gy = p.y + PH / 2 - 6 + dy * 24;
    // Quickdraw: firing within 0.35s of pickup gets zero spread.
    const qd = this.time - (this.lastPickup.get(p.id) ?? -10) < 0.35;
    const effSpread = qd ? 0 : def.spread;
    for (let i = 0; i < pellets; i++) {
      const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 2 * effSpread + (pellets > 1 ? (i / (pellets - 1) - 0.5) * 0.35 : 0);
      const sp = def.speed * (0.92 + Math.random() * 0.16);
      this.projectiles.push({
        id: this.nextProjId++, kind: p.weapon,
        x: gx, y: gy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: def.life ?? 2, owner: p.id, bounces: def.bounce ?? 0,
        damage: def.damage,
        gravity: def.gravity,
        explosiveDmg: def.explosive?.damage,
        explosiveRadius: def.explosive?.radius,
        fuse: p.weapon === "grenade" ? 1.6 : undefined,
      });
    }
    p.vx -= dx * def.recoil;
    p.vy -= dy * def.recoil * 0.5;
    p.cooldown = def.interval;
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

  private fireBeam(p: PlayerState, dx: number, dy: number): void {
    const def = WEAPONS[p.weapon];
    const sx = p.x, sy = p.y + PH / 2 - 6;
    const maxD = 2200;
    // Sniper is stopped by cover.
    const wallD = this.rayWallDist(sx, sy, dx, dy, maxD);
    const hits: { q: PlayerState; t: number }[] = [];
    for (const q of this.players) {
      if (q.id === p.id || !q.alive) continue;
      const rx = q.x - sx, ry = q.y + PH / 2 - sy;
      const t = rx * dx + ry * dy;
      if (t < 0 || t > wallD) continue;
      if (Math.abs(rx * dy - ry * dx) >= 22) continue;
      hits.push({ q, t });
    }
    hits.sort((a, b) => a.t - b.t);
    // Barrels block the beam too: nearest barrel inside the corridor detonates.
    let barrelIdx = -1, barrelT = Infinity;
    for (let i = 0; i < this.barrels.length; i++) {
      const c = this.barrelCenter(this.barrels[i]);
      const rx = c.x - sx, ry = c.y - sy;
      const t = rx * dx + ry * dy;
      if (t < 0 || t > wallD) continue;
      if (Math.abs(rx * dy - ry * dx) >= 18) continue;
      if (t < barrelT) { barrelT = t; barrelIdx = i; }
    }
    const playerT = hits.length ? hits[0].t : Infinity;
    let endD = wallD;
    if (barrelIdx >= 0 && barrelT <= playerT) {
      this.damageBarrel(barrelIdx, def.damage, p.id);
      endD = barrelT;
    } else {
      const targets = hits.slice(0, 1);
      for (const h of targets) this.damage(h.q, def.damage, p.id, dx * def.knockback, -220, p.weapon, sy + dy * h.t < h.q.y + PH * 0.25);
      endD = targets.length ? targets[0].t : wallD;
    }
    // Short tracer so remote clients see the beam (zero damage: skipped by hit code).
    this.projectiles.push({
      id: this.nextProjId++, kind: p.weapon,
      x: sx + dx * endD, y: sy + dy * endD, vx: 0, vy: 0,
      life: 0.15, owner: p.id, bounces: 0, damage: 0,
    });
    p.ammo--;
    // Recoil-fly: firing down lifts the shooter (minigun jetpack included).
    p.vx -= dx * def.recoil;
    p.vy -= dy * def.recoil * 0.5;
    p.cooldown = def.interval;
    this.events.push({ kind: "beam", a: p.id, text: p.weapon });
  }

  private tryThrow(p: PlayerState, inp: MatchInput): void {
    if (p.weapon === "fists" || p.cooldown > 0 || !p.alive) return;
    const [dx, dy] = this.aimDir(p, inp);
    const sp = 1050;
    this.projectiles.push({
      id: this.nextProjId++, kind: p.weapon,
      x: p.x + dx * 24, y: p.y + PH / 2 - 6,
      vx: dx * sp + p.vx * 0.4, vy: dy * sp - 120,
      life: 1.4, owner: p.id, bounces: 0,
      damage: THROW_DAMAGE, thrown: true, ammo: p.ammo,
    });
    this.events.push({ kind: "throw", a: p.id, text: p.weapon });
    p.weapon = "fists";
    p.ammo = 0;
    p.cooldown = 0.5;
  }

  private tryPickup(p: PlayerState): void {
    if (!p.alive || p.weapon !== "fists") return;
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      if (Math.abs(d.x - p.x) < 34 && Math.abs(d.y - (p.y + PH / 2)) < 48) {
        p.weapon = d.weapon;
        p.ammo = d.ammo;
        this.drops.splice(i, 1);
        this.events.push({ kind: "pickup", a: p.id, text: d.weapon });
        this.lastPickup.set(p.id, this.time);
        return;
      }
    }
  }

  private damage(q: PlayerState, dmg: number, fromId: number, kx: number, ky: number, cause = "fists", headshot = false): void {
    if (!q.alive) return;
    let final = dmg;
    // Headshot x2: hit within top 25% of victim AABB (top-based y, PH tall).
    if (headshot) final *= 2;
    if (this.blocking.get(q.id)) {
      // Block reduces damage by 65% when facing the attacker.
      const attacker = this.players.find((p) => p.id === fromId);
      if (!attacker || Math.sign(attacker.x - q.x) === q.facing || attacker.x === q.x) final *= 0.35;
      else final *= 1;
    }
    q.hp -= final;
    const kbMult = this.blocking.get(q.id) ? 0.4 : 1;
    q.vx += kx * kbMult;
    q.vy += ky;
    if (q.hp <= 0) {
      q.hp = 0;
      q.alive = false;
      this.frosts.delete(q.id);
      this.glues.delete(q.id);
      this.burns.delete(q.id);
      this.burnOwners.delete(q.id);
      const killer = this.players.find((p) => p.id === fromId);
      if (killer && killer.id !== q.id) {
        killer.kills++;
        this.events.push({ kind: "kill", text: `${killer.name} ▸ ${q.name} [${cause}]`, a: killer.id, b: q.id });
      } else {
        this.events.push({ kind: "death", text: `${q.name} died [${cause}]`, a: q.id, b: q.id });
      }
    }
  }

  private barrelCenter(b: BarrelState): { x: number; y: number } {
    return { x: b.x + BARREL_W / 2, y: b.y + BARREL_H / 2 };
  }

  /** Damage a barrel by index; detonates (removes + explodes) at 0 hp. */
  private damageBarrel(index: number, dmg: number, owner: number): void {
    const b = this.barrels[index];
    if (!b) return;
    b.hp -= dmg;
    if (b.hp > 0) return;
    const c = this.barrelCenter(b);
    this.barrels.splice(index, 1);
    this.explode(c.x, c.y, BARREL_BLAST_R, BARREL_BLAST_DMG, owner);
  }

  private explode(x: number, y: number, radius: number, dmg: number, owner: number): void {
    this.events.push({ kind: "explode", a: owner, x, y });
    const solids = this.solids();
    for (const q of this.players) {
      if (!q.alive) continue;
      const d = Math.hypot(q.x - x, q.y + PH / 2 - y);
      if (d > radius + 20) continue;
      // Blast is blocked by walls: no knocking victims through a pillar into
      // sealed areas. Matches sniper cover behavior.
      if (this.segmentBlocked(x, y, q.x, q.y + PH / 2, solids)) continue;
      const fall = 1 - (d / (radius + 20)) * 0.5;
      const a = Math.atan2(q.y + PH / 2 - y, q.x - x);
      // RPG self-damage cap: own blast capped at 50 so point-blank isn't
      // always suicide at 100HP (canonical 150 direct + radius vs others).
      const dealt = q.id === owner ? Math.min(dmg * fall, 50) : dmg * fall;
      this.damage(q, dealt, owner, Math.cos(a) * 620, Math.sin(a) * 620 - 200, "explosion");
    }
    // Chain-detonate barrels caught in the blast (walls block the fuse).
    // Collect first so splice-then-explode recursion terminates.
    const chained: { x: number; y: number }[] = [];
    for (let i = this.barrels.length - 1; i >= 0; i--) {
      const b = this.barrels[i];
      const c = this.barrelCenter(b);
      if (Math.hypot(c.x - x, c.y - y) > radius + 15) continue;
      if (this.segmentBlocked(x, y, c.x, c.y, solids)) continue;
      this.barrels.splice(i, 1);
      chained.push(c);
    }
    for (const c of chained) this.explode(c.x, c.y, BARREL_BLAST_R, BARREL_BLAST_DMG, owner);
  }

  private steerSnake(pr: Proj, dt: number): void {
    let bx = 0, by = 0, bd = Infinity, found = false;
    for (const q of this.players) {
      if (!q.alive || q.id === pr.owner) continue;
      const d = Math.hypot(q.x - pr.x, q.y + PH / 2 - pr.y);
      if (d < bd) { bd = d; bx = q.x; by = q.y + PH / 2; found = true; }
    }
    if (!found) return;
    const speed = Math.hypot(pr.vx, pr.vy) || 260;
    const cur = Math.atan2(pr.vy, pr.vx);
    const want = Math.atan2(by - pr.y, bx - pr.x);
    let da = want - cur;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const maxTurn = 3 * dt;
    const na = cur + Math.max(-maxTurn, Math.min(maxTurn, da));
    pr.vx = Math.cos(na) * speed;
    pr.vy = Math.sin(na) * speed;
  }

  private stepProjectiles(dt: number): void {
    const solids = this.solids();
    const keep: Proj[] = [];
    for (const pr of this.projectiles) {
      pr.life -= dt;
      if (pr.kind === "snake" || pr.kind === "snakeshot") this.steerSnake(pr, dt);
      if (pr.gravity) pr.vy += pr.gravity * dt;
      // Grenade fuse: blows up mid-air like LocalMode (no protocol change).
      if (pr.fuse !== undefined && pr.fuse > 0) {
        pr.fuse -= dt;
        if (pr.fuse <= 0) {
          if (pr.explosiveDmg && pr.explosiveRadius) this.explode(pr.x, pr.y, pr.explosiveRadius, pr.explosiveDmg, pr.owner);
          continue;
        }
      }
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      let dead = pr.life <= 0;
      let hitSolid: Solid | null = null;
      for (const s of solids) {
        if (pr.x >= s.x && pr.x <= s.x + s.w && pr.y >= s.y && pr.y <= s.y + s.h) {
          hitSolid = s;
          break;
        }
      }
      // barrels (center-based AABB so hits match the drawn 22x30 rect;
      // tracers carry 0 damage and never fuse barrels — sniper uses fireBeam).
      for (let i = this.barrels.length - 1; i >= 0; i--) {
        const b = this.barrels[i];
        if (pr.damage <= 0 && !pr.thrown) continue;
        const c = this.barrelCenter(b);
        if (Math.abs(pr.x - c.x) < BARREL_W / 2 + 5 && Math.abs(pr.y - c.y) < BARREL_H / 2 + 5) {
          const chip = pr.thrown ? THROW_DAMAGE : Math.max(BARREL_CHIP, pr.damage);
          dead = true;
          this.damageBarrel(i, chip, pr.owner);
          break;
        }
      }
      // crates: weapon projectiles push boxes, never destroy them.
      // Beam tracers carry 0 damage and skip (visual only, like player hits).
      if (pr.damage > 0) {
        for (const c of this.crates) {
          if (pr.x >= c.x && pr.x <= c.x + c.w && pr.y >= c.y && pr.y <= c.y + c.h) {
            const def = WEAPONS[pr.kind as WeaponId];
            const base = pr.thrown ? 380 : (def?.knockback ?? 320);
            const l = Math.hypot(pr.vx, pr.vy) || 1;
            const nx = pr.vx / l;
            const ny = pr.vy / l;
            c.vx += nx * base * 0.6;
            c.vy += ny * base * 0.3;
            if (c.vx > 600) c.vx = 600;
            else if (c.vx < -600) c.vx = -600;
            if (c.vy > 600) c.vy = 600;
            else if (c.vy < -600) c.vy = -600;
            dead = true;
            break;
          }
        }
      }
      if (hitSolid && !dead) {
        if ((pr.bounces ?? 0) > 0) {
          pr.bounces!--;
          // bounce off dominant axis
          const cx = hitSolid.x + hitSolid.w / 2;
          if (Math.abs(pr.x - cx) > hitSolid.w / 4) pr.vx *= -1;
          else pr.vy *= -1;
          pr.x += pr.vx * dt * 2;
          pr.y += pr.vy * dt * 2;
        } else if (pr.thrown) {
          // Thrown guns land as pickups again (matches LocalMode).
          this.drops.push({ x: pr.x, y: pr.y, vx: 0, vy: -60, weapon: pr.kind, ammo: pr.ammo ?? WEAPONS[pr.kind].mag });
          dead = true;
        } else {
          dead = true;
        }
      }
      // player hits (never the owner; tracers carry 0 damage and skip)
      if (!dead && pr.damage > 0) {
        for (const q of this.players) {
          if (!q.alive || q.id === pr.owner) continue;
          if (Math.abs(pr.x - q.x) < PW / 2 + 6 && pr.y > q.y - 6 && pr.y < q.y + PH + 6) {
            const a = Math.atan2(pr.vy, pr.vx);
            const head = pr.y > q.y - 6 && pr.y < q.y + PH * 0.25;
            this.damage(q, pr.damage, pr.owner, Math.cos(a) * 380, Math.sin(a) * 200 - 120, pr.thrown ? "thrown" : String(pr.kind), head);
            if (pr.thrown) this.drops.push({ x: pr.x, y: pr.y - 10, vx: pr.vx * 0.2, vy: -150, weapon: pr.kind, ammo: pr.ammo ?? WEAPONS[pr.kind].mag });
            else if (String(pr.kind) === "flamethrower") {
              this.burns.set(q.id, 1.2);
              this.burnOwners.set(q.id, pr.owner);
            } else if (String(pr.kind) === "ice") {
              this.frosts.set(q.id, 2);
            } else if (String(pr.kind) === "glue") {
              this.glues.set(q.id, Math.min(3, (this.glues.get(q.id) ?? 0) + 1));
            }
            dead = true;
            break;
          }
        }
      }
      if (dead && pr.explosiveDmg && pr.explosiveRadius) {
        this.explode(pr.x, pr.y, pr.explosiveRadius, pr.explosiveDmg, pr.owner);
      } else if (!dead) {
        if (pr.x > -100 && pr.x < WORLD_W + 100 && pr.y > -200 && pr.y < WORLD_H + 200) keep.push(pr);
      }
    }
    this.projectiles = keep;
  }

  private stepCrates(dt: number): void {
    // Static solids WITHOUT crates (platforms/movers/rotators). Crate-vs-crate
    // is resolved explicitly below so stacked boxes (e.g. Chandelier's pyramid)
    // land on each other instead of falling through.
    const statics = this.solids(false);
    const overlaps = (
      a: { x: number; y: number; w: number; h: number },
      b: { x: number; y: number; w: number; h: number },
    ): boolean =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const c of this.crates) {
      c.vy = Math.min(MAX_FALL, c.vy + GRAVITY * 0.7 * dt);
      c.x += c.vx * dt;
      c.vx *= 1 - Math.min(1, 3 * dt);
      if (c.x < 0) { c.x = 0; c.vx = 0; }
      if (c.x + c.w > WORLD_W) { c.x = WORLD_W - c.w; c.vx = 0; }
      c.y += c.vy * dt;
      for (const s of statics) {
        if (!overlaps(c, s)) continue;
        if (c.vy >= 0 && c.y < s.y && c.y + c.h - s.y < 24) {
          c.y = s.y - c.h;
          c.vy = 0;
        } else {
          const ox = Math.min(c.x + c.w, s.x + s.w) - Math.max(c.x, s.x);
          const oy = Math.min(c.y + c.h, s.y + s.h) - Math.max(c.y, s.y);
          if (ox < oy) {
            if (c.x + c.w / 2 < s.x + s.w / 2) c.x = s.x - c.w;
            else c.x = s.x + s.w;
            c.vx = 0;
          } else if (c.y + c.h / 2 < s.y + s.h / 2) {
            c.y = s.y - c.h;
            c.vy = 0;
          } else {
            c.y = s.y + s.h;
            if (c.vy < 0) c.vy = 0;
          }
        }
      }
      if (c.y > WORLD_H + 200) {
        c.y = -40; c.vy = 0;
      }
    }
    // Crate-on-crate stacking: several passes so a pyramid settles. Only the
    // UPPER crate moves (lands on the lower one); the lower crate never gets
    // pushed down, otherwise the bottom dodges and the top falls through.
    // Same-level overlaps resolve horizontally so side-by-side boxes separate.
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (let i = 0; i < this.crates.length; i++) {
        const c = this.crates[i];
        for (let j = 0; j < this.crates.length; j++) {
          if (i === j) continue;
          const o = this.crates[j];
          if (!overlaps(c, o)) continue;
          const cMidY = c.y + c.h / 2;
          const oMidY = o.y + o.h / 2;
          if (cMidY < oMidY - 1) {
            // c is above o: land on top (or push sideways on a graze).
            const xOverlap = Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x);
            if (c.vy >= 0 && xOverlap > 8) {
              const ny = o.y - c.h;
              if (Math.abs(ny - c.y) > 0.01) moved = true;
              c.y = ny;
              c.vy = 0;
            } else if (c.y < o.y && c.y + c.h - o.y < 24 && c.vy >= 0) {
              const ny = o.y - c.h;
              if (Math.abs(ny - c.y) > 0.01) moved = true;
              c.y = ny;
              c.vy = 0;
            } else {
              const ox = Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x);
              const oy = Math.min(c.y + c.h, o.y + o.h) - Math.max(c.y, o.y);
              if (ox < oy) {
                if (c.x + c.w / 2 < o.x + o.w / 2) c.x = o.x - c.w;
                else c.x = o.x + o.w;
                c.vx = 0;
                moved = true;
              } else {
                c.y = o.y - c.h;
                c.vy = 0;
                moved = true;
              }
            }
          } else if (cMidY > oMidY + 1) {
            // c is below o (o rests on c): leave c alone, o's pass lands it.
            continue;
          } else {
            // Same level: separate along the minimal axis (side-by-side).
            const ox = Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x);
            const oy = Math.min(c.y + c.h, o.y + o.h) - Math.max(c.y, o.y);
            if (ox < oy) {
              if (c.x + c.w / 2 < o.x + o.w / 2) c.x = o.x - c.w;
              else c.x = o.x + o.w;
              c.vx = 0;
              moved = true;
            } else if (c.y + c.h / 2 < o.y + o.h / 2) {
              c.y = o.y - c.h;
              c.vy = 0;
              moved = true;
            } else if (c.y + c.h / 2 > o.y + o.h / 2) {
              continue;
            } else if (c.x + c.w / 2 < o.x + o.w / 2) {
              c.x = o.x - c.w;
              c.vx = 0;
              moved = true;
            } else {
              c.x = o.x + o.w;
              c.vx = 0;
              moved = true;
            }
          }
        }
      }
      if (!moved) break;
    }
    for (const c of this.crates) {
      if (c.x < 0) { c.x = 0; c.vx = 0; }
      if (c.x + c.w > WORLD_W) { c.x = WORLD_W - c.w; c.vx = 0; }
    }
  }

  private stepBarrels(dt: number): void {
    // Barrels fall and rest on platforms / movers / crates (top-left anchored
    // 22x30). Without this the Showdown barrels hover where the level file
    // spawns them (~27px above their perch).
    const statics = this.solids(false);
    const overlaps = (
      a: { x: number; y: number; w: number; h: number },
      b: { x: number; y: number; w: number; h: number },
    ): boolean =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const b of this.barrels) {
      b.vy = Math.min(MAX_FALL, (b.vy ?? 0) + GRAVITY * dt);
      b.x += (b.vx ?? 0) * dt;
      b.vx = (b.vx ?? 0) * (1 - Math.min(1, 3 * dt));
      if (Math.abs(b.vx ?? 0) < 4) b.vx = 0;
      if (b.x < 0) { b.x = 0; b.vx = 0; }
      if (b.x + BARREL_W > WORLD_W) { b.x = WORLD_W - BARREL_W; b.vx = 0; }
      b.y += (b.vy ?? 0) * dt;
      const box = (): { x: number; y: number; w: number; h: number } =>
        ({ x: b.x, y: b.y, w: BARREL_W, h: BARREL_H });
      for (const s of statics) {
        if (!overlaps(box(), s)) continue;
        if ((b.vy ?? 0) >= 0 && b.y < s.y && b.y + BARREL_H - s.y < 24) {
          b.y = s.y - BARREL_H;
          b.vy = 0;
        } else {
          const cur = box();
          const ox = Math.min(cur.x + cur.w, s.x + s.w) - Math.max(cur.x, s.x);
          const oy = Math.min(cur.y + cur.h, s.y + s.h) - Math.max(cur.y, s.y);
          if (ox < oy) {
            if (cur.x + cur.w / 2 < s.x + s.w / 2) b.x = s.x - BARREL_W;
            else b.x = s.x + s.w;
            b.vx = 0;
          } else if (cur.y + cur.h / 2 < s.y + s.h / 2) {
            b.y = s.y - BARREL_H;
            b.vy = 0;
          } else {
            b.y = s.y + s.h;
            if ((b.vy ?? 0) < 0) b.vy = 0;
          }
        }
      }
      // Rest on crates (barrel never pushes the crate down).
      for (const cr of this.crates) {
        if (!overlaps(box(), cr)) continue;
        if ((b.vy ?? 0) >= 0 && b.y + BARREL_H / 2 < cr.y + cr.h / 2) {
          b.y = cr.y - BARREL_H;
          b.vy = 0;
        }
      }
      if (b.y > WORLD_H + 200) { b.y = -40; b.vy = 0; }
    }
  }

  private stepDrops(dt: number): void {
    const solids = this.solids();
    const keep: DroppedGun[] = [];
    for (const d of this.drops) {
      d.vy = Math.min(MAX_FALL, d.vy + GRAVITY * 0.7 * dt);
      // Parachute sway while falling (original-style drop-in).
      if (d.vy !== 0) d.x += Math.sin(this.time * 3 + d.y * 0.02) * 40 * dt;
      d.x += d.vx * dt;
      d.vx *= 1 - Math.min(1, 2 * dt);
      d.y += d.vy * dt;
      for (const s of solids) {
        if (d.x > s.x - 8 && d.x < s.x + s.w + 8 && d.y > s.y - 6 && d.y < s.y + s.h) {
          if (d.vy > 0) {
            d.y = s.y - 4;
            d.vy = -d.vy * 0.35; // small bounce on landing
            if (Math.abs(d.vy) < 60) d.vy = 0;
            d.vx *= 0.6;
          }
        }
      }
      // Lava/void swallows the drop: a fresh one falls from the sky after 3s.
      if (d.y > WORLD_H + 40 || this.inLava(d.x, d.y)) {
        this.dropRespawns.push(3);
        continue;
      }
      keep.push(d);
    }
    this.drops = keep;
  }

  private checkHazards(p: PlayerState): void {
    if (!p.alive) return;
    // void / out of bounds
    if (p.y > WORLD_H + 80 || p.x < -200 || p.x > WORLD_W + 200) {
      p.hp = 0; p.alive = false;
      this.events.push({ kind: "death", text: `${p.name} died [fell]`, a: p.id, b: p.id });
      return;
    }
    const body = { x: p.x - PW / 2, y: p.y, w: PW, h: PH };
    // lava platforms
    for (const pl of this.level.platforms) {
      if (pl.type !== "lava") continue;
      const s = { x: pl.x * WORLD_W, y: pl.y * WORLD_H, w: pl.w * WORLD_W, h: pl.h * WORLD_H };
      if (body.x < s.x + s.w && body.x + body.w > s.x && body.y < s.y + s.h && body.y + body.h > s.y) {
        p.hp = 0; p.alive = false;
        this.events.push({ kind: "death", text: `${p.name} died [lava]`, a: p.id, b: p.id });
        return;
      }
    }
    // kill rects (spikes / lava / gated laser)
    for (const k of this.level.killRects ?? []) {
      let active = true;
      if (k.kind === "laser" && k.period) {
        active = ((this.time + (k.phase ?? 0)) % k.period) < k.period * (k.duty ?? 0.5);
      }
      if (!active) continue;
      const s = { x: k.x * WORLD_W, y: k.y * WORLD_H, w: k.w * WORLD_W, h: k.h * WORLD_H };
      if (body.x < s.x + s.w && body.x + body.w > s.x && body.y < s.y + s.h && body.y + body.h > s.y) {
        p.hp = 0; p.alive = false;
        this.events.push({ kind: "death", text: `${p.name} died [${k.kind}]`, a: p.id, b: p.id });
        return;
      }
    }
  }

  private checkRound(dt: number): void {
    if (this.resetTimer >= 0) {
      this.resetTimer -= dt;
      if (this.resetTimer < 0) {
        this.round++;
        // Random (non-sequential) next arena, like the original.
        if (this.cycle.length > 1) {
          let n = this.cycleIndex;
          do { n = (Math.random() * this.cycle.length) | 0; } while (n === this.cycleIndex);
          this.cycleIndex = n;
        }
        this.level = this.cycle[this.cycleIndex];
        // A finished match (first to 5) resets wins here so the matchEnd
        // broadcast still carries the final tally.
        if (Object.values(this.wins).some((w) => w >= this.winScore)) this.wins = {};
        this.resetArena(); // clears projectiles, fresh spawns
        this.events.push({ kind: "round", text: this.level.name, a: this.round });
      }
      return;
    }
    if (this.players.length < 2) return;
    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1 && this.time > 0.5) {
      const winner = alive[0];
      if (winner) {
        this.wins[winner.id] = (this.wins[winner.id] ?? 0) + 1;
        winner.wins = this.wins[winner.id];
        this.events.push({ kind: "roundEnd", text: `${winner.name} (${this.wins[winner.id]}/${this.winScore})`, a: winner.id, b: this.round });
        if (this.wins[winner.id] >= this.winScore) {
          this.events.push({ kind: "matchEnd", text: winner.name, a: winner.id });
        }
      } else {
        this.events.push({ kind: "roundEnd", text: "draw", a: -1, b: this.round });
      }
      this.resetTimer = 1.5;
    }
  }

  // ---- bots ----

  private botInput(p: PlayerState): MatchInput {
    const inp = emptyInput();
    const foes = this.players.filter((q) => q.id !== p.id && q.alive);
    if (!foes.length) return inp;
    let target = foes[0];
    let best = Infinity;
    for (const q of foes) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < best) {
        best = d;
        target = q;
      }
    }
    // prefer a nearby gun when unarmed
    if (p.weapon === "fists") {
      let bd = 260;
      for (const d of this.drops) {
        const dd = Math.hypot(d.x - p.x, d.y - p.y);
        if (dd < bd) {
          bd = dd;
          target = { ...target, x: d.x, y: d.y + 20 };
        }
      }
    }
    const dx = target.x - p.x;
    inp.left = dx < -12;
    inp.right = dx > 12;
    if (target.y < p.y - 60 && p.onGround) inp.jump = true;
    else if (Math.random() < 0.01 && p.onGround) inp.jump = true; // occasional hop
    const ax = target.x - p.x, ay = target.y + PH / 2 - (p.y + PH / 2 - 6);
    const dist = Math.hypot(ax, ay);
    inp.aimX = ax;
    inp.aimY = ay;
    const melee = WEAPONS[p.weapon].melee;
    if (melee) inp.fire = dist < melee.range + 10;
    else if (p.ammo > 0) inp.fire = dist < 700 && Math.random() < 0.75;
    // Bots wall-jump when sliding (sliding flag is refreshed each tick in movePlayer).
    if ((p as any).sliding && (this.wallLocks.get(p.id) ?? 0) <= 0) inp.jump = true;
    return inp;
  }
}

// ---- canonical level pack (single source of truth: src/levels/levels.ts) ----

export function getBuiltinLevel(id: string): LevelDef {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}

export function getBuiltinCycle(): LevelDef[] {
  return [...LEVELS];
}
