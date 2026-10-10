import { GRAVITY, MAX_FALL, WORLD_H, WORLD_W } from '../../shared/constants.js';
import type {
  BarrelState,
  CrateState,
  KillRectDef,
  LevelDef,
  MoverDef,
  PlatformDef,
  RotatorDef,
} from '../../shared/types.js';
import { denorm, type SolidRect } from '../levels/loader.js';

export interface BodyState {
  x: number; y: number; w: number; h: number;
  vx: number; vy: number; onGround: boolean;
  /** Side wall contact from the last collideMove X pass: +1 wall on right, -1 on left. */
  wallDir?: -1 | 0 | 1;
  /** Set by the caller (stepPlayer/modes) when pressing into a wall while airborne. */
  sliding?: boolean;
  /** Index into moverSolidAt() of the dynamic platform stood on, or -1. */
  groundMover?: number;
}

/** Wall-slide / wall-jump tuning (shared by World, player.ts, LocalMode, Match). */
export const WALL_SLIDE_CAP = 180;
export const WALL_JUMP_VX = 380;
export const WALL_JUMP_VY_SCALE = 0.92;
/** Approx tangential carry (px/s per rad/s) when standing on a rotator AABB top. */
export const ROTATOR_CARRY = 55;

export interface CollideOpts { ice: boolean }

export interface PixelKillRect {
  x: number; y: number; w: number; h: number;
  kind: 'spikes' | 'lava' | 'laser';
  period: number; duty: number; phase: number;
}

function toPixelKill(k: KillRectDef): PixelKillRect {
  const p = denorm(k);
  return { ...p, kind: k.kind, period: k.period ?? 0, duty: k.duty ?? 1, phase: k.phase ?? 0 };
}

function moverAt(m: MoverDef, time: number): PixelRect {
  const phase = m.phase ?? 0;
  const off = Math.sin(((time + phase) / m.period) * Math.PI * 2) * m.range;
  const nx = m.axis === 'x' ? m.x + off : m.x;
  const ny = m.axis === 'y' ? m.y + off : m.y;
  return denorm({ x: nx, y: ny, w: m.w, h: m.h });
}

interface PixelRect { x: number; y: number; w: number; h: number }

function rotatorAABB(r: RotatorDef, time: number): PixelRect {
  const cx = r.cx * WORLD_W;
  const cy = r.cy * WORLD_H;
  const w = r.w * WORLD_W;
  const h = r.h * WORLD_H;
  const a = time * r.angleSpeed;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const bw = w * c + h * s;
  const bh = w * s + h * c;
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
}

