import { GRAVITY, WORLD_H, WORLD_W } from '../../shared/constants.js';
import type { BarrelState, CrateState, DroppedGun, KillRectDef } from '../../shared/types.js';

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

function groundAt(world: any, c: { x: number; y: number; w: number; h: number }): boolean {
  const midX = c.x + c.w / 2;
  return solidAt(world, c.x + 1, c.y + c.h + 1) || solidAt(world, midX, c.y + c.h + 1) || solidAt(world, c.x + c.w - 1, c.y + c.h + 1);
}

export function stepCrates(crates: CrateState[], dt: number, world: any): void {
  dt = Math.min(Math.max(dt, 0), 1 / 30);
  for (const c of crates ?? []) {
    c.vy += GRAVITY * dt;
    if (c.vy > 1600) c.vy = 1600;
    c.x += (c.vx ?? 0) * dt;
    // Side bump: stop on wall.
    if (solidAt(world, c.x, c.y + c.h / 2) || solidAt(world, c.x + c.w, c.y + c.h / 2)) {
      c.x -= (c.vx ?? 0) * dt;
      c.vx = 0;
    }
    let ny = c.y + c.vy * dt;
    const floor = WORLD_H - c.h;
    if (world && typeof world.isSolid !== 'function' && !Array.isArray(world.solids)) {
      if (ny >= floor) { ny = floor; c.vy = 0; c.vx = (c.vx ?? 0) * (1 - Math.min(1, 6 * dt)); }
    } else {
      // Step back until free.
      let guard = 0;
      while (guard++ < 48 && (solidAt(world, c.x + 1, ny + c.h) || solidAt(world, c.x + c.w / 2, ny + c.h) || solidAt(world, c.x + c.w - 1, ny + c.h))) {
        ny -= 1;
        if (c.vy > 0) c.vy = 0;
      }
      if (groundAt(world, { x: c.x, y: ny, w: c.w, h: c.h })) {
        c.vy = 0;
        c.vx = (c.vx ?? 0) * (1 - Math.min(1, 6 * dt));
        if (Math.abs(c.vx) < 4) c.vx = 0;
      }
      if (ny > WORLD_H - c.h) { ny = WORLD_H - c.h; c.vy = 0; }
    }
    c.y = ny;
    if (c.x < 0) { c.x = 0; c.vx = 0; }
    if (c.x + c.w > WORLD_W) { c.x = WORLD_W - c.w; c.vx = 0; }
  }
}

export function stepBarrels(barrels: BarrelState[], dt: number, world: any): void {
  dt = Math.min(Math.max(dt, 0), 1 / 30);
  const BW = 22;
  const BH = 30;
  for (const b of barrels ?? []) {
    const v = b as BarrelState & { vy?: number; vx?: number };
    v.vy = (v.vy ?? 0) + GRAVITY * dt;
    if (v.vy > 1600) v.vy = 1600;
    let ny = b.y + (v.vy ?? 0) * dt;
    if (world && typeof world.isSolid !== 'function' && !Array.isArray(world.solids)) {
      const floor = WORLD_H - BH;
      if (ny >= floor) { ny = floor; v.vy = 0; }
    } else {
      let guard = 0;
      while (guard++ < 48 && (solidAt(world, b.x + 1, ny + BH) || solidAt(world, b.x + BW / 2, ny + BH) || solidAt(world, b.x + BW - 1, ny + BH))) {
        ny -= 1;
        v.vy = 0;
      }
      if (ny > WORLD_H - BH) { ny = WORLD_H - BH; v.vy = 0; }
    }
    b.y = ny;
  }
}

export function drawCrates(ctx: CanvasRenderingContext2D, crates: CrateState[]): void {
  for (const c of crates ?? []) {
    ctx.save();
    ctx.translate(c.x + c.w / 2, c.y + c.h / 2);
    ctx.rotate(c.angle ?? 0);
    const w = c.w, h = c.h;
    ctx.fillStyle = '#92400e';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = '#451a03';
    ctx.lineWidth = 2;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2, h / 2);
    ctx.moveTo(w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2);
    ctx.stroke();
    ctx.restore();
  }
}

export function drawBarrels(ctx: CanvasRenderingContext2D, barrels: BarrelState[]): void {
  for (const b of barrels ?? []) {
    const w = 22, h = 30;
    ctx.save();
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(b.x, b.y, w, h);
    ctx.strokeStyle = '#450a0a';
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, w, h);
    ctx.fillStyle = '#facc15';
    ctx.fillRect(b.x, b.y + h / 2 - 3, w, 6);
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('!', b.x + w / 2, b.y + 13);
    ctx.restore();
  }
}

