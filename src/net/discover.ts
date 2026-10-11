import { PROTOCOL_VERSION } from "../../shared/constants.js";

/**
 * LAN room-server auto-discovery (join by code only).
 *
 * No WebRTC local-IP trick: Chrome/Firefox mask host candidates with mDNS,
 * so the page cannot reliably learn its own LAN IP. Instead we probe a fixed
 * list of likely subnets over HTTP (`/healthz`) and verify candidates over
 * WebSocket with a throwaway `joinRoom`.
 *
 * Priority order: (1) same-origin host, (2) lanWsHint() default, (3) `.1`
 * gateways of likely subnets, (4) full /24 sweep.
 */

export const GAME_ID = "stickfight";
export const DEFAULT_GAME_PORT = 8080;
/** Vite dev / preview ports are client-only — never probe them as game servers. */
export const DEV_PORTS = new Set(["5173", "4173"]);
/** Likely LAN subnets: home LANs + phone hotspots. */
export const LIKELY_SUBNETS = [
  "192.168.1",
  "192.168.0",
  "192.168.68",
  "192.168.50",
  "10.0.0",
  "172.20.10",
];

export interface HealthInfo {
  ok: boolean;
  port: number;
  game?: string;
  proto?: number;
  rooms?: number;
}

export interface FoundServer {
  ip: string;
  port: number;
  /** `ws://ip:port` — pass straight to NetClient / OnlineMode. */
  wsUrl: string;
  /** Parsed /healthz JSON when readable over CORS; null for opaque (up, unverified). */
  info: HealthInfo | null;
  /** True when /healthz positively identified a stickfight server. */
  verified: boolean;
}

