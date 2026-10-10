/** Fixed-timestep game loop (60Hz accumulator with rAF interpolation). */

export class FixedLoop {
  static readonly STEP = 1 / 60;
  private static readonly MAX_FRAME = 0.25;
  private static readonly MAX_STEPS = 5;

  private raf = 0;
  private running = false;
  private last = 0;
  private acc = 0;

  constructor(
    private readonly step: (dt: number) => void,
    private readonly render: (alpha: number) => void,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    const tick = (t: number): void => {
      if (!this.running) return;
      let frame = (t - this.last) / 1000;
      this.last = t;
      if (frame < 0) frame = 0;
      if (frame > FixedLoop.MAX_FRAME) frame = FixedLoop.MAX_FRAME;
      this.acc += frame;
      let n = 0;
      while (this.acc >= FixedLoop.STEP && n < FixedLoop.MAX_STEPS) {
        this.step(FixedLoop.STEP);
        this.acc -= FixedLoop.STEP;
        n++;
      }
      // Drop backlog after hitches instead of spiralling.
      if (n === FixedLoop.MAX_STEPS) this.acc = 0;
      this.render(this.acc / FixedLoop.STEP);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.acc = 0;
  }
}