export function drawDrops(ctx: CanvasRenderingContext2D, drops: DroppedGun[], time = 0): void {
  for (const d of drops ?? []) {
    const bob = Math.sin(time * 3 + d.x * 0.05) * 2;
    ctx.save();
    ctx.translate(d.x, d.y + bob);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(0, 10 - bob, 12, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(-11, -4, 22, 7);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(2, -2, 9, 4);
    ctx.fillStyle = '#fbbf24';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(d.weapon).slice(0, 6), 0, -6);
    ctx.restore();
  }
}

/** Green wiggly snake projectiles (kind 'snake' | 'snakeshot'). */
export function drawSnakes(
  ctx: CanvasRenderingContext2D,
  projs: { x: number; y: number; vx: number; vy: number; kind: string; id?: number }[],
  time = 0,
): void {
  for (const p of projs ?? []) {
    if (p.kind !== 'snake' && p.kind !== 'snakeshot') continue;
    const l = Math.hypot(p.vx, p.vy) || 1;
    const dx = p.vx / l;
    const dy = p.vy / l;
    const px = -dy;
    const py = dx;
    const phase = time * 14 + (p.id ?? p.x) * 0.7;
    ctx.save();
    ctx.lineCap = 'round';
    // Body: 4 trailing segments with sinusoidal wiggle, tapering.
    for (let i = 4; i >= 1; i--) {
      const back = i * 7;
      const wig = Math.sin(phase - i * 0.9) * (2 + i * 0.8);
      const sx = p.x - dx * back + px * wig;
      const sy = p.y - dy * back + py * wig;
      ctx.fillStyle = i % 2 === 0 ? '#22c55e' : '#16a34a';
      ctx.beginPath();
      ctx.arc(sx, sy, 5 - i * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Head.
    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#052e16';
    const ex = p.x + dx * 2;
    const ey = p.y + dy * 2;
    ctx.fillRect(ex - 2 + px * 2, ey - 1 + py * 2, 2, 2);
    ctx.fillRect(ex - 2 - px * 2, ey - 1 - py * 2, 2, 2);
    ctx.restore();
  }
}

function toPixels(r: KillRectDef): { x: number; y: number; w: number; h: number } {
  // Level defs are normalized 0..1; runtime may already be pixels.
  if (r.x <= 1.5 && r.y <= 1.5 && r.w <= 1.5 && r.h <= 1.5) {
    return { x: r.x * WORLD_W, y: r.y * WORLD_H, w: r.w * WORLD_W, h: r.h * WORLD_H };
  }
  return r;
}

export function drawKillRects(ctx: CanvasRenderingContext2D, killRects: KillRectDef[], time: number): void {  for (const k of killRects ?? []) {
    const r = toPixels(k);
    if (k.kind === 'spikes') {
      const n = Math.max(2, Math.floor(r.w / 16));
      const tw = r.w / n;
      ctx.fillStyle = '#9ca3af';
      ctx.strokeStyle = '#4b5563';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x0 = r.x + i * tw;
        ctx.moveTo(x0, r.y + r.h);
        ctx.lineTo(x0 + tw / 2, r.y);
        ctx.lineTo(x0 + tw, r.y + r.h);
      }
      ctx.fill();
      ctx.stroke();
    } else if (k.kind === 'lava') {
      const grad = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
      grad.addColorStop(0, '#fb923c');
      grad.addColorStop(1, '#dc2626');
      ctx.fillStyle = grad;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      // Animated bubbles / glow.
      ctx.fillStyle = 'rgba(254,243,199,0.85)';
      const n = Math.max(2, Math.floor(r.w / 48));
      for (let i = 0; i < n; i++) {
        const bx = r.x + ((i + 0.5) / n) * r.w + Math.sin(time * 2.4 + i * 1.7) * 6;
        const by = r.y + r.h * 0.45 + Math.cos(time * 3.1 + i * 2.3) * 3;
        ctx.beginPath();
        ctx.arc(bx, by, 3 + (Math.sin(time * 4 + i) * 0.5 + 0.5) * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // laser: cyan blinking with warning telegraph.
      const period = k.period ?? 2.2;
      const duty = k.duty ?? 0.5;
      const phase = k.phase ?? 0;
      const t = ((time + phase) % period + period) % period;
      const active = t < duty * period;
      const untilOn = active ? 0 : period * 1 - t;
      const aboutOn = !active && (untilOn < 0.45 || (duty * period - t) > -0.45 && t > duty * period - 0.45);
      if (active) {
        ctx.fillStyle = 'rgba(34,211,238,0.9)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = '#ecfeff';
        ctx.fillRect(r.x, r.y + r.h / 2 - 1.5, r.w, 3);
      } else {
        const blinkOn = Math.sin(time * 14) > 0;
        ctx.strokeStyle = aboutOn && blinkOn ? 'rgba(248,113,113,0.95)' : 'rgba(248,113,113,0.35)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
        if (aboutOn && blinkOn) {
          ctx.fillStyle = '#f87171';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('!', r.x + r.w / 2, r.y - 4);
        }
      }
    }
  }
}

/** Themed arena background. Covers the full world rect with animated deco. */
export function drawBackground(
  ctx: CanvasRenderingContext2D,
  theme: string,
  time: number,
): void {
  const t = String(theme ?? '').toLowerCase();
  const grad = ctx.createLinearGradient(0, 0, 0, WORLD_H);

  const fill = (top: string, bottom: string): void => {
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    ctx.fillStyle = grad;
    ctx.fillRect(-24, -24, WORLD_W + 48, WORLD_H + 48);
  };

  switch (t) {
    case 'woods':
    case 'windmill': {
      fill('#0e2a1a', '#2d5a27');
      // Canopy silhouettes.
      ctx.fillStyle = 'rgba(20,60,30,0.85)';
      for (let i = 0; i < 9; i++) {
        const x = ((i * 197) % WORLD_W);
        ctx.beginPath();
        ctx.moveTo(x, WORLD_H * 0.72);
        ctx.lineTo(x + 70, WORLD_H * 0.28);
        ctx.lineTo(x + 140, WORLD_H * 0.72);
        ctx.closePath();
        ctx.fill();
      }
      // Trunks (subtle, behind platforms so the platforms read clearly).
      ctx.fillStyle = 'rgba(91,58,30,0.4)';
      for (let i = 0; i < 9; i++) {
        const x = ((i * 197) % WORLD_W) + 62;
        ctx.fillRect(x + 4, WORLD_H * 0.68, 8, WORLD_H * 0.16);
      }
      // Fireflies.
      ctx.fillStyle = 'rgba(253,224,71,0.8)';
      for (let i = 0; i < 14; i++) {
        const x = (i * 173 + Math.sin(time * 0.7 + i) * 24 + WORLD_W) % WORLD_W;
        const y = WORLD_H * 0.25 + ((i * 97) % 260) + Math.cos(time + i) * 8;
        ctx.fillRect(x, y, 3, 3);
      }
      break;
    }
    case 'desert': {
      fill('#fde68a', '#d97706');
      // Sun.
      ctx.fillStyle = '#fef3c7';
      ctx.beginPath();
      ctx.arc(WORLD_W * 0.78, WORLD_H * 0.24, 54, 0, Math.PI * 2);
      ctx.fill();
      // Dunes.
      ctx.fillStyle = 'rgba(180,83,9,0.45)';
      ctx.beginPath();
      ctx.ellipse(WORLD_W * 0.25, WORLD_H * 0.78, 420, 70, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(WORLD_W * 0.85, WORLD_H * 0.86, 460, 80, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'factory':
    case 'foundry': {
      fill('#1f2937', '#431407');
      // Girders.
      ctx.fillStyle = 'rgba(251,146,60,0.16)';
      for (let i = 0; i < 6; i++) ctx.fillRect(60 + i * 210, 0, 14, WORLD_H);
      ctx.fillRect(0, WORLD_H * 0.22, WORLD_W, 10);
      // Warning lights (blink alternately).
      for (let i = 0; i < 6; i++) {
        const on = Math.sin(time * 3 + i * 1.4) > 0;
        ctx.fillStyle = on ? '#fbbf24' : 'rgba(251,191,36,0.25)';
        ctx.beginPath();
        ctx.arc(67 + i * 210, WORLD_H * 0.22, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      // Floor glow.
      ctx.fillStyle = 'rgba(249,115,22,0.12)';
      ctx.fillRect(-24, WORLD_H * 0.72, WORLD_W + 48, WORLD_H * 0.28);
      break;
    }
    case 'winter':
    case 'ice': {
      fill('#dbeafe', '#60a5fa');
      // Distant pines.
      ctx.fillStyle = 'rgba(30,64,175,0.35)';
      for (let i = 0; i < 10; i++) {
        const x = (i * 151) % WORLD_W;
        ctx.beginPath();
        ctx.moveTo(x, WORLD_H * 0.7);
        ctx.lineTo(x + 45, WORLD_H * 0.4);
        ctx.lineTo(x + 90, WORLD_H * 0.7);
        ctx.closePath();
        ctx.fill();
      }
      // Snowfall.
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      for (let i = 0; i < 60; i++) {
        const x = (i * 211 + time * (20 + (i % 5) * 8)) % WORLD_W;
        const y = (i * 137 + time * (40 + (i % 3) * 20)) % WORLD_H;
        ctx.fillRect(x, y, 3, 3);
      }
      // Snow floor tint.
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(-24, WORLD_H * 0.72, WORLD_W + 48, WORLD_H * 0.28);
      break;
    }
    case 'lava': {
      fill('#0c0a09', '#431407');
      // Glow at the bottom.
      const glow = ctx.createRadialGradient(
        WORLD_W / 2, WORLD_H, 40, WORLD_W / 2, WORLD_H, WORLD_W * 0.7,
      );
      glow.addColorStop(0, 'rgba(249,115,22,0.5)');
      glow.addColorStop(1, 'rgba(249,115,22,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(-24, -24, WORLD_W + 48, WORLD_H + 48);
      // Embers rising.
      for (let i = 0; i < 26; i++) {
        const x = (i * 197 + Math.sin(time * 1.3 + i) * 30 + WORLD_W) % WORLD_W;
        const y = WORLD_H - ((time * (30 + (i % 4) * 14) + i * 61) % WORLD_H);
        ctx.fillStyle = i % 3 === 0 ? 'rgba(252,211,77,0.9)' : 'rgba(249,115,22,0.8)';
        ctx.fillRect(x, y, 3, 3);
      }
      break;
    }
    case 'laser': {
      fill('#020617', '#0e7490');
      // Cyan grid, slowly scrolling.
      ctx.strokeStyle = 'rgba(34,211,238,0.22)';
      ctx.lineWidth = 1;
      const step = 64;
      const ox = (time * 12) % step;
      for (let x = -step; x < WORLD_W + step; x += step) {
        ctx.beginPath();
        ctx.moveTo(x + ox, 0);
        ctx.lineTo(x + ox, WORLD_H);
        ctx.stroke();
      }
      for (let y = 0; y < WORLD_H; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(WORLD_W, y);
        ctx.stroke();
      }
      // Horizon glow.
      ctx.fillStyle = 'rgba(34,211,238,0.1)';
      ctx.fillRect(-24, WORLD_H * 0.72, WORLD_W + 48, WORLD_H * 0.28);
      break;
    }
    case 'western': {
      fill('#fef3c7', '#92400e');
      // Sun + mesas.
      ctx.fillStyle = '#fdba74';
      ctx.beginPath();
      ctx.arc(WORLD_W * 0.5, WORLD_H * 0.34, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(120,53,15,0.65)';
      ctx.fillRect(WORLD_W * 0.06, WORLD_H * 0.5, 220, 130);
      ctx.fillRect(WORLD_W * 0.72, WORLD_H * 0.44, 260, 170);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(-24, WORLD_H * 0.72, WORLD_W + 48, WORLD_H * 0.28);
      break;
    }
    case 'halloween': {
      fill('#1e1b4b', '#6b21a8');
      // Moon.
      ctx.fillStyle = '#fef9c3';
      ctx.beginPath();
      ctx.arc(WORLD_W * 0.8, WORLD_H * 0.22, 44, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1e1b4b';
      ctx.beginPath();
      ctx.arc(WORLD_W * 0.78, WORLD_H * 0.2, 38, 0, Math.PI * 2);
      ctx.fill();
      // Bats (animated chevrons).
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const x = (i * 263 + time * (30 + i * 6)) % WORLD_W;
        const y = 90 + (i * 53) % 180 + Math.sin(time * 2 + i) * 10;
        ctx.beginPath();
        ctx.moveTo(x - 10, y);
        ctx.quadraticCurveTo(x - 3, y - 6, x, y);
        ctx.quadraticCurveTo(x + 3, y - 6, x + 10, y);
        ctx.stroke();
      }
      break;
    }
    case 'sunset': {
      fill('#1e1b4b', '#7c2d12');
      ctx.fillStyle = '#fdba74';
      ctx.beginPath();
      ctx.arc(WORLD_W * 0.7, WORLD_H * 0.32, 60, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (let i = 0; i < 8; i++) ctx.fillRect(((i * 197) % WORLD_W), (i * 89) % 300, 90, 120);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-24, WORLD_H * 0.72, WORLD_W + 48, WORLD_H * 0.28);
      break;
    }
    default: {
      fill('#111827', '#374151');
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-24, WORLD_H * 0.72, WORLD_W + 48, WORLD_H * 0.28);
      break;
    }
  }
}