export interface ScanOpts {
  timeoutMs?: number;
  concurrency?: number;
  ports?: number[];
  subnets?: string[];
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface FindOpts extends ScanOpts {
  joinTimeoutMs?: number;
  onStage?: (msg: string) => void;
}

function getWindow(): Window | null {
  try {
    if (typeof window !== "undefined") return window;
  } catch {
    /* non-browser */
  }
  return null;
}

export function isHttpsPage(): boolean {
  const w = getWindow();
  try {
    return !!w && w.location?.protocol === "https:";
  } catch {
    return false;
  }
}

function getPageHost(): string | null {
  const w = getWindow();
  try {
    const h = w?.location?.hostname?.trim();
    if (h) return h;
  } catch {
    /* ignore */
  }
  return null;
}

/** Page's own port when it IS a game port (excludes vite-dev/preview). Null otherwise. */
function getPageGamePort(): number | null {
  const w = getWindow();
  try {
    const p = w?.location?.port ?? "";
    if (p && /^\d+$/.test(p) && !DEV_PORTS.has(p)) {
      const n = Number(p);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Local mirror of screens.ts lanHint/lanPort (kept here so discover stays UI-free). */
function lanHintParts(): { host: string; port: number } {
  let host = "";
  try {
    const w = getWindow();
    host = w?.location?.hostname ?? "";
  } catch {
    host = "";
  }
  host = (host || "localhost").trim() || "localhost";
  const pagePort = getPageGamePort();
  return { host, port: pagePort ?? DEFAULT_GAME_PORT };
}

export function defaultGamePorts(): number[] {
  const pagePort = getPageGamePort();
  const ports = [DEFAULT_GAME_PORT];
  if (pagePort && pagePort !== DEFAULT_GAME_PORT) ports.push(pagePort);
  return ports.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
}

export function wsUrlFor(ip: string, port: number): string {
  return `ws://${ip}:${port}`;
}

export interface Candidate {
  ip: string;
  port: number;
}

/** Ordered, deduped candidate list (priority order, see module doc). */
export function buildCandidates(opts: Pick<ScanOpts, "ports" | "subnets"> = {}): Candidate[] {
  const subnets = (opts.subnets ?? LIKELY_SUBNETS).filter((s) => /^(\d{1,3}\.){2}\d{1,3}$/.test(s.trim()));
  const rawPorts = opts.ports ?? defaultGamePorts();
  const ports = [...new Set(rawPorts)].filter(
    (p) => Number.isInteger(p) && p >= 1 && p <= 65535 && !DEV_PORTS.has(String(p)),
  );
  if (ports.length === 0) ports.push(DEFAULT_GAME_PORT);
  const list: Candidate[] = [];
  const seen = new Set<string>();
  const push = (ip: string, port: number): void => {
    const clean = (ip || "").trim();
    if (!clean) return;
    const key = `${clean}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ ip: clean, port });
  };

  const pageHost = getPageHost();
  const hint = lanHintParts();

  // (1) same-origin host — page's own port first (served UI == game server).
  if (pageHost) {
    const pp = getPageGamePort();
    if (pp) push(pageHost, pp);
    for (const p of ports) push(pageHost, p);
  }
  // (2) lanWsHint() default.
  if (hint.host) {
    push(hint.host, hint.port);
    for (const p of ports) push(hint.host, p);
  }
  // Loopback is cheap and helps local dev / same-machine host.
  for (const p of ports) {
    push("127.0.0.1", p);
    if (pageHost !== "localhost") push("localhost", p);
  }
  // (3) .1 gateways.
  for (const s of subnets) for (const p of ports) push(`${s}.1`, p);
  // (4) full /24 sweep (.2–.254; .1 already covered).
  for (const s of subnets) {
    for (let h = 2; h <= 254; h++) {
      for (const p of ports) push(`${s}.${h}`, p);
    }
  }
  return list;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError"
    : err instanceof Error && /abort/i.test(err.message);
}

/**
 * Probe one `http://ip:port/healthz`.
 * - CORS fetch first: JSON with `game: "stickfight"` → verified.
 * - CORS-JSON mismatch / non-200 → not our server (null).
 * - Network/CORS failure → no-cors fallback: opaque resolution means
 *   "up, unverified" (old server without ACAO, or other HTTP box).
 * - Timeout / abort / both failing → null.
 */
export async function probeHealth(
  ip: string,
  port: number,
  timeoutMs = 800,
  parentSignal?: AbortSignal,
): Promise<FoundServer | null> {
  if (parentSignal?.aborted) return null;
  const wsUrl = wsUrlFor(ip, port);
  const url = `http://${ip}:${port}/healthz`;
  const ctrl = new AbortController();
  const onParentAbort = (): void => ctrl.abort();
  if (parentSignal) {
    if (parentSignal.aborted) return null;
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), Math.max(50, timeoutMs));
  try {
    // 1) CORS attempt — readable JSON positively identifies our server.
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) return null;
      let json: HealthInfo;
      try {
        json = (await res.json()) as HealthInfo;
      } catch {
        return null; // HTTP server, but not ours.
      }
      if (json && (json as { ok?: unknown }).ok === true) {
        if ((json as { game?: unknown }).game === GAME_ID) {
          return { ip, port, wsUrl, info: json, verified: true };
        }
        return null;
      }
      return null;
    } catch (err) {
      if (ctrl.signal.aborted || parentSignal?.aborted || isAbortError(err)) {
        return null; // timeout or caller cancel — don't fall through to no-cors.
      }
      // Network/CORS error (TypeError): fall through to no-cors opaque check.
    }
    if (ctrl.signal.aborted || parentSignal?.aborted) return null;
    // 2) no-cors fallback — opaque means the TCP port accepted us.
    try {
      const opaque = await fetch(url, {
        signal: ctrl.signal,
        cache: "no-store",
        mode: "no-cors",
      });
      if (opaque) return { ip, port, wsUrl, info: null, verified: false };
      return null;
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

async function probeMany(
  candidates: Candidate[],
  opts: { timeoutMs: number; concurrency: number; signal?: AbortSignal; onTick?: () => void },
): Promise<FoundServer[]> {
  const found: FoundServer[] = [];
  let idx = 0;
  const workers: Promise<void>[] = [];
  const n = Math.min(opts.concurrency, Math.max(1, candidates.length));
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      for (;;) {
        if (opts.signal?.aborted) return;
        const my = idx++;
        if (my >= candidates.length) return;
        const c = candidates[my];
        try {
          const r = await probeHealth(c.ip, c.port, opts.timeoutMs, opts.signal);
          if (r) found.push(r);
        } catch {
          /* per-host failure — ignore */
        }
        try {
          opts.onTick?.();
        } catch {
          /* progress listener must never break the scan */
        }
      }
    })());
  }
  await Promise.all(workers);
  return found;
}

function sortByPriority(servers: FoundServer[], order: Map<string, number>): FoundServer[] {
  return [...servers].sort(
    (a, b) => (order.get(`${a.ip}:${a.port}`) ?? 0) - (order.get(`${b.ip}:${b.port}`) ?? 0),
  );
}

/**
 * Full health sweep over all candidates (bounded concurrency).
 * Throws on https pages (mixed-content) or caller cancel.
 */
export async function scanLanServers(opts: ScanOpts = {}): Promise<FoundServer[]> {
  if (isHttpsPage()) {
    throw new Error(
      "Page is served over https — browsers block http:// LAN probes. Open the http:// address or enter the server manually.",
    );
  }
  if (opts.signal?.aborted) throw new Error("Scan cancelled");
  const candidates = buildCandidates(opts);
  const timeoutMs = opts.timeoutMs ?? 800;
  const concurrency = clamp(opts.concurrency ?? 64, 1, 128);
  let done = 0;
  const total = candidates.length;
  const found = await probeMany(candidates, {
    timeoutMs,
    concurrency,
    signal: opts.signal,
    onTick: () => {
      done++;
      try {
        opts.onProgress?.(done, total);
      } catch {
        /* ignore */
      }
    },
  });
  if (opts.signal?.aborted) throw new Error("Scan cancelled");
  const order = new Map(candidates.map((c, i) => [`${c.ip}:${c.port}`, i] as [string, number]));
  return sortByPriority(found, order);
}

export type JoinProbe =
  | { ok: true; welcome: { code?: string; clientId?: number }; wsUrl: string }
  | { ok: false; reason: string; isOurServer: boolean };

/** Throwaway WS join: welcome → ours + code valid; reject → ours + wrong code; error → not ours. */
export function tryJoinOnce(
  wsUrl: string,
  code: string,
  name: string,
  timeoutMs = 3000,
): Promise<JoinProbe> {
  const cleanCode = (code || "").trim().toUpperCase();
  const cleanName = (name || "PLAYER").toUpperCase().slice(0, 12) || "PLAYER";
  return new Promise<JoinProbe>((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "join timeout", isOurServer: false });
    }, Math.max(500, timeoutMs));
    const finish = (v: JoinProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      resolve(v);
    };
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      clearTimeout(timer);
      resolve({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        isOurServer: false,
      });
      return;
    }
    ws.onopen = () => {
      try {
        ws?.send(
          JSON.stringify({ v: PROTOCOL_VERSION, t: "joinRoom", code: cleanCode, name: cleanName, version: PROTOCOL_VERSION }),
        );
      } catch {
        finish({ ok: false, reason: "send failed", isOurServer: false });
      }
    };
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown> | null = null;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || msg["v"] !== PROTOCOL_VERSION) return;
      if (msg["t"] === "welcome") {
        const codeVal = typeof msg["code"] === "string" ? (msg["code"] as string) : undefined;
        const idVal = typeof msg["clientId"] === "number" ? (msg["clientId"] as number) : undefined;
        finish({ ok: true, welcome: { code: codeVal, clientId: idVal }, wsUrl });
      } else if (msg["t"] === "reject") {
        finish({ ok: false, reason: String(msg["reason"] ?? "rejected"), isOurServer: true });
      } else if (msg["t"] === "roomClosed") {
        finish({ ok: false, reason: String(msg["reason"] ?? "room closed"), isOurServer: true });
      }
    };
    ws.onerror = () => {
      /* onclose follows with the verdict — don't resolve here or we lose reject reasons */
    };
    ws.onclose = () => {
      finish({ ok: false, reason: "unreachable", isOurServer: false });
    };
  });
}

