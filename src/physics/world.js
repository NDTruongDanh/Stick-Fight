import { GRAVITY, MAX_FALL, WORLD_H, WORLD_W } from '../../shared/constants.js';
import { denorm } from '../levels/loader.js';
/** Wall-slide / wall-jump tuning (shared by World, player.ts, LocalMode, Match). */
export const WALL_SLIDE_CAP = 180;
export const WALL_JUMP_VX = 380;
export const WALL_JUMP_VY_SCALE = 0.92;
/** Approx tangential carry (px/s per rad/s) when standing on a rotator AABB top. */
export const ROTATOR_CARRY = 55;
function toPixelKill(k) {
    const p = denorm(k);
    return { ...p, kind: k.kind, period: k.period ?? 0, duty: k.duty ?? 1, phase: k.phase ?? 0 };
}
function moverAt(m, time) {
    const phase = m.phase ?? 0;
    const off = Math.sin(((time + phase) / m.period) * Math.PI * 2) * m.range;
    const nx = m.axis === 'x' ? m.x + off : m.x;
    const ny = m.axis === 'y' ? m.y + off : m.y;
    return denorm({ x: nx, y: ny, w: m.w, h: m.h });
}
function rotatorAABB(r, time) {
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
function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
export class World {
    constructor() {
        Object.defineProperty(this, "solids", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "movers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "rotators", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "crates", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "barrels", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "killRects", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "time", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
    }
    loadLevel(level) {
        this.solids = level.platforms.map((p) => {
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
    isBlinkOn(def, time) {
        const period = def.period ?? 0;
        if (!period || period <= 0)
            return true;
        const duty = def.duty ?? 1;
        const phase = def.phase ?? 0;
        const t = (((time + phase) % period) + period) % period;
        return t / period < duty;
    }
    /** Pixel AABBs of movers + rotator approximations at time t. */
    moverSolidAt(time) {
        const out = [];
        for (const m of this.movers)
            out.push(moverAt(m, time));
        for (const r of this.rotators)
            out.push(rotatorAABB(r, time));
        return out;
    }
    activeSolids(time) {
        return this.solids.filter((s) => {
            if (s.type === 'blink' && !this.isBlinkOn(s, time))
                return false;
            if (s.type === 'lava')
                return false;
            return true;
        });
    }
    applyGravity(body, dt) {
        body.vy = Math.min(body.vy + GRAVITY * dt, MAX_FALL);
    }
    collideMove(body, dt, opts, time = this.time) {
        const solids = this.activeSolids(time);
        const prevDynamics = this.moverSolidAt(time - dt);
        const dynamics = this.moverSolidAt(time);
        const deltas = dynamics.map((r, i) => ({
            dx: r.x - (prevDynamics[i]?.x ?? r.x),
            dy: r.y - (prevDynamics[i]?.y ?? r.y),
        }));
        const crateBoxes = this.crates.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
        // --- X axis (only when X motion caused the overlap — a pre-existing
        // vertical overlap from jumping up into a platform must not eject the
        // body sideways to the platform edge; Y owns that axis). ---
        const oldX = body.x - body.vx * dt;
        body.x += body.vx * dt;
        body.wallDir = 0;
        const boxX = { x: body.x, y: body.y, w: body.w, h: body.h };
        const wasX = { x: oldX, y: body.y, w: body.w, h: body.h };
        for (const s of [...solids, ...dynamics, ...crateBoxes]) {
            if (!overlaps(boxX, s))
                continue;
            if (overlaps(wasX, s))
                continue;
            if (body.vx > 0) {
                body.x = s.x - body.w;
                body.wallDir = 1;
            }
            else if (body.vx < 0) {
                body.x = s.x + s.w;
                body.wallDir = -1;
            }
            else {
                // Overlapping with no velocity (e.g. carried into a wall): push out minimally.
                const pushL = boxX.x + boxX.w - s.x;
                const pushR = s.x + s.w - boxX.x;
                if (pushL < pushR) {
                    body.x = s.x - body.w;
                    body.wallDir = 1;
                }
                else {
                    body.x = s.x + s.w;
                    body.wallDir = -1;
                }
            }
            body.vx = 0;
            boxX.x = body.x;
        }
        // --- Y axis ---
        body.y += body.vy * dt;
        body.onGround = false;
        let groundDyn = -1;
        const boxY = { x: body.x, y: body.y, w: body.w, h: body.h };
        const all = [
            ...solids.map((r) => ({ r, solid: r, dyn: -1 })),
            ...dynamics.map((r, i) => ({ r, solid: null, dyn: i })),
            ...crateBoxes.map((r) => ({ r, solid: null, dyn: -1 })),
        ];
        for (const { r, solid, dyn } of all) {
            if (!overlaps(boxY, r))
                continue;
            if (body.vy > 0) {
                body.y = r.y - body.h;
                body.onGround = true;
                groundDyn = dyn;
                if (solid?.type === 'bouncy') {
                    body.vy = -1300;
                    body.onGround = false;
                    groundDyn = -1;
                }
                else if (solid?.type === 'conveyor') {
                    body.x += solid.beltSpeed * WORLD_W * dt;
                    body.vy = 0;
                }
                else {
                    body.vy = 0;
                }
            }
            else if (body.vy < 0) {
                body.y = r.y + r.h;
                body.vy = 0;
            }
            else {
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
                }
                else {
                    body.y = r.y + r.h;
                    body.vy = 0;
                }
            }
            boxY.y = body.y;
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
                }
                else {
                    const rot = this.rotators[groundDyn - this.movers.length];
                    if (rot)
                        body.x += rot.angleSpeed * ROTATOR_CARRY * dt;
                }
            }
        }
        void opts;
    }
    checkKill(x, y, time) {
        for (const k of this.killRects) {
            if (x < k.x || x > k.x + k.w || y < k.y || y > k.y + k.h)
                continue;
            if (k.kind === 'laser' && k.period > 0 && !this.isBlinkOn(k, time))
                continue;
            return k.kind;
        }
        return null;
    }
}
