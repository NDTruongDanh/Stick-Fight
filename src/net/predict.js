/**
 * v1 client-side prediction bookkeeping.
 * Stores the last 120 local inputs and tracks the newest server-acked seq.
 * The snapshot protocol carries no per-input ack, so `reconcile()` treats the
 * server snapshot tick as an approximate ack watermark (server tick ~= input
 * seq at steady state): everything at or below `tick - holdback` counts as
 * acknowledged. Full rewind-and-replay is optional v2.
 */
export class Predictor {
    constructor() {
        Object.defineProperty(this, "capacity", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 120
        });
        Object.defineProperty(this, "lastAck", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: -1
        });
        Object.defineProperty(this, "buf", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
    }
    pushLocal(input) {
        this.buf.push({ ...input });
        while (this.buf.length > this.capacity)
            this.buf.shift();
    }
    reconcile(serverPlayers, myId, serverTick) {
        if (this.buf.length === 0)
            return;
        if (!serverPlayers.some((p) => p.id === myId))
            return;
        const newest = this.buf[this.buf.length - 1].seq;
        const holdback = 6; // inputs that may still be in flight
        const watermark = typeof serverTick === "number" && Number.isFinite(serverTick)
            ? Math.floor(serverTick)
            : newest;
        // Never ack beyond what we actually sent; the min() cap is what keeps a
        // fast server tick (60Hz vs 30Hz input) from acking in-flight inputs.
        const ack = Math.min(newest, watermark - holdback);
        this.lastAck = Math.max(this.lastAck, ack);
        // Prune acked prefix but keep a tail for potential rewind.
        while (this.buf.length > 30 && this.buf[0].seq <= this.lastAck)
            this.buf.shift();
    }
    unacked() {
        return this.buf.filter((i) => i.seq > this.lastAck);
    }
    /** Number of sent inputs the server has not acknowledged yet (HUD debug). */
    get unackedCount() {
        let n = 0;
        for (const i of this.buf)
            if (i.seq > this.lastAck)
                n++;
        return n;
    }
    get lastSeq() {
        return this.buf.length ? this.buf[this.buf.length - 1].seq : -1;
    }
}
