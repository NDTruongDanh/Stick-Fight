import type { PlayerState } from "../../shared/types.js";

export interface PredictedInput {
  seq: number;
  left: boolean;
  right: boolean;
  jump: boolean;
  down: boolean;
  fire: boolean;
  block: boolean;
  throwReq: boolean;
  aimX: number;
  aimY: number;
}

/**
 * v2 client-side prediction bookkeeping.
 * Stores recent local inputs and tracks the newest server-acked seq.
 * Preferred ack source is the server's per-client seq echo
 * (`snapshot.acks[myId]`); when absent (old server) it falls back to
 * treating the server snapshot tick as an approximate ack watermark
 * (server tick ~= input seq at steady state).
 */
export class Predictor {
  readonly capacity = 180;
  lastAck = -1;

  private buf: PredictedInput[] = [];

  pushLocal(input: PredictedInput): void {
    this.buf.push({ ...input });
    while (this.buf.length > this.capacity) this.buf.shift();
  }

  reconcile(serverPlayers: Pick<PlayerState, "id">[], myId: number, serverTickOrAck?: number, ackSeq?: number): void {
    if (this.buf.length === 0) return;
    if (!serverPlayers.some((p) => p.id === myId)) return;
    const newest = this.buf[this.buf.length - 1].seq;
    // Precise path: server echoed our last applied input seq.
    if (typeof ackSeq === "number" && Number.isFinite(ackSeq)) {
      const ack = Math.min(newest, Math.floor(ackSeq));
      this.lastAck = Math.max(this.lastAck, ack);
      while (this.buf.length > 30 && this.buf[0].seq <= this.lastAck) this.buf.shift();
      return;
    }
    const holdback = 6; // inputs that may still be in flight
    const watermark = typeof serverTickOrAck === "number" && Number.isFinite(serverTickOrAck)
      ? Math.floor(serverTickOrAck)
      : newest;
    // Never ack beyond what we actually sent; the min() cap is what keeps a
    // fast server tick (60Hz vs 30Hz input) from acking in-flight inputs.
    const ack = Math.min(newest, watermark - holdback);
    this.lastAck = Math.max(this.lastAck, ack);
    // Prune acked prefix but keep a tail for potential rewind.
    while (this.buf.length > 30 && this.buf[0].seq <= this.lastAck) this.buf.shift();
  }

  unacked(): PredictedInput[] {
    return this.buf.filter((i) => i.seq > this.lastAck);
  }

  /** Number of sent inputs the server has not acknowledged yet (HUD debug). */
  get unackedCount(): number {
    let n = 0;
    for (const i of this.buf) if (i.seq > this.lastAck) n++;
    return n;
  }

  get lastSeq(): number {
    return this.buf.length ? this.buf[this.buf.length - 1].seq : -1;
  }
}
