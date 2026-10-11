import { GRAVITY, WORLD_H, WORLD_W } from '../../shared/constants.js';
import type { PlayerState, ProjectileState, WeaponId } from '../../shared/types.js';

const SPEEDS: Partial<Record<WeaponId, number>> = {
  pistol: 950, revolver: 1100, deagle: 1250, uzi: 900, ak47: 1050,
  m16: 1100, sniper: 1900, shotgun: 850, sawedoff: 750, bouncer: 800,
  minigun: 950, grenade: 620, rpg: 700, flamethrower: 520,
  spear: 900, sword: 0, fists: 0, snake: 260, snakeshot: 260,
  ice: 700, glue: 650,
};

const DAMAGE: Partial<Record<WeaponId, number>> = {
  pistol: 12, revolver: 20, deagle: 34, uzi: 8, ak47: 12, m16: 11,
  sniper: 55, shotgun: 8, sawedoff: 9, bouncer: 14, minigun: 7,
  grenade: 45, rpg: 60, flamethrower: 4, spear: 25,
  sword: 30, fists: 12, snake: 5, snakeshot: 5,
  ice: 8, glue: 5,
};

const KNOCK: Partial<Record<WeaponId, number>> = {
  pistol: 220, revolver: 320, deagle: 480, uzi: 160, ak47: 220,
  m16: 220, sniper: 700, shotgun: 420, sawedoff: 520, bouncer: 300,
  minigun: 140, grenade: 650, rpg: 750, flamethrower: 60,
  spear: 380, sword: 420, fists: 320, snake: 200, snakeshot: 200,
  ice: 200, glue: 150,
};

// Raw gravity (px/s^2) for arcing droplets. Snakes/others use 0.
const PROJ_GRAV: Partial<Record<WeaponId, number>> = {
  grenade: 2400,
  ice: 1200,
  glue: 900,
};

const PW = 26;
const PH = 54;

export function muzzleVelocity(weapon: WeaponId, aim: { x: number; y: number }): { vx: number; vy: number } {
  let ax = aim?.x ?? 1;
  let ay = aim?.y ?? 0;
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) { ax = 1; ay = 0; }
  const l = Math.hypot(ax, ay);
  if (l < 1e-4) { ax = 1; ay = 0; } else { ax /= l; ay /= l; }
  const speed = SPEEDS[weapon] ?? 900;
  return { vx: ax * speed, vy: ay * speed };
}

// Class IS the array so snapshots (`ProjectileState[]`) accept it directly.
export class Projectiles extends Array<ProjectileState> {
  private nextId = 1;

  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  constructor() {
    super(0);
  }

  spawn(kind: WeaponId, x: number, y: number, vx: number, vy: number, owner: number, life = 2): ProjectileState {
    // Snakes live 6s (gravity 0, homing in step()).
    if ((kind === 'snake' || kind === 'snakeshot') && life === 2) life = 6;
    // Arcing status droplets default to their tuned lifetimes.
    if (kind === 'ice' && life === 2) life = 1.2;
    if (kind === 'glue' && life === 2) life = 1.5;
    const p: ProjectileState = {
      id: this.nextId++, kind, x, y, vx, vy, life, owner,
      bounces: kind === 'bouncer' ? 3 : 0,
    };
    this.push(p);
    return p;
  }

