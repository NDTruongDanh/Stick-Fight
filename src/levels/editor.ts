import type { LevelDef } from '../../shared/types.js';

const KEY = 'sf_custom';

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  level?: LevelDef;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const in01 = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;

function box(errs: string[], label: string, b: unknown): void {
  if (typeof b !== 'object' || b === null) {
    errs.push(`${label}: must be an object with x/y/w/h`);
    return;
  }
  const r = b as Record<string, unknown>;
  for (const k of ['x', 'y', 'w', 'h']) {
    if (!in01(r[k])) errs.push(`${label}.${k}: must be a number in 0..1`);
  }
  if (isNum(r.w) && r.w <= 0) errs.push(`${label}.w: must be > 0`);
  if (isNum(r.h) && r.h <= 0) errs.push(`${label}.h: must be > 0`);
  if (in01(r.x) && in01(r.w) && (r.x as number) + (r.w as number) > 1 + 1e-6) {
    errs.push(`${label}: x+w must be <= 1`);
  }
  if (in01(r.y) && in01(r.h) && (r.y as number) + (r.h as number) > 1 + 1e-6) {
    errs.push(`${label}: y+h must be <= 1`);
  }
}

function point(errs: string[], label: string, p: unknown): void {
  if (!Array.isArray(p) || p.length !== 2 || !in01(p[0]) || !in01(p[1])) {
    errs.push(`${label}: must be [x, y] with both numbers in 0..1`);
  }
}

/**
 * Validate an unknown parsed-JSON value as a LevelDef.
 * All coordinates are normalized (0..1); spawns must be exactly 4 points.
 */
