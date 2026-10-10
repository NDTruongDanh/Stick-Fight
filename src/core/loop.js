/** Fixed-timestep game loop (60Hz accumulator with rAF interpolation). */
export class FixedLoop {
    constructor(step, render) {
        Object.defineProperty(this, "step", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: step
        });
        Object.defineProperty(this, "render", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: render
        });
        Object.defineProperty(this, "raf", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "running", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "last", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "acc", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
    }
    get isRunning() {
        return this.running;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.last = performance.now();
        this.acc = 0;
        const tick = (t) => {
            if (!this.running)
                return;
            let frame = (t - this.last) / 1000;
            this.last = t;
            if (frame < 0)
                frame = 0;
            if (frame > FixedLoop.MAX_FRAME)
                frame = FixedLoop.MAX_FRAME;
            this.acc += frame;
            let n = 0;
            while (this.acc >= FixedLoop.STEP && n < FixedLoop.MAX_STEPS) {
                this.step(FixedLoop.STEP);
                this.acc -= FixedLoop.STEP;
                n++;
            }
            // Drop backlog after hitches instead of spiralling.
            if (n === FixedLoop.MAX_STEPS)
                this.acc = 0;
            this.render(this.acc / FixedLoop.STEP);
            this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
    }
    stop() {
        this.running = false;
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.acc = 0;
    }
}
Object.defineProperty(FixedLoop, "STEP", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 1 / 60
});
Object.defineProperty(FixedLoop, "MAX_FRAME", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 0.25
});
Object.defineProperty(FixedLoop, "MAX_STEPS", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 5
});