  step(
    dt: number,
    world: any,
    players: PlayerState[],
    onHit?: (victim: PlayerState, proj: ProjectileState) => void,
    onExplode?: (x: number, y: number, proj: ProjectileState) => void,
  ): void {
    dt = Math.min(Math.max(dt, 0), 1 / 30);
    for (let i = this.length - 1; i >= 0; i--) {
      const pr = this[i];
      const prevX = pr.x;
      const prevY = pr.y;

      if (pr.kind === 'grenade') pr.vy += GRAVITY * dt;
      // Ice/glue droplets arc under their tuned gravity.
      else {
        const g = PROJ_GRAV[pr.kind];
        if (g) pr.vy += g * dt;
      }

      // Snake homing: steer toward nearest living enemy (not owner),
      // turn rate limited to ~3 rad/s, speed preserved, gravity 0.
      if (pr.kind === 'snake' || pr.kind === 'snakeshot') steerSnake(pr, players, dt);

      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.life -= dt;

      // World / bounds collision.
      const hitSolid = isSolidAt(world, pr.x, pr.y);
      const outBounds = pr.x < -120 || pr.x > WORLD_W + 120 || pr.y < -160 || pr.y > WORLD_H + 120;
      if (hitSolid || (outBounds && pr.kind === 'bouncer')) {
        if (pr.kind === 'bouncer' && (pr.bounces ?? 0) > 0) {
          pr.bounces = (pr.bounces ?? 1) - 1;
          // Determine reflection axis by probing previous position.
          const solidX = isSolidAt(world, prevX, pr.y);
          const solidY = isSolidAt(world, pr.x, prevY);
          if (hitSolid && !outBounds) {
            if (solidX && !solidY) pr.vy = -pr.vy;
            else if (solidY && !solidX) pr.vx = -pr.vx;
            else { pr.vx = -pr.vx; pr.vy = -pr.vy; }
          } else {
            // Bounds bounce.
            if (pr.x < -120 || pr.x > WORLD_W + 120) pr.vx = -pr.vx;
            if (pr.y < -160 || pr.y > WORLD_H + 120) pr.vy = -pr.vy;
          }
          pr.x = prevX; pr.y = prevY;
          continue;
        }
        if (pr.kind === 'grenade' || pr.kind === 'rpg') {
          try { onExplode?.(pr.x, pr.y, pr); } catch { /* ignore */ }
        }
        this.splice(i, 1);
        continue;
      }
      if (outBounds) { this.splice(i, 1); continue; }

      // Range / life cull.
      if (pr.life <= 0) {
        if (pr.kind === 'grenade' || pr.kind === 'rpg') {
          try { onExplode?.(pr.x, pr.y, pr); } catch { /* ignore */ }
        }
        this.splice(i, 1);
        continue;
      }

      // Player AABB hit test (skip owner + dead).
      for (const pl of players ?? []) {
        if (!pl?.alive) continue;
        if (pl.id === pr.owner) continue;
        if (pointInPlayer(pr.x, pr.y, pl)) {
          const dmg = DAMAGE[pr.kind] ?? 10;
          const kb = KNOCK[pr.kind] ?? 200;
          const l = Math.hypot(pr.vx, pr.vy) || 1;
          const nx = pr.vx / l;
          const ny = pr.vy / l;
          const blocking = !!(pl as any).blockHeld;
          const mult = blocking ? 0.35 : 1;
          pl.hp -= dmg * mult;
          pl.vx += nx * kb * mult + (blocking ? 0 : nx * 60);
          pl.vy += ny * kb * mult * 0.6 - 120 * mult;
          (pl as any).hpBlink = 0.18;
          // Status effects: ice frosts (2s slow), glue roots (stacking, max 3s).
          if (pr.kind === 'ice') (pl as any).frostT = 2;
          else if (pr.kind === 'glue') {
            const cur = Number((pl as any).glueT) || 0;
            (pl as any).glueT = Math.min(3, cur + 1);
          }
          if (pl.hp <= 0) { pl.hp = 0; pl.alive = false; }
          try { onHit?.(pl, pr); } catch { /* ignore */ }
          if (pr.kind === 'grenade' || pr.kind === 'rpg') {
            try { onExplode?.(pr.x, pr.y, pr); } catch { /* ignore */ }
          }
          this.splice(i, 1);
          break;
        }
      }
    }
  }
}

function steerSnake(pr: ProjectileState, players: PlayerState[], dt: number): void {
  let best: PlayerState | null = null;
  let bd = Infinity;
  for (const pl of players ?? []) {
    if (!pl?.alive || pl.id === pr.owner) continue;
    const d = Math.hypot(pl.x - pr.x, pl.y - pr.y);
    if (d < bd) { bd = d; best = pl; }
  }
  if (!best) return;
  const speed = Math.hypot(pr.vx, pr.vy) || 260;
  const cur = Math.atan2(pr.vy, pr.vx);
  // Aim at victim center (PlayerState is top-based, PH=54).
  const want = Math.atan2(best.y + 27 - pr.y, best.x + 13 - pr.x);
  let da = want - cur;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  const maxTurn = 3 * dt;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, da));
  const na = cur + turn;
  pr.vx = Math.cos(na) * speed;
  pr.vy = Math.sin(na) * speed;
}

function pointInPlayer(x: number, y: number, p: PlayerState): boolean {
  const r = 4;
  return x >= p.x - r && x <= p.x + PW + r && y >= p.y - r && y <= p.y + PH + r;
}

function isSolidAt(world: any, x: number, y: number): boolean {
  try {
    if (!world) return false;
    if (typeof world.isSolid === 'function') return !!world.isSolid(x, y);
    if (Array.isArray(world.solids)) {
      for (const s of world.solids) {
        if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}
