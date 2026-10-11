import type { PlayerState, WeaponId } from '../../shared/types.js';

const PW = 26;
const PH = 54;

type Extra = {
  hpBlink?: unknown;
  blockHeld?: unknown;
  /** Seconds since spawn — blink while >0 (spawn invuln ~1s). */
  invulnT?: unknown;
  spawnT?: unknown;
  /** 0..1 squash amount set on landing; decays in game code. */
  squash?: unknown;
  /** Seconds since death — drives ragdoll fall + fade. */
  deadT?: unknown;
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Gun silhouette per weapon family: long rifles vs pistols vs blades. */
function gunShape(weapon: WeaponId): { len: number; wid: number; color: string; blade: boolean } {
  switch (weapon) {
    case 'sniper':
    case 'ak47':
    case 'm16':
    case 'minigun':
      return { len: 26, wid: 7, color: '#1c1917', blade: false };
    case 'shotgun':
    case 'sawedoff':
      return { len: 22, wid: 9, color: '#451a03', blade: false };
    case 'rpg':
      return { len: 28, wid: 10, color: '#374151', blade: false };
    case 'uzi':
    case 'bouncer':
      return { len: 14, wid: 7, color: '#1c1917', blade: false };
    case 'grenade':
    case 'flamethrower':
      return { len: 12, wid: 9, color: '#374151', blade: false };
    case 'sword':
      return { len: 34, wid: 5, color: '#e5e7eb', blade: true };
    case 'spear':
      return { len: 42, wid: 4, color: '#d6d3d1', blade: true };
    case 'revolver':
    case 'deagle':
    case 'pistol':
    default:
      return { len: 10, wid: 6, color: '#111827', blade: false };
  }
}

export function drawStick(ctx: CanvasRenderingContext2D, p: PlayerState, time: number): void {
  const cx = p.x + PW / 2;
  const feet = p.y + PH;
  const dead = !p.alive || p.hp <= 0;
  const ex = p as PlayerState & Extra;
  const blink = ex.hpBlink;
  const flash = typeof blink === 'number' ? blink > 0 : !!blink;
  const blocking = !!ex.blockHeld;

  const invulnRaw = num(ex.invulnT) ?? num(ex.spawnT) ?? 0;
  const invuln = invulnRaw > 0;
  // Spawn-invuln blink: hide every other 80ms so 1s reads as flashing.
  const invulnHidden = invuln && Math.floor(time * 12) % 2 === 0;

  const squashRaw = num(ex.squash) ?? 0;
  const squash = Math.max(0, Math.min(1, squashRaw));
  const deadT = num(ex.deadT) ?? (dead ? 1 : 0);
  const vy = p.vy ?? 0;
  const flail = !dead && !p.onGround && vy > 800;

  const body = flash ? '#ffffff' : (p.color || '#fff');
  const speed = Math.abs(p.vx ?? 0);

  ctx.save();
  if (invulnHidden && !dead) ctx.globalAlpha = 0.35;
  if (dead) {
    // Ragdoll: fall over + fade out over ~1.2s.
    const k = Math.max(0, Math.min(1, deadT / 1.2));
    ctx.globalAlpha = 0.75 * (1 - k * 0.7);
    ctx.translate(cx, feet);
    const dir = p.facing < 0 ? 1 : -1;
    ctx.rotate(dir * Math.min(1, deadT * 3) * (Math.PI / 2) * 0.9);
    ctx.translate(-cx, -feet);
  } else if (squash > 0.01) {
    // Squash on land: widen + shorten briefly.
    ctx.translate(cx, feet);
    ctx.scale(1 + squash * 0.35, 1 - squash * 0.32);
    ctx.translate(-cx, -feet);
  } else if (!p.onGround && vy < -100) {
    // Stretch slightly on jump rise.
    ctx.translate(cx, feet);
    ctx.scale(0.96, 1.05);
    ctx.translate(-cx, -feet);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const hipY = feet - 22;
  const shY = feet - 38;
  const headY = feet - 48;
  const headR = 7;
  const lean = Math.max(-4, Math.min(4, (p.vx ?? 0) / 140));

  // Helper: stroke current path with black outline then body color.
  const outlineStroke = (color: string, w: number): void => {
    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = w + 2.4;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
  };

  // Legs
  ctx.beginPath();
  if (!p.onGround && !dead) {
    if (flail) {
      // Flail: limbs spread wide + asymmetric kick when falling fast.
      const wig = Math.sin(time * 22) * 4;
      ctx.moveTo(cx, hipY);
      ctx.lineTo(cx - 14 + wig, feet - 1);
      ctx.moveTo(cx, hipY);
      ctx.lineTo(cx + 14 - wig, feet - 1);
    } else if ((p.vy ?? 0) < 60) {
      // Jump tuck
      ctx.moveTo(cx, hipY);
      ctx.lineTo(cx - 8 + lean, hipY + 10);
      ctx.lineTo(cx - 4 + lean, hipY + 18);
      ctx.moveTo(cx, hipY);
      ctx.lineTo(cx + 8 + lean, hipY + 8);
      ctx.lineTo(cx + 11 + lean, hipY + 17);
    } else {
      // Fall spread
      ctx.moveTo(cx, hipY);
      ctx.lineTo(cx - 11, feet - 1);
      ctx.moveTo(cx, hipY);
      ctx.lineTo(cx + 11, feet - 1);
    }
  } else if (!dead && speed > 40) {
    const ph = time * 13 + (p.id || 0);
    const s1 = Math.sin(ph) * 10;
    const s2 = Math.sin(ph + Math.PI) * 10;
    const l1 = Math.max(0, Math.cos(ph)) * -4;
    const l2 = Math.max(0, Math.cos(ph + Math.PI)) * -4;
    ctx.moveTo(cx, hipY);
    ctx.lineTo(cx + s1 * 0.6 + lean, feet - 1 + l1);
    ctx.moveTo(cx, hipY);
    ctx.lineTo(cx + s2 * 0.6 + lean, feet - 1 + l2);
  } else {
    // Idle stance
    ctx.moveTo(cx, hipY);
    ctx.lineTo(cx - 6, feet - 1);
    ctx.moveTo(cx, hipY);
    ctx.lineTo(cx + 6, feet - 1);
  }
  outlineStroke(body, 3.5);

  // Spine
  ctx.beginPath();
  ctx.moveTo(cx, hipY);
  ctx.lineTo(cx + lean * 0.7, shY);
  outlineStroke(body, 3.5);

  // Arms: back arm + aim arm.
  let ang = Math.atan2(p.aimY ?? 0, (p.aimX ?? p.facing ?? 1));
  if (!Number.isFinite(ang)) ang = 0;
  if (Math.abs(p.aimX ?? 0) < 0.05 && Math.abs(p.aimY ?? 0) < 0.05) {
    ang = p.facing < 0 ? Math.PI : 0;
  }
  // Flailing arms go up/out instead of aiming.
  let aimAng = ang;
  if (flail) aimAng = -Math.PI / 2 + Math.sin(time * 20) * 0.5;
  const punching = p.weapon === 'fists' && p.cooldown > 0;
  const reach = punching ? 22 : flail ? 16 : 13;
  const hx = cx + lean * 0.7 + Math.cos(aimAng) * reach;
  const hy = shY + Math.sin(aimAng) * reach;

  // Back arm (small guard) — hidden while flailing (both arms out).
  ctx.beginPath();
  if (flail) {
    const bx2 = cx + lean * 0.7 + Math.cos(aimAng + 1.2) * 15;
    const by2 = shY + Math.sin(aimAng + 1.2) * 15;
    ctx.moveTo(cx + lean * 0.7, shY);
    ctx.lineTo(bx2, by2);
  } else {
    const bx = cx + lean * 0.7 - Math.cos(ang) * 4;
    ctx.moveTo(cx + lean * 0.7, shY);
    ctx.lineTo(bx, shY + 8);
  }
  outlineStroke(body, 3);
  // Aim / punch arm
  ctx.beginPath();
  ctx.moveTo(cx + lean * 0.7, shY);
  ctx.lineTo(hx, hy);
  outlineStroke(body, 3);
  // Fist dot
  ctx.fillStyle = body;
  ctx.strokeStyle = '#0a0a0a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(hx, hy, punching ? 3.4 : 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Gun / blade shape per weapon family.
  if (p.weapon !== 'fists' && !dead) {
    const gs = gunShape(p.weapon);
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(ang);
    // Black outline then fill.
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(-1, -gs.wid / 2 - 1.5, gs.len + 3, gs.wid + 3);
    ctx.fillStyle = gs.color;
    ctx.fillRect(0, -gs.wid / 2, gs.len, gs.wid);
    if (gs.blade) {
      // Blade highlight + guard.
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(4, -1, gs.len - 8, 2);
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(-3, -gs.wid / 2 - 3, 3, gs.wid + 6);
    } else if (gs.len >= 20) {
      // Rifle stock + sight.
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(-5, 0, 6, 5);
      ctx.fillRect(gs.len * 0.55, -gs.wid / 2 - 3, 3, 3);
    } else {
      // Pistol sight.
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(gs.len - 3, -gs.wid / 2, 2, 2);
    }
    ctx.restore();
  }

  // Head
  ctx.beginPath();
  ctx.arc(cx + lean * 0.5, headY, headR, 0, Math.PI * 2);
  ctx.fillStyle = flash ? '#ffffff' : body;
  ctx.fill();
  ctx.strokeStyle = '#0a0a0a';
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.strokeStyle = body;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(cx + lean * 0.5, headY, headR - 1.5, 0, Math.PI * 2);
  ctx.stroke();

  // Eyes
  const exOff = (p.facing < 0 ? -1 : 1) * 2.5;
  if (dead) {
    // X eyes
    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = 2.6;
    for (const dx of [-3 + exOff, 3 + exOff]) {
      const ey = headY - 1;
      ctx.beginPath();
      ctx.moveTo(cx + dx - 2, ey - 2);
      ctx.lineTo(cx + dx + 2, ey + 2);
      ctx.moveTo(cx + dx + 2, ey - 2);
      ctx.lineTo(cx + dx - 2, ey + 2);
      ctx.stroke();
    }
    ctx.strokeStyle = body;
    ctx.lineWidth = 1.8;
    for (const dx of [-3 + exOff, 3 + exOff]) {
      const ey = headY - 1;
      ctx.beginPath();
      ctx.moveTo(cx + dx - 2, ey - 2);
      ctx.lineTo(cx + dx + 2, ey + 2);
      ctx.moveTo(cx + dx + 2, ey - 2);
      ctx.lineTo(cx + dx - 2, ey + 2);
      ctx.stroke();
    }
  } else if (!flail) {
    ctx.fillStyle = flash ? '#ffffff' : '#111827';
    ctx.beginPath();
    ctx.arc(cx + exOff - 2, headY - 1, 1.4, 0, Math.PI * 2);
    ctx.arc(cx + exOff + 2.5, headY - 1, 1.4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Flail: wide spiral eyes (>_< squeezed shut).
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.6;
    for (const dx of [-3 + exOff, 3 + exOff]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx - 2, headY - 1);
      ctx.lineTo(cx + dx + 2, headY - 1);
      ctx.stroke();
    }
  }

  // Block shield arc
  if (blocking && !dead) {
    ctx.strokeStyle = 'rgba(103,232,249,0.9)';
    ctx.lineWidth = 3;
    const sa = ang - 1.1;
    const ea = ang + 1.1;
    ctx.beginPath();
    ctx.arc(cx + lean * 0.7, shY + 6, 20, sa, ea);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(103,232,249,0.25)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(cx + lean * 0.7, shY + 6, 20, sa, ea);
    ctx.stroke();
  }

  ctx.restore();
}