function pickFinalError(rejectReasons: string[], sawServer: boolean): Error {
  if (rejectReasons.some((r) => /protocol mismatch|version mismatch/i.test(r))) {
    return new Error("Version mismatch — update the game and retry");
  }
  if (rejectReasons.some((r) => /room full|max 4/i.test(r))) {
    return new Error("Room is full (max 4 players) — try another room");
  }
  if (sawServer || rejectReasons.some((r) => /room not found|bad room code|bad code/i.test(r))) {
    return new Error("Room not found — check the 4-letter code");
  }
  if (rejectReasons.length > 0) {
    return new Error(`Room not found — ${rejectReasons[0].slice(0, 90)}`);
  }
  return new Error("No LAN server found — is `npm run host` running on this network?");
}

/**
 * Find the LAN server holding `code` and verify with a throwaway join.
 * Resolves with the first server that answers `welcome`; tries every
 * discovered server before reporting "room not found".
 */
export async function findServerForCode(
  code: string,
  name: string,
  opts: FindOpts = {},
): Promise<FoundServer> {
  const clean = (code || "").trim().toUpperCase();
  if (!clean) throw new Error("Enter the 4-letter room code from the host");
  if (isHttpsPage()) {
    throw new Error(
      "Page is served over https — browsers block http:// LAN discovery. Open the http:// address or enter the server manually.",
    );
  }
  if (opts.signal?.aborted) throw new Error("Scan cancelled");

  const all = buildCandidates(opts);
  const total = all.length;
  const timeoutMs = opts.timeoutMs ?? 800;
  const joinTimeoutMs = opts.joinTimeoutMs ?? 3000;
  const concurrency = clamp(opts.concurrency ?? 64, 1, 128);
  const order = new Map(all.map((c, i) => [`${c.ip}:${c.port}`, i] as [string, number]));

  // Fast tier (priority 1–3): same-origin / hint / loopback / .1 gateways.
  // Everything else is the /24 sweep.
  const pageHost = getPageHost();
  const hintHost = lanHintParts().host;
  const isFast = (c: Candidate): boolean =>
    c.ip === pageHost ||
    c.ip === hintHost ||
    c.ip === "127.0.0.1" ||
    c.ip === "localhost" ||
    c.ip.endsWith(".1");
  const fast = all.filter(isFast);
  const slow = all.filter((c) => !isFast(c));

  let done = 0;
  const progress = (extra = 0): void => {
    try {
      opts.onProgress?.(Math.min(total, done + extra), total);
    } catch {
      /* ignore */
    }
  };
  const rejectReasons: string[] = [];
  let sawServer = false;

  const tryServers = async (servers: FoundServer[]): Promise<FoundServer | null> => {
    for (const s of sortByPriority(servers, order)) {
      if (opts.signal?.aborted) throw new Error("Scan cancelled");
      try {
        opts.onStage?.(`Found ${s.ip}:${s.port}, joining…`);
      } catch {
        /* ignore */
      }
      const r = await tryJoinOnce(s.wsUrl, clean, name, joinTimeoutMs);
      if (r.ok) return s;
      if (r.isOurServer) {
        sawServer = true;
        rejectReasons.push(r.reason);
      }
    }
    return null;
  };

  // Phase 1: fast tier.
  try {
    opts.onStage?.("Scanning LAN…");
  } catch {
    /* ignore */
  }
  const fastFound = await probeMany(fast, {
    timeoutMs,
    concurrency,
    signal: opts.signal,
    onTick: () => {
      done++;
      progress();
    },
  });
  if (opts.signal?.aborted) throw new Error("Scan cancelled");
  const hit = await tryServers(fastFound);
  if (hit) return hit;

  // Phase 2: /24 sweep in chunks so we can early-exit on first verified join.
  const CHUNK = 256;
  for (let i = 0; i < slow.length; i += CHUNK) {
    if (opts.signal?.aborted) throw new Error("Scan cancelled");
    try {
      opts.onStage?.(`Sweeping LAN… (${Math.min(total, done)}/${total})`);
    } catch {
      /* ignore */
    }
    const chunk = slow.slice(i, i + CHUNK);
    const found = await probeMany(chunk, {
      timeoutMs,
      concurrency,
      signal: opts.signal,
      onTick: () => {
        done++;
        progress();
      },
    });
    if (opts.signal?.aborted) throw new Error("Scan cancelled");
    const win = await tryServers(found);
    if (win) {
      progress(slow.length - (i + chunk.length) > 0 ? slow.length - (i + chunk.length) : 0);
      return win;
    }
  }

  if (opts.signal?.aborted) throw new Error("Scan cancelled");
  // No welcome anywhere: a server that spoke the protocol means "bad code",
  // otherwise no server was up at all.
  if (sawServer) sawServer = true;
  throw pickFinalError(rejectReasons, sawServer && (fastFound.length > 0 || rejectReasons.length > 0));
}
