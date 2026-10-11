import type { LevelDef, PlayerState, ProjectileState, CrateState, BarrelState, DroppedGun } from './types.js';

export const PROTOCOL_VERSION = 1;

export type ClientMsg =
  | { v: number; t: 'hello'; name: string; version: number }
  | { v: number; t: 'input'; seq: number; left: boolean; right: boolean; jump: boolean; down: boolean; fire: boolean; block: boolean; throwReq: boolean; aimX: number; aimY: number }
  | { v: number; t: 'ping'; t0: number }
  | { v: number; t: 'chat'; text: string };

export interface SnapshotPlayer extends PlayerState {}
export interface SnapshotEvent { kind: string; text?: string; a?: number; b?: number }

export type ServerMsg =
  | { v: number; t: 'welcome'; clientId: number; slot: number; levelId: string }
  | { v: number; t: 'reject'; reason: string }
  | { v: number; t: 'roster'; players: { id: number; name: string; slot: number; bot: boolean; color?: string; ready?: boolean }[] }
  | { v: number; t: 'start'; levelId: string; seed: number; levelJson?: string }
  | { v: number; t: 'snapshot'; tick: number; time: number; levelId: string; round: number; players: SnapshotPlayer[]; projectiles: ProjectileState[]; crates: CrateState[]; barrels: BarrelState[]; drops: DroppedGun[]; events: SnapshotEvent[]; levelJson?: string; acks?: Record<number, number> }
  | { v: number; t: 'pong'; t0: number }
  | { v: number; t: 'chat'; from: string; text: string }
  | { v: number; t: 'matchEnd'; wins: Record<number, number> };
