const MELEE = new Set(['fists', 'sword', 'spear']);
const GUN_WANT_RANGE = 300;
const GUN_RANGE_TOL = 110;
const MELEE_RANGE = 64;
const GUN_MAX_RANGE = 760;
const THROW_RANGE = 240;
const MOVE_DEADBAND = 10;
const JUMP_COOLDOWN = 0.4;
const blank = (facing) => ({
    left: false,
    right: false,
    jump: false,
    down: false,
    fire: false,
    block: false,
    throwReq: false,
    aimX: facing >= 0 ? 1 : -1,
    aimY: 0,
});
export class Bot {
    constructor(difficulty = 0.6) {
        Object.defineProperty(this, "difficulty", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "seed", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "mode", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'idle'
        });
        Object.defineProperty(this, "lastX", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "lastCheck", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "stuckUntil", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "reverseUntil", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "nextJumpAt", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "nextThrowAt", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "lastTargetId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: -1
        });
        Object.defineProperty(this, "engageAt", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        this.difficulty = Math.max(0, Math.min(1, difficulty));
        this.seed = Math.random() * 20;
    }
    get state() {
        return this.mode;
    }
    decide(me, world, time) {
        const facing = me.facing === -1 ? -1 : 1;
        const out = blank(facing);
        if (!me.alive || me.hp <= 0) {
            this.mode = 'idle';
            return out;
        }
        const enemies = world.players.filter((p) => p.id !== me.id && p.alive && p.hp > 0);
        if (enemies.length === 0 && world.drops.length === 0) {
            this.mode = 'idle';
            return out;
        }
        let foe = null;
        let foeDist = Infinity;
        for (const e of enemies) {
            const d = Math.hypot(e.x - me.x, e.y - me.y);
            if (d < foeDist) {
                foeDist = d;
                foe = e;
            }
        }
        if (foe && foe.id !== this.lastTargetId) {
            this.lastTargetId = foe.id;
            // Lower difficulty reacts slower.
            this.engageAt = time + (1 - this.difficulty) * 0.6;
        }
        const hasWeapon = me.weapon !== 'fists';
        const melee = MELEE.has(me.weapon);
        // ---- choose move target ----
        let tx = null;
        let ty = null;
        if (!hasWeapon) {
            this.mode = 'seek';
            let best = Infinity;
            for (const d of world.drops) {
                const dist = Math.hypot(d.x - me.x, d.y - me.y);
                if (dist < best) {
                    best = dist;
                    tx = d.x;
                    ty = d.y;
                }
            }
            // No drops: still shadow nearest enemy (might catch a thrown gun).
            if (tx === null && foe) {
                this.mode = 'chase';
                tx = foe.x;
                ty = foe.y;
            }
        }
        else if (foe) {
            this.mode = 'chase';
            tx = foe.x;
            ty = foe.y;
        }
        if (tx === null) {
            this.mode = 'idle';
            return out;
        }
        // ---- horizontal steering ----
        const dx = tx - me.x;
        const wantRange = !hasWeapon || melee ? 0 : GUN_WANT_RANGE;
        const tol = melee || !hasWeapon ? 14 : GUN_RANGE_TOL;
        let dir = 0;
        if (!hasWeapon || melee) {
            if (dx > MOVE_DEADBAND)
                dir = 1;
            else if (dx < -MOVE_DEADBAND)
                dir = -1;
        }
        else if (Math.abs(dx) > wantRange + tol) {
            dir = dx > 0 ? 1 : -1; // too far: approach
        }
        else if (Math.abs(dx) < wantRange - tol) {
            dir = dx > 0 ? -1 : 1; // too close: back off
        }
        else if (foe) {
            // In range band: strafe slowly to dodge (difficulty-scaled direction).
            dir = Math.sin(time * 1.7 + this.seed) > 0 ? 1 : -1;
            if (this.difficulty < 0.3)
                dir = 0;
        }
        // Brief reversal when stuck against a wall.
        if (time < this.reverseUntil)
            dir = -dir || 1;
        // ---- hazard (lava) avoidance overrides steering ----
        const hazards = world.hazards ?? [];
        let lavaJump = false;
        for (const h of hazards) {
            const cx = me.x;
            const feet = me.y;
            const overX = cx > h.x - 46 && cx < h.x + h.w + 46;
            const nearY = feet > h.y - 110 && feet < h.y + 30;
            if (overX && nearY) {
                const hc = h.x + h.w / 2;
                dir = cx >= hc ? 1 : -1; // steer away from lava centre
                if (Math.abs(cx - hc) < h.w / 2 + 40)
                    lavaJump = true;
            }
            // Don't walk into lava lying between us and the target.
            if (foe &&
                nearY &&
                ((me.x < h.x && tx > h.x + h.w) || (me.x > h.x + h.w && tx < h.x))) {
                lavaJump = true;
            }
        }
        if (dir === 1) {
            out.right = true;
        }
        else if (dir === -1) {
            out.left = true;
        }
        // ---- jumping: target above, stuck, or lava ----
        this.trackStuck(me, time, dir);
        const dy = ty - me.y;
        const targetAbove = dy < -56;
        const wantJump = lavaJump || targetAbove || time < this.stuckUntil;
        if (wantJump && me.onGround && time >= this.nextJumpAt) {
            out.jump = true;
            this.nextJumpAt = time + JUMP_COOLDOWN;
        }
        // ---- aim (predict + difficulty error) ----
        if (foe) {
            const dist = foeDist;
            const lead = Math.max(0, Math.min(0.35, dist / 900));
            const ex = foe.x + foe.vx * lead;
            const ey = foe.y + foe.vy * lead;
            let ax = ex - me.x;
            let ay = ey - me.y;
            const l = Math.hypot(ax, ay) || 1;
            ax /= l;
            ay /= l;
            const err = (1 - this.difficulty) * 0.32 * Math.sin(time * 2.7 + this.seed) +
                (1 - this.difficulty) * 0.14 * Math.sin(time * 6.3 + this.seed * 2);
            const cos = Math.cos(err);
            const sin = Math.sin(err);
            out.aimX = ax * cos - ay * sin;
            out.aimY = ax * sin + ay * cos;
        }
        else if (dir !== 0) {
            out.aimX = dir;
            out.aimY = 0;
        }
        // ---- fire ----
        if (foe && time >= this.engageAt) {
            const maxRange = melee || !hasWeapon ? MELEE_RANGE + 26 : GUN_MAX_RANGE;
            // Line of sight: no platform data here — assume clear. The game layer
            // can AND this with its own raycast if it has one.
            const inRange = foeDist <= maxRange;
            const aimed = this.difficulty >= 0.75 || foeDist < 220 || Math.abs(dy) < 160 + this.difficulty * 200;
            if (hasWeapon && inRange && aimed)
                out.fire = true;
        }
        // ---- throw when nearly empty and close ----
        if (hasWeapon && !melee && me.ammo <= 1 && foe && foeDist < THROW_RANGE && time >= this.nextThrowAt) {
            out.throwReq = true;
            this.nextThrowAt = time + 1.0;
        }
        // ---- block: incoming projectiles, or melee brawls ----
        out.block = this.shouldBlock(me, world, foe, foeDist);
        return out;
    }
    trackStuck(me, time, dir) {
        if (time - this.lastCheck > 0.35) {
            const moved = Math.abs(me.x - this.lastX);
            if (dir !== 0 && moved < 5 && me.onGround) {
                this.stuckUntil = time + 0.3;
                this.reverseUntil = time + 0.25;
            }
            this.lastX = me.x;
            this.lastCheck = time;
        }
    }
    shouldBlock(me, world, foe, foeDist) {
        if (!me.alive)
            return false;
        // Duck incoming fire (reaction scales with difficulty).
        for (const pr of world.projectiles) {
            if (pr.owner === me.id)
                continue;
            const rx = me.x - pr.x;
            const ry = me.y - pr.y;
            const dist = Math.hypot(rx, ry);
            if (dist > 320 || dist < 1)
                continue;
            const approaching = pr.vx * rx + pr.vy * ry > 0;
            if (approaching && this.difficulty > 0.25)
                return true;
        }
        // Melee brawl guard.
        if (foe && foeDist < 110 && foe.weapon !== 'fists' && this.difficulty > 0.45)
            return true;
        return false;
    }
}
