import type { WeaponDef, WeaponId } from '../../shared/types.js';

function d(partial: WeaponDef): WeaponDef {
  return partial;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: d({
    id: 'fists', name: 'Fists',
    damage: 22, fireInterval: 0.35, magSize: 9999,
    projectileSpeed: 0, spread: 0, recoil: 100,
    knockback: 500, auto: true,
    melee: { range: 55, arc: 1.8, interval: 0.35 },
  }),
  pistol: d({
    id: 'pistol', name: 'Pistol',
    damage: 32, fireInterval: 0.28, magSize: 15,
    projectileSpeed: 1400, spread: 0.02, recoil: 180,
    knockback: 260, auto: false,
  }),
  revolver: d({
    id: 'revolver', name: 'Revolver',
    damage: 44, fireInterval: 0.55, magSize: 6,
    projectileSpeed: 1600, spread: 0.015, recoil: 450,
    knockback: 550, auto: false,
  }),
  deagle: d({
    id: 'deagle', name: 'Desert Eagle',
    damage: 56, fireInterval: 0.55, magSize: 15,
    projectileSpeed: 1800, spread: 0.02, recoil: 600,
    knockback: 650, auto: false,
  }),
  uzi: d({
    id: 'uzi', name: 'Uzi',
    damage: 14, fireInterval: 0.09, magSize: 40,
    projectileSpeed: 1300, spread: 0.06, recoil: 140,
    knockback: 280, auto: true,
  }),
  ak47: d({
    id: 'ak47', name: 'AK-47',
    damage: 23, fireInterval: 0.12, magSize: 30,
    projectileSpeed: 1600, spread: 0.045, recoil: 220,
    knockback: 300, auto: true,
  }),
  m16: d({
    id: 'm16', name: 'M16',
    damage: 20, fireInterval: 0.28, magSize: 88,
    projectileSpeed: 1700, spread: 0.03, recoil: 200,
    knockback: 280, auto: true, pellets: 3,
  }),
  sniper: d({
    id: 'sniper', name: 'Sniper',
    damage: 75, fireInterval: 1.0, magSize: 5,
    projectileSpeed: 2200, spread: 0, recoil: 700,
    knockback: 800, auto: false, beam: true,
  }),
  shotgun: d({
    id: 'shotgun', name: 'Shotgun',
    damage: 6, fireInterval: 0.8, magSize: 10,
    projectileSpeed: 1200, spread: 0.12, recoil: 550,
    knockback: 700, auto: false, pellets: 5,
  }),
  sawedoff: d({
    id: 'sawedoff', name: 'Sawed-Off',
    // Canonical 10-30 total, fixed at ~22: per-pellet damage so that
    // pellets * damage ~= 22 (6 x 4 = 24 total, within the 10-30 band).
    damage: 4, fireInterval: 0.7, magSize: 10,
    projectileSpeed: 1100, spread: 0.18, recoil: 850,
    knockback: 800, auto: false, pellets: 6,
  }),
  bouncer: d({
    id: 'bouncer', name: 'Bouncer',
    damage: 45, fireInterval: 0.22, magSize: 30,
    projectileSpeed: 1100, spread: 0.02, recoil: 200,
    knockback: 400, auto: false, bounce: 6,
  }),
  minigun: d({
    id: 'minigun', name: 'Minigun',
    damage: 5, fireInterval: 0.05, magSize: 200,
    projectileSpeed: 1500, spread: 0.09, recoil: 220,
    knockback: 260, auto: true,
  }),
  grenade: d({
    id: 'grenade', name: 'Grenade',
    damage: 65, fireInterval: 0.9, magSize: 5,
    projectileSpeed: 550, spread: 0, recoil: 250,
    knockback: 600, auto: false,
    explosive: { radius: 130 },
  }),
  rpg: d({
    id: 'rpg', name: 'RPG',
    damage: 150, fireInterval: 1.0, magSize: 3,
    projectileSpeed: 900, spread: 0, recoil: 600,
    knockback: 700, auto: false,
    explosive: { radius: 150 },
  }),
  flamethrower: d({
    id: 'flamethrower', name: 'Flamethrower',
    // Canonical 0 direct + 5 dps burn. Direct kept at minimal non-zero (2)
    // so server hit detection (damage > 0 gate) still registers the burn.
    damage: 2, fireInterval: 0.05, magSize: 100,
    projectileSpeed: 500, spread: 0.25, recoil: 100,
    knockback: 200, auto: true,
  }),
  sword: d({
    id: 'sword', name: 'Sword',
    damage: 68, fireInterval: 0.45, magSize: 25,
    projectileSpeed: 0, spread: 0, recoil: 150,
    knockback: 600, auto: true,
    melee: { range: 75, arc: 1.6, interval: 0.45 },
  }),
  spear: d({
    id: 'spear', name: 'Spear',
    damage: 20, fireInterval: 0.55, magSize: 25,
    projectileSpeed: 0, spread: 0, recoil: 150,
    knockback: 650, auto: false,
    melee: { range: 110, arc: 0.9, interval: 0.55 },
  }),
  laser: d({
    id: 'laser', name: 'Laser',
    damage: 10, fireInterval: 0.35, magSize: 60,
    projectileSpeed: 2000, spread: 0, recoil: 300,
    knockback: 900, auto: true, beam: true,
  }),
  snake: d({
    id: 'snake', name: 'Snake',
    damage: 5, fireInterval: 0.4, magSize: 6,
    projectileSpeed: 260, spread: 0.02, recoil: 180,
    knockback: 200, auto: false,
  }),
  snakeshot: d({
    id: 'snakeshot', name: 'Snakeshot',
    damage: 5, fireInterval: 0.8, magSize: 10,
    projectileSpeed: 260, spread: 0.12, recoil: 850,
    knockback: 300, auto: false, pellets: 3,
  }),
  ice: d({
    id: 'ice', name: 'Ice Gun',
    damage: 8, fireInterval: 0.22, magSize: 40,
    projectileSpeed: 700, spread: 0.03, recoil: 180,
    knockback: 200, auto: true,
  }),
  glue: d({
    id: 'glue', name: 'Glue Gun',
    damage: 5, fireInterval: 0.25, magSize: 40,
    projectileSpeed: 650, spread: 0.04, recoil: 160,
    knockback: 180, auto: true,
  }),
};