function overlaps(a: PixelRect, b: PixelRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Max displacement per integration substep — prevents tunneling through thin walls. */
export const MAX_STEP = 8;

/**
 * True when the segment (x1,y1)->(x2,y2) touches any solid AABB.
 * Used to block melee / explosion hits through walls. Solids that contain
 * the segment start are ignored so standing on a platform doesn't self-block.
 */
export function segmentBlocked(
  x1: number, y1: number, x2: number, y2: number,
  solids: PixelRect[],
): boolean {
  const dx = x2 - x1, dy = y2 - y1;
  for (const s of solids) {
    // Shooter inside this solid (spawn overlap) — can't be cover.
    if (x1 > s.x && x1 < s.x + s.w && y1 > s.y && y1 < s.y + s.h) continue;
    // Target inside this solid — handled by depenetration, not cover.
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
    // Ignore a touch exactly at the shooter's origin; a wall anywhere
    // between (exclusive of endpoints) blocks the hit.
    if (tmax > 0 && tmin < 1 && tmax > 0.001 && tmin < 0.999) {
      // Require the hit to be strictly interior, not just grazing an endpoint.
      const tHit = Math.max(tmin, 0);
      if (tHit > 0.001 && tHit < 0.999) return true;
    }
  }
  return false;
}

export class World {
  solids: SolidRect[] = [];
  movers: MoverDef[] = [];
  rotators: RotatorDef[] = [];
  crates: CrateState[] = [];
  barrels: BarrelState[] = [];
  killRects: PixelKillRect[] = [];
  time = 0;

  loadLevel(level: LevelDef): void {
    this.solids = level.platforms.map((p: PlatformDef) => {
      const px = denorm(p);
      return {
        ...px,
        type: p.type ?? 'static',
        beltSpeed: p.beltSpeed ?? 0,
        period: p.period ?? 0,
        duty: p.duty ?? 1,
        phase: p.phase ?? 0,
      };
    });
    this.movers = [...(level.movers ?? [])];
    this.rotators = [...(level.rotators ?? [])];
    this.crates = (level.crates ?? []).map((c) => {
      const p = denorm(c);
      return { x: p.x, y: p.y - p.h, w: p.w, h: p.h, vx: 0, vy: 0, angle: 0 };
    });
    this.barrels = (level.barrels ?? []).map((b) => ({
      x: b.x * WORLD_W, y: b.y * WORLD_H, hp: 30,
    }));
    this.killRects = (level.killRects ?? []).map(toPixelKill);
    // Lava-type platforms also kill.
    for (const s of this.solids) {
      if (s.type === 'lava') {
        this.killRects.push({ x: s.x, y: s.y, w: s.w, h: s.h, kind: 'lava', period: 0, duty: 1, phase: 0 });
      }
    }
    this.time = 0;
  }

  isBlinkOn(def: { period?: number; duty?: number; phase?: number }, time: number): boolean {
    const period = def.period ?? 0;
    if (!period || period <= 0) return true;
    const duty = def.duty ?? 1;
    const phase = def.phase ?? 0;
    const t = (((time + phase) % period) + period) % period;
    return t / period < duty;
  }

  /** Pixel AABBs of movers + rotator approximations at time t. */
  moverSolidAt(time: number): PixelRect[] {
    const out: PixelRect[] = [];
    for (const m of this.movers) out.push(moverAt(m, time));
    for (const r of this.rotators) out.push(rotatorAABB(r, time));
    return out;
  }

  private activeSolids(time: number): SolidRect[] {
    return this.solids.filter((s) => {
      if (s.type === 'blink' && !this.isBlinkOn(s, time)) return false;
      if (s.type === 'lava') return false;
      return true;
    });
  }

  applyGravity(body: { vy: number }, dt: number): void {
    body.vy = Math.min(body.vy + GRAVITY * dt, MAX_FALL);
  }

  collideMove(body: BodyState, dt: number, opts: CollideOpts, time = this.time): void {
    const solids = this.activeSolids(time);
    const prevDynamics = this.moverSolidAt(time - dt);
    const dynamics = this.moverSolidAt(time);
    const deltas = dynamics.map((r, i) => ({
      dx: r.x - (prevDynamics[i]?.x ?? r.x),
      dy: r.y - (prevDynamics[i]?.y ?? r.y),
    }));
    const crateBoxes: PixelRect[] = this.crates.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
    const statics: { r: PixelRect; solid: SolidRect | null; dyn: number }[] = [
      ...solids.map((r) => ({ r, solid: r as SolidRect, dyn: -1 })),
      ...dynamics.map((r, i) => ({ r, solid: null, dyn: i })),
      ...crateBoxes.map((r) => ({ r, solid: null, dyn: -1 })),
    ];
    const colliders: PixelRect[] = statics.map((s) => s.r);

    // Substep so a single frame can never jump over a thin wall.
    const dist = Math.max(Math.abs(body.vx * dt), Math.abs(body.vy * dt));
    const steps = Math.max(1, Math.min(8, Math.ceil(dist / MAX_STEP)));
    const h = dt / steps;
    body.wallDir = 0;
    body.onGround = false;
    let groundDyn = -1;

    for (let st = 0; st < steps; st++) {
      // --- X axis (only when X motion caused the overlap — a pre-existing
      // vertical overlap from jumping up into a platform must not eject the
      // body sideways to the platform edge; Y owns that axis). ---
      const oldX = body.x;
      body.x += body.vx * h;
      const boxX: PixelRect = { x: body.x, y: body.y, w: body.w, h: body.h };
      const wasX: PixelRect = { x: oldX, y: body.y, w: body.w, h: body.h };
      for (const s of colliders) {
        if (!overlaps(boxX, s)) continue;
        if (overlaps(wasX, s)) continue;
        if (body.vx > 0) { body.x = s.x - body.w; body.wallDir = 1; }
        else if (body.vx < 0) { body.x = s.x + s.w; body.wallDir = -1; }
        else {
          // Overlapping with no velocity (e.g. carried into a wall): push out minimally.
          const pushL = boxX.x + boxX.w - s.x;
          const pushR = s.x + s.w - boxX.x;
          if (pushL < pushR) { body.x = s.x - body.w; body.wallDir = 1; }
          else { body.x = s.x + s.w; body.wallDir = -1; }
        }
        body.vx = 0;
        boxX.x = body.x;
      }

      // --- Y axis ---
      body.y += body.vy * h;
      const boxY: PixelRect = { x: body.x, y: body.y, w: body.w, h: body.h };
      for (const { r, solid, dyn } of statics) {
        if (!overlaps(boxY, r)) continue;
        if (body.vy > 0) {
          body.y = r.y - body.h;
          body.onGround = true;
          groundDyn = dyn;
          if (solid?.type === 'bouncy') {
            body.vy = -1300;
            body.onGround = false;
            groundDyn = -1;
          } else if (solid?.type === 'conveyor') {
            body.x += solid.beltSpeed * WORLD_W * h;
            body.vy = 0;
          } else {
            body.vy = 0;
          }
        } else if (body.vy < 0) {
          body.y = r.y + r.h;
          body.vy = 0;
        } else {
          // Resting overlap with no velocity (spawned/carried inside):
          // escape along the smallest vertical penetration so the next
          // X pass never sees a stale overlap and teleports sideways.
          const penT = (boxY.y + boxY.h) - r.y;
          const penB = (r.y + r.h) - boxY.y;
          if (penT < penB) {
            body.y = r.y - body.h;
            body.onGround = true;
            groundDyn = dyn;
            body.vy = 0;
          } else {
            body.y = r.y + r.h;
            body.vy = 0;
          }
        }
        boxY.y = body.y;
      }
    }
    // --- Final depenetration: knockback / mover carry / player-vs-player
    // pushes can leave the body inside a solid where the X "wasX" guard
    // above intentionally skips. Eject along the minimum-penetration axis
    // so a sealed fort (Box Fort interior) can never be entered or camped.
    for (let iter = 0; iter < 4; iter++) {
      const box: PixelRect = { x: body.x, y: body.y, w: body.w, h: body.h };
      let hit: PixelRect | null = null;
      for (const s of colliders) {
        if (overlaps(box, s)) { hit = s; break; }
      }
      if (!hit) break;
      const s = hit;
      const penX = Math.min(box.x + box.w - s.x, s.x + s.w - box.x);
      const penY = Math.min(box.y + box.h - s.y, s.y + s.h - box.y);
      if (penX < penY) {
        if (box.x + box.w / 2 < s.x + s.w / 2) { body.x = s.x - body.w; body.wallDir = 1; }
        else { body.x = s.x + s.w; body.wallDir = -1; }
        body.vx = 0;
      } else {
        if (box.y + box.h / 2 < s.y + s.h / 2) {
          body.y = s.y - body.h;
          body.onGround = true;
          body.vy = 0;
        } else {
          body.y = s.y + s.h;
          body.vy = 0;
        }
      }
    }
    body.groundMover = groundDyn;
    // Mover carry: standing on a moving platform drags the body by the
    // platform's frame delta. Rotators use a tangential approximation.
    if (body.onGround && groundDyn >= 0) {
      const d = deltas[groundDyn];
      if (d) {
        if (groundDyn < this.movers.length) {
          body.x += d.dx;
          body.y += d.dy;
        } else {
          const rot = this.rotators[groundDyn - this.movers.length];
          if (rot) body.x += rot.angleSpeed * ROTATOR_CARRY * dt;
        }
      }
    }
    // Carry can shove the body into an adjacent wall — sweep once more so
    // the final state is never inside a solid.
    for (let iter = 0; iter < 2; iter++) {
      const box: PixelRect = { x: body.x, y: body.y, w: body.w, h: body.h };
      let hit: PixelRect | null = null;
      for (const s of colliders) {
        if (overlaps(box, s)) { hit = s; break; }
      }
      if (!hit) break;
      const s = hit;
      const penX = Math.min(box.x + box.w - s.x, s.x + s.w - box.x);
      const penY = Math.min(box.y + box.h - s.y, s.y + s.h - box.y);
      if (penX < penY) {
        if (box.x + box.w / 2 < s.x + s.w / 2) { body.x = s.x - body.w; body.wallDir = 1; }
        else { body.x = s.x + s.w; body.wallDir = -1; }
        body.vx = 0;
      } else {
        if (box.y + box.h / 2 < s.y + s.h / 2) {
          body.y = s.y - body.h;
          body.onGround = true;
          body.vy = 0;
        } else {
          body.y = s.y + s.h;
          body.vy = 0;
        }
      }
    }
    void opts;
  }

  checkKill(x: number, y: number, time: number): 'spikes' | 'lava' | 'laser' | null {
    for (const k of this.killRects) {
      if (x < k.x || x > k.x + k.w || y < k.y || y > k.y + k.h) continue;
      if (k.kind === 'laser' && k.period > 0 && !this.isBlinkOn(k, time)) continue;
      return k.kind;
    }
    return null;
  }
}
