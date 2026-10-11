import type { LevelDef, PlayerState, ProjectileState, CrateState, BarrelState, DroppedGun } from './types.js';

export const PROTOCOL_VERSION = 2;

/**
 * Room-based LAN protocol (v2).
 *
 * One game-server process hosts MANY rooms. Any connected client can create
 * a room (becoming its host); others join via a short room code. The host can
 * delete the room (everyone is kicked); if the host disconnects the room is
 * auto-deleted.
 *
 * Lifecycle per socket:
 *   connect -> send createRoom OR joinRoom -> welcome (+ roster, then
 *   start/snapshots) -> input/ping ... -> roomClosed | close
 */

export interface CreateRoomOpts {
  wins?: number;
  bots?: number;
  levelId?: string;
  /** Optional custom level JSON (host uploads an editor map). */
  levelJson?: string;
}

export type ClientMsg =
  | { v: number; t: 'createRoom'; name: string; version: number; wins?: number; bots?: number; levelId?: string; levelJson?: string }
  | { v: number; t: 'joinRoom'; code: string; name: string; version: number }
  | { v: number; t: 'leaveRoom' }
  | { v: number; t: 'deleteRoom' }
  | { v: number; t: 'ready'; ready: boolean }
  | { v: number; t: 'startMatch' }
  | { v: number; t: 'input'; seq: number; left: boolean; right: boolean; jump: boolean; down: boolean; fire: boolean; block: boolean; throwReq: boolean; aimX: number; aimY: number }
  | { v: number; t: 'ping'; t0: number };

export interface SnapshotPlayer extends PlayerState {}
export interface SnapshotEvent { kind: string; text?: string; a?: number; b?: number; x?: number; y?: number }

export interface RosterEntry {
  id: number;
  name: string;
  slot: number;
  bot: boolean;
  color?: string;
  /** Ready-up flag (humans only; bots always report true). */
  ready: boolean;
}

export type ServerMsg =
  | { v: number; t: 'welcome'; clientId: number; slot: number; levelId: string; code: string; isHost: boolean }
  | { v: number; t: 'reject'; reason: string }
  | { v: number; t: 'roster'; players: RosterEntry[]; code: string; hostId: number }
  | { v: number; t: 'start'; levelId: string; seed: number; levelJson?: string; code?: string }
  | { v: number; t: 'startDenied'; reason: string }
  | { v: number; t: 'snapshot'; tick: number; time: number; levelId: string; round: number; players: SnapshotPlayer[]; projectiles: ProjectileState[]; crates: CrateState[]; barrels: BarrelState[]; drops: DroppedGun[]; events: SnapshotEvent[]; levelJson?: string; acks?: Record<number, number> }
  | { v: number; t: 'pong'; t0: number }
  | { v: number; t: 'matchEnd'; wins: Record<number, number> }
  | { v: number; t: 'roomClosed'; reason: string; code: string };
