/** Keyboard + mouse + gamepad input. DOM listeners only live here (attach/detach). */
import { WORLD_W, WORLD_H } from '../../shared/constants.js';
/**
 * Slot 0 (P1): A/D move, W/Space/Q jump, S down, mouse-left or C fire,
 *   mouse-right or V block, F throw, mouse aim.
 * Slot 1 (P2): Arrows move/jump/down, Comma fire, Period block, Slash throw,
 *   aim defaults to facing.
 * Slot 2: I/J/K/L + U/O/P. Slot 3: Numpad. Slots 2-3 mainly for gamepads.
 */
const SLOT_KEYS = [
    {
        left: ['KeyA'],
        right: ['KeyD'],
        jump: ['KeyW', 'Space', 'KeyQ'],
        down: ['KeyS'],
        fire: ['KeyC'],
        block: ['KeyV'],
        throw: ['KeyF'],
    },
    {
        left: ['ArrowLeft'],
        right: ['ArrowRight'],
        jump: ['ArrowUp', 'Numpad0'],
        down: ['ArrowDown'],
        fire: ['Comma', 'ControlRight'],
        block: ['Period'],
        throw: ['Slash'],
    },
    {
        left: ['KeyJ'],
        right: ['KeyL'],
        jump: ['KeyI'],
        down: ['KeyK'],
        fire: ['KeyU'],
        block: ['KeyO'],
        throw: ['KeyP'],
    },
    {
        left: ['Numpad4'],
        right: ['Numpad6'],
        jump: ['Numpad8'],
        down: ['Numpad5'],
        fire: ['Numpad1'],
        block: ['Numpad2'],
        throw: ['Numpad3'],
    },
];
const PREVENT_DEFAULT = new Set([
    'Space',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Slash',
]);
const PAD_DEADZONE = 0.25;
const AIM_DEADZONE = 0.35;
const MAX_SLOTS = 4;
function anyDown(keys, codes) {
    for (const c of codes)
        if (keys.has(c))
            return true;
    return false;
}
function isTypingTarget(e) {
    const el = e.target;
    if (!el || typeof el.tagName !== 'string')
        return false;
    const tag = el.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}
