import { AIR_CONTROL, GRAVITY, JUMP_SPEED, MAX_FALL, MOVE_SPEED, PLAYER_HP } from '../../shared/constants.js';
import type { PlayerState } from '../../shared/types.js';

export interface Body {
  x: number; y: number; w: number; h: number;
  vx: number; vy: number; onGround: boolean;
}

export interface PlayerInput {
  left: boolean; right: boolean; jump: boolean; down: boolean;
  fire: boolean; block: boolean; throwReq: boolean;
  aimX: number; aimY: number;
}

export interface PlayerApi {
  fire: (...args: any[]) => void;
  melee: (...args: any[]) => void;
  pickup: (...args: any[]) => void;
}

export const PW = 26;
export const PH = 54;

const COYOTE = 0.1;
const BUFFER = 0.12;
const ACCEL_GROUND = 4200;
const FRICTION_GROUND = 3400;
const FRICTION_ICE = 350;
const ACCEL_ICE = 1400;
// Wall-slide + wall-jump tuning (mirrors src/physics/world.ts).
export const WALL_SLIDE_CAP = 180;
export const WALL_JUMP_VX = 380;
export const WALL_JUMP_VY_SCALE = 0.92;
const WALL_LOCK = 0.18;

interface Bag { coyote: number; buffer: number; prevJump: boolean; wallLock: number }
const bags = new WeakMap<PlayerState, Bag>();

function bag(p: PlayerState): Bag {
  let b = bags.get(p);
  if (!b) { b = { coyote: 0, buffer: 0, prevJump: false, wallLock: 0 }; bags.set(p, b); }
  return b;
}

function isIce(world: any, x: number, y: number): boolean {
  try {
    if (!world) return false;
    if (typeof world.groundType === 'function') return world.groundType(x, y) === 'ice';
    if (typeof world.surfaceAt === 'function') return world.surfaceAt(x, y) === 'ice';
    if (typeof world.isIce === 'function') return !!world.isIce(x, y);
    if (typeof world.groundFriction === 'function') {
      const f = world.groundFriction(x, y);
      return typeof f === 'number' && f < 0.3;
    }
  } catch { /* ignore */ }
  return false;
}

function beltPush(world: any, x: number, y: number): number {
  try {
    if (world && typeof world.beltVelocity === 'function') {
      const v = world.beltVelocity(x, y);
      return typeof v === 'number' ? v : 0;
    }
  } catch { /* ignore */ }
  return 0;
}

