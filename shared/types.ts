export type PlatformType = 'static' | 'ice' | 'bouncy' | 'conveyor' | 'blink' | 'lava';

export interface PlatformDef {
  x: number; y: number; w: number; h: number; // normalized 0..1
  type?: PlatformType;
  beltSpeed?: number; // normalized units/s for conveyor
  period?: number; duty?: number; phase?: number; // blink
}

export interface MoverDef {
  x: number; y: number; w: number; h: number;
  axis: 'x' | 'y'; range: number; period: number; phase?: number;
}

export interface RotatorDef {
  cx: number; cy: number; w: number; h: number; angleSpeed: number;
}

export interface CrateDef { x: number; y: number; w: number; h: number }
export interface BarrelDef { x: number; y: number }
export interface KillRectDef { x: number; y: number; w: number; h: number; kind: 'spikes' | 'lava' | 'laser'; period?: number; duty?: number; phase?: number }

export interface LevelDef {
  id: string; name: string; theme: string;
  platforms: PlatformDef[];
  movers?: MoverDef[];
  rotators?: RotatorDef[];
  crates?: CrateDef[];
  barrels?: BarrelDef[];
  killRects?: KillRectDef[];
  spawns: [number, number][]; // 4 normalized
  weaponDrops: [number, number][];
}

export type WeaponId =
  | 'fists' | 'pistol' | 'revolver' | 'deagle' | 'uzi' | 'ak47' | 'm16'
  | 'sniper' | 'shotgun' | 'sawedoff' | 'bouncer' | 'minigun'
  | 'grenade' | 'rpg' | 'flamethrower' | 'sword' | 'spear' | 'laser'
  | 'snake' | 'snakeshot';

export interface WeaponDef {
  id: WeaponId; name: string;
  damage: number; fireInterval: number; magSize: number;
  projectileSpeed: number; spread: number; recoil: number;
  knockback: number; auto: boolean; pellets?: number;
  melee?: { range: number; arc: number; interval: number };
  explosive?: { radius: number };
  beam?: boolean; bounce?: number;
}

export interface PlayerState {
  id: number; name: string; color: string;
  x: number; y: number; vx: number; vy: number;
  facing: number; // -1 | 1
  aimX: number; aimY: number;
  hp: number; alive: boolean;
  weapon: WeaponId; ammo: number; cooldown: number;
  onGround: boolean; wins: number; kills: number;
  isBot?: boolean;
}

export interface ProjectileState {
  id: number; kind: WeaponId; x: number; y: number; vx: number; vy: number;
  life: number; owner: number; bounces?: number;
}

export interface CrateState { x: number; y: number; w: number; h: number; vx: number; vy: number; angle: number }
export interface BarrelState { x: number; y: number; hp: number }
export interface DroppedGun { x: number; y: number; vx: number; vy: number; weapon: WeaponId; ammo: number }