export class Input {
    constructor() {
        Object.defineProperty(this, "keys", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Set()
        });
        Object.defineProperty(this, "mouse", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: { x: 0, y: 0, left: false, right: false }
        });
        Object.defineProperty(this, "canvas", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "attached", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "mouseActive", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "prevThrow", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: [false, false, false, false]
        });
        Object.defineProperty(this, "facing", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: [1, 1, 1, 1]
        });
        // Bound handlers so detach() removes exactly what attach() added.
        Object.defineProperty(this, "onKeyDown", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (e) => {
                if (isTypingTarget(e))
                    return;
                this.keys.add(e.code);
                if (PREVENT_DEFAULT.has(e.code))
                    e.preventDefault();
            }
        });
        Object.defineProperty(this, "onKeyUp", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (e) => {
                this.keys.delete(e.code);
            }
        });
        Object.defineProperty(this, "onBlur", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => {
                this.keys.clear();
                this.mouse.left = false;
                this.mouse.right = false;
            }
        });
        Object.defineProperty(this, "onMouseMove", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (e) => {
                if (!this.canvas)
                    return;
                const r = this.canvas.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0)
                    return;
                this.mouse.x = e.clientX - r.left;
                this.mouse.y = e.clientY - r.top;
                this.mouseActive = true;
            }
        });
        Object.defineProperty(this, "onMouseDown", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (e) => {
                if (e.button === 0)
                    this.mouse.left = true;
                else if (e.button === 2)
                    this.mouse.right = true;
            }
        });
        Object.defineProperty(this, "onMouseUp", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (e) => {
                if (e.button === 0)
                    this.mouse.left = false;
                else if (e.button === 2)
                    this.mouse.right = false;
            }
        });
        Object.defineProperty(this, "onContextMenu", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (e) => {
                e.preventDefault();
            }
        });
    }
    attach(canvas) {
        if (this.attached)
            this.detach();
        this.canvas = canvas;
        this.attached = true;
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('blur', this.onBlur);
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
        canvas.addEventListener('mousedown', this.onMouseDown);
        canvas.addEventListener('contextmenu', this.onContextMenu);
    }
    detach() {
        if (!this.attached)
            return;
        this.attached = false;
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        this.canvas?.removeEventListener('mousedown', this.onMouseDown);
        this.canvas?.removeEventListener('contextmenu', this.onContextMenu);
        this.canvas = null;
        this.onBlur();
    }
    /**
     * Full poll. px/py = player world pos, facing = +/-1; used to turn the
     * mouse position (world-space via canvas scale) into an aim direction.
     */
    read(slot, px = 0, py = 0, facing = 1, rect) {
        return this.poll(slot, px, py, facing, rect);
    }
    /** Convenience alias for local play (extra player-context params optional). */
    readLocal(index, rect, px = 0, py = 0, facing = 1) {
        return this.poll(index, px, py, facing, rect);
    }
    /**
     * Edge-triggered throw: true once per press. The throwReq field on
     * read()/readLocal() is level (held); game code that needs an edge
     * should call this instead.
     */
    consumeThrow(slot) {
        const s = this.clampSlot(slot);
        const held = this.throwHeld(s);
        const edge = held && !this.prevThrow[s];
        this.prevThrow[s] = held;
        return edge;
    }
    // ---- internals ----
    clampSlot(slot) {
        if (!Number.isFinite(slot))
            return 0;
        return Math.max(0, Math.min(MAX_SLOTS - 1, Math.floor(slot)));
    }
    pad(slot) {
        try {
            if (typeof navigator === 'undefined' || !navigator.getGamepads)
                return null;
            const pads = navigator.getGamepads();
            if (!pads)
                return null;
            const p = pads[slot];
            return p && p.connected ? p : null;
        }
        catch {
            return null;
        }
    }
    static padBtn(p, i) {
        const b = p.buttons[i];
        return !!b && (b.pressed || b.value > 0.4);
    }
    throwHeld(slot) {
        if (anyDown(this.keys, SLOT_KEYS[slot].throw))
            return true;
        const p = this.pad(slot);
        if (p && Input.padBtn(p, 2))
            return true; // X
        return false;
    }
    poll(slot, px, py, facing, rect) {
        const s = this.clampSlot(slot);
        const kb = SLOT_KEYS[s];
        let left = anyDown(this.keys, kb.left);
        let right = anyDown(this.keys, kb.right);
        let jump = anyDown(this.keys, kb.jump);
        let down = anyDown(this.keys, kb.down);
        let fire = anyDown(this.keys, kb.fire);
        let block = anyDown(this.keys, kb.block);
        const throwReq = anyDown(this.keys, kb.throw);
        // P1 mouse buttons.
        if (s === 0) {
            fire = fire || this.mouse.left;
            block = block || this.mouse.right;
        }
        // Gamepad merge: left stick move, A jump, RT fire, LB block, X throw,
        // dpad-down/left-stick-down for down, right stick aim.
        let padAimX = 0;
        let padAimY = 0;
        let padAiming = false;
        const p = this.pad(s);
        if (p) {
            const lx = p.axes[0] ?? 0;
            const ly = p.axes[1] ?? 0;
            if (lx < -PAD_DEADZONE)
                left = true;
            else if (lx > PAD_DEADZONE)
                right = true;
            if (ly > 0.55)
                down = true;
            if (Input.padBtn(p, 0))
                jump = true; // A
            if (Input.padBtn(p, 7) || Input.padBtn(p, 5))
                fire = true; // RT (+RB alt)
            if (Input.padBtn(p, 4))
                block = true; // LB
            if (Input.padBtn(p, 13))
                down = true; // dpad down
            const rx = p.axes[2] ?? 0;
            const ry = p.axes[3] ?? 0;
            if (Math.hypot(rx, ry) > AIM_DEADZONE) {
                const l = Math.hypot(rx, ry);
                padAimX = rx / l;
                padAimY = ry / l;
                padAiming = true;
            }
        }
        const f = facing === -1 ? -1 : 1;
        if (left && !right)
            this.facing[s] = -1;
        else if (right && !left)
            this.facing[s] = 1;
        else
            this.facing[s] = f;
        // Aim priority: gamepad right stick > mouse (slot 0) > facing.
        let aimX;
        let aimY;
        if (padAiming) {
            aimX = padAimX;
            aimY = padAimY;
        }
        else if (s === 0 && this.mouseActive) {
            const r = rect ?? this.canvas?.getBoundingClientRect() ?? null;
            if (r && r.width > 0 && r.height > 0) {
                // World-space aim via canvas scale.
                const wx = (this.mouse.x / r.width) * WORLD_W;
                const wy = (this.mouse.y / r.height) * WORLD_H;
                const dx = wx - px;
                const dy = wy - py;
                const l = Math.hypot(dx, dy);
                if (l > 1e-4) {
                    aimX = dx / l;
                    aimY = dy / l;
                }
                else {
                    aimX = this.facing[s];
                    aimY = 0;
                }
            }
            else {
                aimX = this.facing[s];
                aimY = 0;
            }
        }
        else {
            aimX = this.facing[s];
            aimY = 0;
        }
        return { left, right, jump, down, fire, block, throwReq, aimX, aimY };
    }
}
