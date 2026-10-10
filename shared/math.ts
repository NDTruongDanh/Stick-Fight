// Shared math helpers (no deps, usable client + server)
export interface Vec2 { x: number; y: number }
export const v = (x = 0, y = 0): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const norm = (a: Vec2): Vec2 => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const clamp = (n: number, a: number, b: number): number => Math.max(a, Math.min(b, n));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export interface AABB { x: number; y: number; w: number; h: number }
export function aabbOverlap(a: AABB, b: AABB): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
