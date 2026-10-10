import { WORLD_H, WORLD_W } from '../../shared/constants.js';
/** Normalized 0..1 rect -> pixel rect. */
export function denorm(r) {
    return {
        x: r.x * WORLD_W,
        y: r.y * WORLD_H,
        w: r.w * WORLD_W,
        h: r.h * WORLD_H,
    };
}
/** Level platforms -> pixel AABBs with material flags. */
export function levelToSolids(level) {
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