export function validateLevel(json: unknown): ValidateResult {
  const errors: string[] = [];
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, errors: ['level: must be a JSON object'] };
  }
  const lv = json as Record<string, unknown>;

  if (typeof lv.id !== 'string' || !lv.id.trim()) errors.push('id: must be a non-empty string');
  if (typeof lv.name !== 'string' || !lv.name.trim()) errors.push('name: must be a non-empty string');
  if (typeof lv.theme !== 'string' || !lv.theme.trim()) errors.push('theme: must be a non-empty string');

  if (!Array.isArray(lv.platforms) || lv.platforms.length === 0) {
    errors.push('platforms: must be a non-empty array');
  } else {
    lv.platforms.forEach((p, i) => {
      box(errors, `platforms[${i}]`, p);
      if (typeof p === 'object' && p !== null) {
        const r = p as Record<string, unknown>;
        if (r.type !== undefined && !['static', 'ice', 'bouncy', 'conveyor', 'blink', 'lava'].includes(r.type as string)) {
          errors.push(`platforms[${i}].type: unknown platform type`);
        }
        if (r.beltSpeed !== undefined && !isNum(r.beltSpeed)) errors.push(`platforms[${i}].beltSpeed: must be a number`);
        for (const k of ['period', 'duty', 'phase'] as const) {
          if (r[k] !== undefined && !isNum(r[k])) errors.push(`platforms[${i}].${k}: must be a number`);
        }
      }
    });
  }

  if (lv.movers !== undefined) {
    if (!Array.isArray(lv.movers)) errors.push('movers: must be an array');
    else lv.movers.forEach((m, i) => {
      box(errors, `movers[${i}]`, m);
      if (typeof m === 'object' && m !== null) {
        const r = m as Record<string, unknown>;
        if (r.axis !== 'x' && r.axis !== 'y') errors.push(`movers[${i}].axis: must be "x" or "y"`);
        if (!isNum(r.range) || (r.range as number) < 0 || (r.range as number) > 1) {
          errors.push(`movers[${i}].range: must be a number in 0..1`);
        }
        if (!isNum(r.period) || (r.period as number) <= 0) errors.push(`movers[${i}].period: must be a number > 0`);
        if (r.phase !== undefined && !isNum(r.phase)) errors.push(`movers[${i}].phase: must be a number`);
      }
    });
  }

  if (lv.rotators !== undefined) {
    if (!Array.isArray(lv.rotators)) errors.push('rotators: must be an array');
    else lv.rotators.forEach((r, i) => {
      if (typeof r !== 'object' || r === null) {
        errors.push(`rotators[${i}]: must be an object`);
        return;
      }
      const q = r as Record<string, unknown>;
      for (const k of ['cx', 'cy', 'w', 'h'] as const) {
        if (!in01(q[k])) errors.push(`rotators[${i}].${k}: must be a number in 0..1`);
      }
      if (!isNum(q.angleSpeed)) errors.push(`rotators[${i}].angleSpeed: must be a number`);
    });
  }

  if (lv.crates !== undefined) {
    if (!Array.isArray(lv.crates)) errors.push('crates: must be an array');
    else lv.crates.forEach((c, i) => box(errors, `crates[${i}]`, c));
  }

  if (lv.barrels !== undefined) {
    if (!Array.isArray(lv.barrels)) errors.push('barrels: must be an array');
    else lv.barrels.forEach((b, i) => {
      if (typeof b !== 'object' || b === null) {
        errors.push(`barrels[${i}]: must be an object with x/y`);
        return;
      }
      const q = b as Record<string, unknown>;
      if (!in01(q.x)) errors.push(`barrels[${i}].x: must be a number in 0..1`);
      if (!in01(q.y)) errors.push(`barrels[${i}].y: must be a number in 0..1`);
    });
  }

  if (lv.killRects !== undefined) {
    if (!Array.isArray(lv.killRects)) errors.push('killRects: must be an array');
    else lv.killRects.forEach((k, i) => {
      box(errors, `killRects[${i}]`, k);
      if (typeof k === 'object' && k !== null) {
        const q = k as Record<string, unknown>;
        if (q.kind !== 'spikes' && q.kind !== 'lava' && q.kind !== 'laser') {
          errors.push(`killRects[${i}].kind: must be "spikes", "lava" or "laser"`);
        }
        for (const f of ['period', 'duty', 'phase'] as const) {
          if (q[f] !== undefined && !isNum(q[f])) errors.push(`killRects[${i}].${f}: must be a number`);
        }
      }
    });
  }

  if (!Array.isArray(lv.spawns) || lv.spawns.length !== 4) {
    errors.push('spawns: must be an array of exactly 4 [x, y] points');
  } else {
    lv.spawns.forEach((s, i) => point(errors, `spawns[${i}]`, s));
  }

  if (!Array.isArray(lv.weaponDrops) || lv.weaponDrops.length === 0) {
    errors.push('weaponDrops: must be a non-empty array of [x, y] points');
  } else {
    lv.weaponDrops.forEach((d, i) => point(errors, `weaponDrops[${i}]`, d));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], level: lv as unknown as LevelDef };
}

/** Pretty-print a level for the editor textarea / sharing. */
export function exportLevel(level: LevelDef): string {
  return JSON.stringify(level, null, 2);
}

/** Parse + validate pasted JSON. Throws an Error listing all problems. */
export function importLevel(text: string): LevelDef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON: could not parse');
  }
  const res = validateLevel(parsed);
  if (!res.ok || !res.level) throw new Error(`Invalid level:\n- ${res.errors.join('\n- ')}`);
  return res.level;
}

/** Minimal valid level to start editing from. */
export function blankLevel(): LevelDef {
  return {
    id: 'custom1',
    name: 'My Arena',
    theme: 'woods',
    platforms: [
      { x: 0, y: 0.9, w: 1, h: 0.1 },
      { x: 0.3, y: 0.6, w: 0.4, h: 0.035 },
    ],
    spawns: [[0.1, 0.8], [0.9, 0.8], [0.35, 0.5], [0.65, 0.5]],
    weaponDrops: [[0.5, 0.5]],
  };
}

export function saveCustom(level: LevelDef): void {
  try {
    localStorage.setItem(KEY, exportLevel(level));
  } catch {
    /* storage unavailable — ignore */
  }
}

export function loadCustom(): LevelDef | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const res = validateLevel(JSON.parse(raw));
    return res.ok ? (res.level as LevelDef) : null;
  } catch {
    return null;
  }
}

export function clearCustom(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}
