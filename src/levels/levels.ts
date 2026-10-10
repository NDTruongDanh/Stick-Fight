import type { LevelDef } from '../../shared/types.js';

export const LEVELS: LevelDef[] = [
  {
    id: 'woods1', name: 'Woods 1', theme: 'woods',
    platforms: [
      { x: 0, y: 0.9, w: 1, h: 0.1 },
      { x: 0.08, y: 0.68, w: 0.2, h: 0.035 },
      { x: 0.72, y: 0.68, w: 0.2, h: 0.035 },
      { x: 0.32, y: 0.5, w: 0.36, h: 0.035 },
      { x: 0.42, y: 0.3, w: 0.16, h: 0.035 },
    ],
    crates: [{ x: 0.45, y: 0.4, w: 0.05, h: 0.07 }],
    spawns: [[0.1, 0.8], [0.9, 0.8], [0.4, 0.4], [0.6, 0.4]],
    weaponDrops: [[0.36, 0.44], [0.6, 0.62]],
  },
  {
    id: 'desert5', name: 'Box Fort', theme: 'desert',
    platforms: [
      { x: 0, y: 0.9, w: 1, h: 0.1 },
      { x: 0.1, y: 0.62, w: 0.06, h: 0.28 },
      { x: 0.84, y: 0.62, w: 0.06, h: 0.28 },
      { x: 0.1, y: 0.56, w: 0.8, h: 0.06 },
      { x: 0.4, y: 0.34, w: 0.2, h: 0.05 },
    ],
    crates: [
      { x: 0.3, y: 0.47, w: 0.05, h: 0.07 },
      { x: 0.65, y: 0.47, w: 0.05, h: 0.07 },
      { x: 0.475, y: 0.25, w: 0.05, h: 0.07 },
    ],
    spawns: [[0.08, 0.8], [0.92, 0.8], [0.25, 0.48], [0.75, 0.48]],
    weaponDrops: [[0.45, 0.28], [0.5, 0.5]],
  },
  {
    id: 'factory7', name: 'Factory Lifts', theme: 'factory',
    platforms: [
      { x: 0, y: 0.9, w: 0.32, h: 0.1 },
      { x: 0.68, y: 0.9, w: 0.32, h: 0.1 },
      { x: 0.05, y: 0.6, w: 0.22, h: 0.035 },
      { x: 0.73, y: 0.6, w: 0.22, h: 0.035 },
      { x: 0.3, y: 0.72, w: 0.4, h: 0.035, type: 'conveyor', beltSpeed: 0.25 },
    ],
    movers: [
      { x: 0.36, y: 0.4, w: 0.1, h: 0.035, axis: 'y', range: 0.18, period: 4 },
      { x: 0.54, y: 0.4, w: 0.1, h: 0.035, axis: 'y', range: 0.18, period: 4, phase: 2 },
      { x: 0.42, y: 0.18, w: 0.16, h: 0.035, axis: 'x', range: 0.12, period: 5 },
    ],
    spawns: [[0.08, 0.8], [0.92, 0.8], [0.12, 0.5], [0.88, 0.5]],
    weaponDrops: [[0.4, 0.6], [0.46, 0.12]],
  },
  {
    id: 'windmill', name: 'Windmill', theme: 'windmill',
    platforms: [
      { x: 0, y: 0.9, w: 1, h: 0.1 },
      { x: 0.04, y: 0.62, w: 0.18, h: 0.035 },
      { x: 0.78, y: 0.62, w: 0.18, h: 0.035 },
      { x: 0.4, y: 0.78, w: 0.2, h: 0.035 },
    ],
    rotators: [{ cx: 0.5, cy: 0.42, w: 0.3, h: 0.04, angleSpeed: 0.9 }],
    spawns: [[0.08, 0.8], [0.92, 0.8], [0.1, 0.52], [0.9, 0.52]],
    weaponDrops: [[0.45, 0.72], [0.5, 0.3]],
  },
  {
    id: 'winter7', name: 'Ice Spikes', theme: 'winter',
    platforms: [
      { x: 0, y: 0.9, w: 0.4, h: 0.1 },
      { x: 0.6, y: 0.9, w: 0.4, h: 0.1 },
      { x: 0.15, y: 0.62, w: 0.7, h: 0.035, type: 'ice' },
      { x: 0.4, y: 0.4, w: 0.2, h: 0.035, type: 'ice' },
    ],
    killRects: [
      { x: 0.4, y: 0.86, w: 0.2, h: 0.06, kind: 'spikes' },
      { x: 0.42, y: 0.585, w: 0.16, h: 0.035, kind: 'spikes' },
    ],
    spawns: [[0.08, 0.8], [0.92, 0.8], [0.25, 0.52], [0.75, 0.52]],
    weaponDrops: [[0.47, 0.34], [0.5, 0.56]],
  },
  {
    id: 'lava3', name: 'Lava Pit', theme: 'lava',
    platforms: [
      { x: 0, y: 0.86, w: 0.3, h: 0.14 },
      { x: 0.7, y: 0.86, w: 0.3, h: 0.14 },
      { x: 0.08, y: 0.58, w: 0.2, h: 0.035 },
      { x: 0.72, y: 0.58, w: 0.2, h: 0.035 },
      { x: 0.38, y: 0.42, w: 0.24, h: 0.035 },
    ],
    killRects: [{ x: 0, y: 0.92, w: 1, h: 0.08, kind: 'lava' }],
    spawns: [[0.08, 0.76], [0.92, 0.76], [0.12, 0.48], [0.88, 0.48]],
    weaponDrops: [[0.46, 0.36], [0.5, 0.8]],
  },
  {
    id: 'laser3', name: 'Laser Grid', theme: 'laser',
    platforms: [
      { x: 0, y: 0.9, w: 1, h: 0.1 },
      { x: 0.1, y: 0.64, w: 0.25, h: 0.035 },
      { x: 0.65, y: 0.64, w: 0.25, h: 0.035 },
      { x: 0.35, y: 0.42, w: 0.3, h: 0.035 },
    ],
    killRects: [
      { x: 0.05, y: 0.28, w: 0.9, h: 0.02, kind: 'laser', period: 3, duty: 0.5, phase: 0 },
      { x: 0.35, y: 0.64, w: 0.3, h: 0.02, kind: 'laser', period: 3, duty: 0.5, phase: 1.5 },
    ],
    spawns: [[0.08, 0.8], [0.92, 0.8], [0.15, 0.54], [0.85, 0.54]],
    weaponDrops: [[0.45, 0.36], [0.5, 0.58]],
  },
  {
    id: 'western10', name: 'Barrel Showdown', theme: 'western',
    platforms: [
      { x: 0, y: 0.9, w: 1, h: 0.1 },
      { x: 0.12, y: 0.66, w: 0.22, h: 0.035 },
      { x: 0.66, y: 0.66, w: 0.22, h: 0.035 },
      { x: 0.36, y: 0.46, w: 0.28, h: 0.035 },
    ],
    barrels: [
      { x: 0.3, y: 0.82 }, { x: 0.7, y: 0.82 },
      { x: 0.47, y: 0.38 }, { x: 0.2, y: 0.58 },
    ],
    crates: [{ x: 0.75, y: 0.57, w: 0.05, h: 0.07 }],
    spawns: [[0.08, 0.8], [0.92, 0.8], [0.18, 0.56], [0.82, 0.56]],
    weaponDrops: [[0.46, 0.4], [0.5, 0.6]],
  },
  {
    id: 'halloween7', name: 'Ghost House', theme: 'halloween',
    platforms: [
      { x: 0, y: 0.9, w: 1, h: 0.1 },
      { x: 0.06, y: 0.64, w: 0.2, h: 0.035, type: 'bouncy' },
      { x: 0.74, y: 0.64, w: 0.2, h: 0.035, type: 'bouncy' },
      { x: 0.32, y: 0.5, w: 0.14, h: 0.035, type: 'blink', period: 4, duty: 0.6, phase: 0 },
      { x: 0.54, y: 0.5, w: 0.14, h: 0.035, type: 'blink', period: 4, duty: 0.6, phase: 2 },
      { x: 0.4, y: 0.3, w: 0.2, h: 0.035 },
    ],
    spawns: [[0.08, 0.8], [0.92, 0.8], [0.12, 0.54], [0.88, 0.54]],
    weaponDrops: [[0.46, 0.24], [0.5, 0.44]],
  },
];
