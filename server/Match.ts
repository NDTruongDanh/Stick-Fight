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
const WIN_SCORE = 5;
const DROP_INTERVAL = 4;
const MAX_DROPS = 6;
const THROW_DAMAGE = 55;

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
  // Per-weapon projectile tuning not present in the canonical defs
  // (fuse / gravity / life / bounce are mode-level behavior).
  const tune: Record<WeaponId, Partial<GunDef>> = {
    fists: {},
    pistol: { life: 2 },
    revolver: { life: 2 },
    deagle: { life: 2 },
    uzi: { life: 2 },
    ak47: { life: 2 },
    m16: { life: 2 },
    sniper: { life: 2 },
    shotgun: { life: 1.4 },
    sawedoff: { life: 1.2 },
    bouncer: { life: 2.5, bounce: 6 },
    minigun: { life: 2 },
    grenade: { life: 3.2, gravity: 1500, explosive: { radius: 130, damage: 65 } },
    rpg: { life: 3, gravity: 200, explosive: { radius: 150, damage: 80 } },
    flamethrower: { life: 0.28 },
    sword: {},
    spear: {},
    laser: { life: 2 },
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
    };
  });
  return out;
}

const DROP_CYCLE: WeaponId[] = [
  "pistol", "shotgun", "uzi", "ak47", "sniper", "revolver", "deagle",
  "grenade", "rpg", "sword", "spear", "minigun", "laser", "bouncer",
  "sawedoff", "flamethrower", "m16",
];

interface Proj extends ProjectileState {
  damage: number;
  thrown?: boolean;
  gravity?: number;
  explosiveDmg?: number;
  explosiveRadius?: number;
}

interface Solid {
  x: number; y: number; w: number; h: number;
  type?: string;
  beltPx?: number;
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
  private resetTimer = -1;
  private prevJump = new Map<number, boolean>();
  private prevThrow = new Map<number, boolean>();
  private blocking = new Map<number, boolean>();
  private cycle: LevelDef[];
  private cycleIndex = 0;

  constructor(level: LevelDef, opts?: { cycle?: LevelDef[] }) {
    this.level = level;
    this.cycle = opts?.cycle?.length ? opts.cycle : [level];
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
      if (inp.fire) this.tryFire(p, inp);
      this.tryPickup(p);
      this.checkHazards(p);
    }

