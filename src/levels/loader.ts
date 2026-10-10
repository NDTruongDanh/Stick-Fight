import { WORLD_H, WORLD_W } from '../../shared/constants.js';
import type { LevelDef, PlatformType } from '../../shared/types.js';

export interface NormRect { x: number; y: number; w: number; h: number }

export interface PixelRect { x: number; y: number; w: number; h: number }

export interface SolidRect extends PixelRect {
  type: PlatformType;
  beltSpeed: number;
  period: number;
  duty: number;
  phase: number;
}

/** Normalized 0..1 rect -> pixel rect. */
export function denorm(r: NormRect): PixelRect {
  return {
    x: r.x * WORLD_W,
    y: r.y * WORLD_H,
    w: r.w * WORLD_W,
    h: r.h * WORLD_H,
  };
}

/** Level platforms -> pixel AABBs with material flags. */
export function levelToSolids(level: LevelDef): SolidRect[] {
  return level.platforms.map((p) => {
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
}
