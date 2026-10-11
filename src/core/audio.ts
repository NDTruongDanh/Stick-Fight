/** Tiny WebAudio SFX synth — no assets, all guarded. Call ensure() from a user gesture. */

export type ShootKind = string;

export class Sfx {
  ctx?: AudioContext;
  muted = false;

  private master?: GainNode;

  /** Create/resume the AudioContext. Safe to call repeatedly. */
  ensure(): void {
    try {
      if (typeof window === 'undefined') return;
      if (!this.ctx) {
        const AC =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.32;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      /* audio unavailable — stay silent */
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
  }

  shoot(kind: ShootKind): void {
    try {
      switch (kind) {
        case 'shotgun':
        case 'sawedoff':
          this.noise(0.22, 0.9, 900);
          this.tone(160, 70, 0.18, 'square', 0.5);
          break;
        case 'sniper':
        case 'rpg':
          this.tone(1400, 140, 0.16, 'sawtooth', 0.5);
          this.noise(0.14, 0.5, 2400);
          break;
        case 'minigun':
        case 'uzi':
        case 'ak47':
        case 'm16':
          this.tone(850, 220, 0.06, 'square', 0.35);
          this.noise(0.05, 0.3, 3200);
          break;
        case 'grenade':
          this.tone(300, 120, 0.1, 'triangle', 0.4);
          break;
        case 'flamethrower':
          this.noise(0.18, 0.35, 1400);
          break;
        case 'bouncer':
          this.tone(1800, 300, 0.14, 'sawtooth', 0.4);
          break;
        case 'sword':
        case 'spear':
          this.noise(0.08, 0.4, 5000);
          this.tone(2500, 900, 0.06, 'sine', 0.25);
          break;
        default:
          // pistol / revolver / deagle / fists-ish pop
          this.tone(700, 180, 0.08, 'square', 0.45);
          this.noise(0.06, 0.35, 2800);
          break;
      }
    } catch {
      /* ignore */
    }
  }

  hit(): void {
    try {
      this.noise(0.08, 0.5, 2000);
      this.tone(220, 110, 0.08, 'triangle', 0.45);
    } catch {
      /* ignore */
    }
  }

  die(): void {
    try {
      this.tone(420, 55, 0.38, 'sawtooth', 0.5);
      this.noise(0.25, 0.4, 700);
    } catch {
      /* ignore */
    }
  }

  pickup(): void {
    try {
      this.tone(620, 930, 0.09, 'sine', 0.45);
      window.setTimeout(() => {
        try {
          this.tone(930, 1240, 0.09, 'sine', 0.4);
        } catch {
          /* ignore */
        }
      }, 70);
    } catch {
      /* ignore */
    }
  }

  jump(): void {
    try {
      this.tone(280, 560, 0.09, 'sine', 0.22);
    } catch {
      /* ignore */
    }
  }

  boom(): void {
    try {
      this.noise(0.6, 0.9, 420);
      this.tone(110, 28, 0.5, 'sine', 0.8);
    } catch {
      /* ignore */
    }
  }

  click(): void {
    try {
      this.tone(1050, 900, 0.035, 'square', 0.2);
    } catch {
      /* ignore */
    }
  }

  /** Weapon throw whoosh. */
  throwWeapon(): void {
    try {
      this.noise(0.16, 0.35, 1800);
      this.tone(500, 180, 0.14, 'sine', 0.3);
    } catch {
      /* ignore */
    }
  }

  /** Back-compat alias. */
  throw(): void {
    this.throwWeapon();
  }

  /** Block clang — metallic hit when damage is absorbed. */
  block(): void {
    try {
      this.tone(2400, 1700, 0.09, 'square', 0.3);
      this.tone(3200, 2400, 0.07, 'sine', 0.22);
      this.noise(0.06, 0.25, 6000);
    } catch {
      /* ignore */
    }
  }

  /** Alias used by game code. */
  clang(): void {
    this.block();
  }

  /** Round-win / match-win jingle — little major arpeggio. */
  win(): void {
    try {
      const notes: Array<[number, number]> = [[523, 0], [659, 90], [784, 180], [1046, 270]];
      for (const [f, delay] of notes) {
        window.setTimeout(() => {
          try {
            this.tone(f, f, 0.16, 'square', 0.28);
          } catch {
            /* ignore */
          }
        }, delay);
      }
    } catch {
      /* ignore */
    }
  }

  /** Alias for the win jingle. */
  roundWin(): void {
    this.win();
  }

  private ready(): boolean {
    return !this.muted && !!this.ctx && !!this.master && this.ctx.state === 'running';
  }

  private tone(from: number, to: number, dur: number, type: OscillatorType, vol: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx as AudioContext;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, from), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(this.master as GainNode);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, cutoff: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx as AudioContext;
    const t = ctx.currentTime;
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.master as GainNode);
    src.start(t);
  }
}