function solidAt(world: any, x: number, y: number): boolean {
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

/** Side-wall probe: is there a solid just outside the body on side dir? */
function probeWall(p: PlayerState, world: any, dir: number): -1 | 0 | 1 {
  if (dir === 0) return 0;
  const px = dir > 0 ? p.x + PW + 2 : p.x - 2;
  const ys = [p.y + 6, p.y + PH / 2, p.y + PH - 6];
  for (const y of ys) if (solidAt(world, px, y)) return dir > 0 ? 1 : -1;
  // Dynamic platforms (World.moverSolidAt) aren't in world.solids — check them too.
  try {
    if (world && typeof world.moverSolidAt === 'function') {
      const t = typeof world.time === 'number' ? world.time : 0;
      const boxes = world.moverSolidAt(t) as { x: number; y: number; w: number; h: number }[];
      for (const r of boxes ?? []) {
        for (const y of ys) {
          if (px >= r.x && px <= r.x + r.w && y >= r.y && y <= r.y + r.h) return dir > 0 ? 1 : -1;
        }
      }
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * Player-player soft collision (Match convention: x centered, y top-based).
 * Overlapping alive players are pushed apart horizontally, splitting the
 * overlap. No damage, no vertical change.
 */
export function separatePlayers(players: PlayerState[]): void {
  const alive = players.filter((p) => p?.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      const overlapY = Math.min(a.y + PH, b.y + PH) - Math.max(a.y, b.y);
      if (overlapY <= 0) continue;
      const dx = b.x - a.x;
      const overlapX = PW - Math.abs(dx);
      if (overlapX <= 0) continue;
      const push = overlapX / 2 + 0.5;
      const s = dx >= 0 ? 1 : -1;
      a.x -= s * push;
      b.x += s * push;
    }
  }
}

function collideMove(p: PlayerState, dt: number, world: any): void {
  // Delegate to world mover when available.
  try {
    if (world && typeof world.collideMove === 'function') {
      // Canonical World (src/physics/world.ts): reports wallDir/groundMover
      // and applies mover carry internally.
      const b: Body & { wallDir?: -1 | 0 | 1; sliding?: boolean; groundMover?: number } =
        { x: p.x, y: p.y, w: PW, h: PH, vx: p.vx, vy: p.vy, onGround: p.onGround };
      world.collideMove(b, dt, { ice: isIce(world, p.x + PW / 2, p.y + PH + 1) }, typeof world.time === 'number' ? world.time : 0);
      p.x = b.x; p.y = b.y; p.vx = b.vx; p.vy = b.vy; p.onGround = b.onGround;
      (p as any).wallDir = b.wallDir ?? 0;
      (p as any).groundMover = b.groundMover ?? -1;
      if (p.onGround) (p as any).sliding = false;
      return;
    }
    if (world && typeof world.moveBody === 'function') {
      const b: Body = { x: p.x, y: p.y, w: PW, h: PH, vx: p.vx, vy: p.vy, onGround: p.onGround };
      world.moveBody(b, dt);
      p.x = b.x; p.y = b.y; p.vx = b.vx; p.vy = b.vy; p.onGround = b.onGround;
      return;
    }
    if (world && typeof world.collide === 'function') {
      const b: Body = { x: p.x, y: p.y, w: PW, h: PH, vx: p.vx, vy: p.vy, onGround: p.onGround };
      world.collide(b, dt);
      p.x = b.x; p.y = b.y; p.vx = b.vx; p.vy = b.vy; p.onGround = b.onGround;
      return;
    }
  } catch { /* fall through */ }

  const hasSolid = !!world && (typeof world.isSolid === 'function' || Array.isArray(world.solids));

  // X axis
  let nx = p.x + p.vx * dt;
  (p as any).wallDir = 0;
  if (hasSolid) {
    const top = p.y + 2, bottom = p.y + PH - 2;
    if (p.vx > 0 && (solidAt(world, nx + PW, top) || solidAt(world, nx + PW, (top + bottom) / 2) || solidAt(world, nx + PW, bottom))) {
      nx = p.x; p.vx = 0; (p as any).wallDir = 1;
    } else if (p.vx < 0 && (solidAt(world, nx, top) || solidAt(world, nx, (top + bottom) / 2) || solidAt(world, nx, bottom))) {
      nx = p.x; p.vx = 0; (p as any).wallDir = -1;
    }
  }
  // World side walls (pixel space 1280x720).
  if (nx < 0) { nx = 0; if (p.vx < 0) p.vx = 0; }
  if (nx + PW > 1280) { nx = 1280 - PW; if (p.vx > 0) p.vx = 0; }
  p.x = nx;

  // Y axis
  let ny = p.y + p.vy * dt;
  p.onGround = false;
  if (hasSolid) {
    const left = p.x + 2, right = p.x + PW - 2;
    if (p.vy >= 0 && (solidAt(world, left, ny + PH) || solidAt(world, (left + right) / 2, ny + PH) || solidAt(world, right, ny + PH))) {
      // Snap to top of solid: step back up until free (coarse).
      ny = Math.floor(ny);
      let guard = 0;
      while (guard++ < 64 && (solidAt(world, left, ny + PH) || solidAt(world, (left + right) / 2, ny + PH) || solidAt(world, right, ny + PH))) ny -= 1;
      p.vy = 0; p.onGround = true;
    } else if (p.vy < 0 && (solidAt(world, left, ny) || solidAt(world, (left + right) / 2, ny) || solidAt(world, right, ny))) {
      ny = p.y; p.vy = 0;
    }
  } else if (!world || typeof world.groundY !== 'number') {
    // Fallback floor so standalone sim doesn't fall forever.
    const floor = 720 - PH;
    if (ny >= floor) { ny = floor; if (p.vy > 0) p.vy = 0; p.onGround = true; }
  } else {
    const gy = (world as any).groundY as number;
    if (ny + PH >= gy) { ny = gy - PH; if (p.vy > 0) p.vy = 0; p.onGround = true; }
  }
  p.y = ny;
  if (p.y < -PH * 2) { p.y = -PH * 2; if (p.vy < 0) p.vy = 0; }
  if (p.onGround) (p as any).sliding = false;
}

export function createPlayer(id: number, name: string, color: string, slot: number): PlayerState {
  return {
    id, name, color,
    x: 200 + (slot % 4) * 280,
    y: 120,
    vx: 0, vy: 0,
    facing: slot >= 2 ? -1 : 1,
    aimX: 1, aimY: 0,
    hp: PLAYER_HP,
    alive: true,
    weapon: 'fists',
    ammo: Infinity,
    cooldown: 0,
    onGround: false,
    wins: 0,
    kills: 0,
  };
}

export function stepPlayer(
  p: PlayerState,
  input: PlayerInput,
  dt: number,
  world: any,
  api: PlayerApi,
): void {
  if (!p.alive) return;
  dt = Math.min(Math.max(dt, 0), 1 / 30);
  const b = bag(p);

  // Aim + facing
  if (typeof input.aimX === 'number' && typeof input.aimY === 'number') {
    p.aimX = input.aimX; p.aimY = input.aimY;
  }
  const moveDir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (moveDir !== 0) p.facing = moveDir > 0 ? 1 : -1;
  else if (Math.abs(p.aimX) > 0.15) p.facing = p.aimX >= 0 ? 1 : -1;

  // Horizontal: run accel toward target, friction when idle (ice = slippery).
  const feetX = p.x + PW / 2;
  const feetY = p.y + PH + 1;
  const ice = isIce(world, feetX, feetY);
  const target = moveDir * MOVE_SPEED;
  const accel = ice ? ACCEL_ICE : ACCEL_GROUND * (p.onGround ? 1 : AIR_CONTROL);
  if (moveDir !== 0) {
    const d = target - p.vx;
    const s = Math.sign(d) * Math.min(Math.abs(d), accel * dt);
    p.vx += s;
  } else if (p.onGround) {
    const fr = ice ? FRICTION_ICE : FRICTION_GROUND;
    const s = Math.sign(p.vx) * Math.min(Math.abs(p.vx), fr * dt);
    p.vx -= s;
  } else {
    // Air drag, very light so flight feels floaty.
    p.vx -= p.vx * 0.25 * dt;
  }
  // Conveyor assist.
  p.vx += beltPush(world, feetX, feetY) * dt;

  // Wall-slide probe: airborne, falling, pressing into a side wall.
  // p.onGround / p.vy here still hold last tick's post-collision values.
  b.wallLock = Math.max(0, b.wallLock - dt);
  let wallSide: -1 | 0 | 1 = 0;
  if (moveDir !== 0 && !p.onGround && p.vy > 0 && b.wallLock <= 0) {
    wallSide = probeWall(p, world, moveDir);
  }
  (p as any).sliding = wallSide !== 0;
  if (wallSide !== 0) (p as any).wallDir = wallSide;

  // Gravity + fast fall.
  p.vy += GRAVITY * dt;
  if (input.down && !p.onGround) p.vy += GRAVITY * 0.9 * dt;
  const cap = input.down && !p.onGround ? MAX_FALL * 1.25 : MAX_FALL;
  if (p.vy > cap) p.vy = cap;
  // Slide friction: cap fall speed while sliding (no particle system here —
  // callers read (p as any).sliding to spawn wall dust).
  if ((p as any).sliding && !p.onGround && p.vy > WALL_SLIDE_CAP) p.vy = WALL_SLIDE_CAP;

  // Jump: coyote + buffer, variable height on early release.
  if (p.onGround) b.coyote = COYOTE; else b.coyote -= dt;
  const pressed = !!input.jump && !b.prevJump;
  if (pressed) b.buffer = BUFFER; else b.buffer -= dt;
  if (b.buffer > 0 && b.coyote > 0) {
    p.vy = -JUMP_SPEED;
    p.onGround = false;
    b.buffer = 0; b.coyote = 0;
  } else if (b.buffer > 0 && (p as any).sliding && !p.onGround) {
    // Wall-jump: push off away from the wall, slightly weaker vertically.
    const side = ((p as any).wallDir as number) || moveDir || p.facing || 1;
    p.vx = -side * WALL_JUMP_VX;
    p.vy = -JUMP_SPEED * WALL_JUMP_VY_SCALE;
    p.facing = p.vx >= 0 ? 1 : -1;
    p.onGround = false;
    (p as any).sliding = false;
    b.buffer = 0; b.coyote = 0; b.wallLock = WALL_LOCK;
  }
  if (!input.jump && b.prevJump && p.vy < -320) p.vy *= 0.55;
  b.prevJump = !!input.jump;

  collideMove(p, dt, world);

  // Timers / block flag for renderer.
  if (p.cooldown > 0) p.cooldown -= dt;
  (p as any).blockHeld = !!input.block;
  const blink = (p as any).hpBlink;
  if (typeof blink === 'number' && blink > 0) (p as any).hpBlink = blink - dt;

  // Fire / melee.
  if (input.fire && p.cooldown <= 0) {
    const before = p.cooldown;
    try {
      if (p.weapon === 'fists') {
        api?.melee?.(p);
        // Punch-boost: small kick along facing when airborne.
        if (!p.onGround) p.vx += p.facing * 130;
      } else {
        api?.fire?.(p);
        // Recoil is applied by api; nothing here.
      }
    } catch { /* api errors must not break sim */ }
    if (p.cooldown <= 0 || p.cooldown === before) {
      p.cooldown = p.weapon === 'fists' ? 0.32 : 0.15;
    }
  }

  // Pickup / throw-drop request.
  if (input.throwReq) {
    try { api?.pickup?.(p); } catch { /* ignore */ }
  }
}