    this.stepProjectiles(dt);
    this.stepCrates(dt);
    this.stepDrops(dt);
    this.checkRound(dt);
  }

  // ---- setup ----

  private resetArena(): void {
    this.projectiles = [];
    this.drops = [];
    this.dropTimer = 2;
    this.crates = (this.level.crates ?? []).map((c) => ({
      x: (c.x * WORLD_W) | 0, y: (c.y * WORLD_H) | 0,
      w: Math.max(20, c.w * WORLD_W), h: Math.max(20, c.h * WORLD_H),
      vx: 0, vy: 0, angle: 0,
    }));
    this.barrels = (this.level.barrels ?? []).map((b) => ({
      x: b.x * WORLD_W, y: b.y * WORLD_H, hp: 50,
    }));
    for (const p of this.players) {
      p.hp = PLAYER_HP; p.alive = true; p.vx = 0; p.vy = 0;
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
    const spots = this.level.weaponDrops.length ? this.level.weaponDrops : [[0.5, 0.2]];
    const s = spots[this.dropIndex++ % spots.length];
    const weapon = DROP_CYCLE[(Math.random() * DROP_CYCLE.length) | 0];
    if (this.drops.length >= MAX_DROPS) this.drops.shift();
    this.drops.push({
      x: s[0] * WORLD_W, y: s[1] * WORLD_H,
      vx: (Math.random() - 0.5) * 120, vy: -80,
      weapon, ammo: WEAPONS[weapon].mag * 2 || WEAPONS[weapon].mag,
    });
    this.events.push({ kind: "drop", text: weapon });
  }

  // ---- physics ----

  private solids(): Solid[] {
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
        w: m.w * WORLD_W, h: m.h * WORLD_H, type: "static",
      });
    }
    for (const r of this.level.rotators ?? []) {
      const a = this.time * r.angleSpeed;
      const pw = r.w * WORLD_W, ph = r.h * WORLD_H;
      const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      const bw = pw * c + ph * s, bh = pw * s + ph * c;
      out.push({ x: r.cx * WORLD_W - bw / 2, y: r.cy * WORLD_H - bh / 2, w: bw, h: bh, type: "rotator" });
    }
    for (const c of this.crates) out.push({ x: c.x, y: c.y, w: c.w, h: c.h, type: "static" });
    return out;
  }

  private movePlayer(p: PlayerState, inp: MatchInput, dt: number): void {
    const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    if (dir !== 0) p.facing = dir;
    const accel = p.onGround ? 1 : AIR_CONTROL;
    const target = dir * MOVE_SPEED;
    p.vx += (target - p.vx) * Math.min(1, (p.onGround ? 14 : 7) * accel * dt);
    p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * dt);
    const wasGround = p.onGround;
    const prevJump = this.prevJump.get(p.id) ?? false;
    if (inp.jump && !prevJump && p.onGround) {
      p.vy = -JUMP_SPEED;
      p.onGround = false;
    }
    void wasGround;

    const solids = this.solids();
    // X axis
    p.x += p.vx * dt;
    for (const s of solids) {
      if (this.overlap(p.x - PW / 2, p.y, PW, PH, s)) {
        if (p.vx > 0) p.x = s.x - PW / 2;
        else if (p.vx < 0) p.x = s.x + s.w + PW / 2;
        p.vx = 0;
      }
    }
    // Y axis
    p.y += p.vy * dt;
    p.onGround = false;
    let ground: Solid | null = null;
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
        }
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
  }

  private overlap(x: number, y: number, w: number, h: number, s: Solid): boolean {
    return x < s.x + s.w && x + w > s.x && y < s.y + s.h && y + h > s.y;
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
      p.cooldown = def.melee.interval;
      const cx = p.x, cy = p.y + PH / 2;
      const aimAng = Math.atan2(dy, dx);
      for (const q of this.players) {
        if (q.id === p.id || !q.alive) continue;
        const ddx = q.x - cx, ddy = q.y + PH / 2 - cy;
        const dist = Math.hypot(ddx, ddy);
        if (dist > def.melee.range + 20) continue;
        let da = Math.atan2(ddy, ddx) - aimAng;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        if (Math.abs(da) > def.melee.arc / 2 + 0.25) continue;
        this.damage(q, def.damage, p.id, dx * def.knockback, -260);
      }
      // Punch-boost: airborne fists swing kicks the attacker (mobility).
      if (p.weapon === "fists" && !p.onGround) {
        p.vx += dx * 240;
        p.vy += dy * 180;
      }
      this.events.push({ kind: "swing", a: p.id });
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
    for (let i = 0; i < pellets; i++) {
      const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 2 * def.spread + (pellets > 1 ? (i / (pellets - 1) - 0.5) * 0.35 : 0);
      const sp = def.speed * (0.92 + Math.random() * 0.16);
      this.projectiles.push({
        id: this.nextProjId++, kind: p.weapon,
        x: gx, y: gy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: def.life ?? 2, owner: p.id, bounces: def.bounce ?? 0,
        damage: def.damage,
        gravity: def.gravity,
        explosiveDmg: def.explosive?.damage,
        explosiveRadius: def.explosive?.radius,
      });
    }
    p.vx -= dx * def.recoil;
    p.vy -= dy * def.recoil * 0.5;
    p.cooldown = def.interval;
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
      damage: THROW_DAMAGE, thrown: true,
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
        return;
      }
    }
  }

  private damage(q: PlayerState, dmg: number, fromId: number, kx: number, ky: number): void {
    if (!q.alive) return;
    let final = dmg;
    if (this.blocking.get(q.id)) {
      // Block reduces damage by 65% when facing the attacker.
      const attacker = this.players.find((p) => p.id === fromId);
      if (!attacker || Math.sign(attacker.x - q.x) === q.facing || attacker.x === q.x) final *= 0.35;
      else final *= 1;
    }
    q.hp -= final;
    q.vx += kx * (this.blocking.get(q.id) ? 0.4 : 1);
    q.vy += ky;
    if (q.hp <= 0) {
      q.hp = 0;
      q.alive = false;
      const killer = this.players.find((p) => p.id === fromId);
      if (killer && killer.id !== q.id) {
        killer.kills++;
        this.events.push({ kind: "kill", text: `${killer.name} ▸ ${q.name}`, a: killer.id, b: q.id });
      } else {
        this.events.push({ kind: "death", text: q.name, a: q.id, b: q.id });
      }
    }
  }

  private explode(x: number, y: number, radius: number, dmg: number, owner: number): void {
    this.events.push({ kind: "explode", a: owner });
    for (const q of this.players) {
      if (!q.alive) continue;
      const d = Math.hypot(q.x - x, q.y + PH / 2 - y);
      if (d > radius + 20) continue;
      const fall = 1 - (d / (radius + 20)) * 0.5;
      const a = Math.atan2(q.y + PH / 2 - y, q.x - x);
      this.damage(q, dmg * fall, owner, Math.cos(a) * 620, Math.sin(a) * 620 - 200);
    }
  }

  private stepProjectiles(dt: number): void {
    const solids = this.solids();
    const keep: Proj[] = [];
    for (const pr of this.projectiles) {
      pr.life -= dt;
      if (pr.gravity) pr.vy += pr.gravity * dt;
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
      // barrels
      for (let i = this.barrels.length - 1; i >= 0; i--) {
        const b = this.barrels[i];
        if (Math.abs(pr.x - b.x) < 22 && Math.abs(pr.y - b.y) < 30) {
          b.hp -= pr.thrown ? 55 : 25;
          dead = true;
          if (b.hp <= 0) {
            this.barrels.splice(i, 1);
            this.explode(b.x, b.y, 135, 85, pr.owner);
          }
          break;
        }
      }
      // crates
      for (let i = this.crates.length - 1; i >= 0; i--) {
        const c = this.crates[i];
        if (pr.x >= c.x && pr.x <= c.x + c.w && pr.y >= c.y && pr.y <= c.y + c.h) {
          this.crates.splice(i, 1);
          this.events.push({ kind: "crate" });
          dead = true;
          break;
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
        } else {
          dead = true;
        }
      }
      // player hits (never the owner)
      if (!dead) {
        for (const q of this.players) {
          if (!q.alive || q.id === pr.owner) continue;
          if (Math.abs(pr.x - q.x) < PW / 2 + 6 && pr.y > q.y - 6 && pr.y < q.y + PH + 6) {
            const a = Math.atan2(pr.vy, pr.vx);
            this.damage(q, pr.damage, pr.owner, Math.cos(a) * 380, Math.sin(a) * 200 - 120);
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
    const solids = this.solids().filter((s) => s.type !== undefined || true);
    for (const c of this.crates) {
      c.vy = Math.min(MAX_FALL, c.vy + GRAVITY * 0.7 * dt);
      c.x += c.vx * dt;
      c.vx *= 1 - Math.min(1, 3 * dt);
      c.y += c.vy * dt;
      for (const s of solids) {
        if (s.w === c.w && s.h === c.h) continue; // skip self-ish (crates are in solids list)
        if (c.x < s.x + s.w && c.x + c.w > s.x && c.y < s.y + s.h && c.y + c.h > s.y) {
          if (c.vy > 0 && c.y + c.h - s.y < 24) {
            c.y = s.y - c.h;
            c.vy = 0;
          } else if (c.vy < 0) {
            c.y = s.y + s.h;
            c.vy = 0;
          }
        }
      }
      if (c.y > WORLD_H + 200) {
        c.y = -40; c.vy = 0;
      }
    }
  }

  private stepDrops(dt: number): void {
    const solids = this.solids();
    for (const d of this.drops) {
      d.vy = Math.min(MAX_FALL, d.vy + GRAVITY * 0.7 * dt);
      d.x += d.vx * dt;
      d.vx *= 1 - Math.min(1, 2 * dt);
      d.y += d.vy * dt;
      for (const s of solids) {
        if (d.x > s.x - 8 && d.x < s.x + s.w + 8 && d.y > s.y - 6 && d.y < s.y + s.h) {
          if (d.vy > 0) {
            d.y = s.y - 4;
            d.vy = -d.vy * 0.3;
            if (Math.abs(d.vy) < 40) d.vy = 0;
          }
        }
      }
    }
  }

  private checkHazards(p: PlayerState): void {
    if (!p.alive) return;
    // void / out of bounds
    if (p.y > WORLD_H + 80 || p.x < -200 || p.x > WORLD_W + 200) {
      p.hp = 0; p.alive = false;
      this.events.push({ kind: "death", text: `${p.name} fell`, a: p.id, b: p.id });
      return;
    }
    const body = { x: p.x - PW / 2, y: p.y, w: PW, h: PH };
    // lava platforms
    for (const pl of this.level.platforms) {
      if (pl.type !== "lava") continue;
      const s = { x: pl.x * WORLD_W, y: pl.y * WORLD_H, w: pl.w * WORLD_W, h: pl.h * WORLD_H };
      if (body.x < s.x + s.w && body.x + body.w > s.x && body.y < s.y + s.h && body.y + body.h > s.y) {
        p.hp = 0; p.alive = false;
        this.events.push({ kind: "death", text: `${p.name} melted`, a: p.id, b: p.id });
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
        this.events.push({ kind: "death", text: `${p.name} hit ${k.kind}`, a: p.id, b: p.id });
        return;
      }
    }
  }

  private checkRound(dt: number): void {
    if (this.resetTimer >= 0) {
      this.resetTimer -= dt;
      if (this.resetTimer < 0) {
        this.round++;
        this.cycleIndex = (this.cycleIndex + 1) % this.cycle.length;
        this.level = this.cycle[this.cycleIndex];
        this.resetArena();
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
        this.events.push({ kind: "roundEnd", text: winner.name, a: winner.id, b: this.round });
        if (this.wins[winner.id] >= WIN_SCORE) {
          this.events.push({ kind: "matchEnd", text: winner.name, a: winner.id });
          this.wins = {};
        }
      } else {
        this.events.push({ kind: "roundEnd", text: "draw", a: -1, b: this.round });
      }
      this.resetTimer = 2;
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
