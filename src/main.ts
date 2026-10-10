import './styles.css';
import { Ui, getWinsTarget, normalizeWsUrl } from './ui/screens.js';
import type { HudState } from './ui/hud.js';
import { PLAYER_COLORS } from '../shared/constants.js';

const W = 1280;
const H = 720;

interface Mode {
  start(): void;
  stop(): void;
  onQuit?: ((() => void) | null);
  getHudState?(): HudState;
}

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

// Stage: canvas (fixed 1280x720 buffer) scaled to fit + overlay for UI.
app.className = 'fixed inset-0 bg-neutral-950 flex flex-col items-center justify-center overflow-hidden gap-1';
const lanHost = window.location.hostname || 'localhost';
app.innerHTML = `
  <div data-stage class="relative shrink-0">
    <canvas width="${W}" height="${H}" class="block bg-black rounded-sm shadow-[0_0_80px_rgba(220,38,38,0.25)] aspect-video max-w-full" style="image-rendering:auto;"></canvas>
    <div data-overlay class="absolute inset-0"></div>
    <button data-quit class="hidden absolute bottom-2 right-2 z-40 font-display text-xs px-3 py-1.5 rounded-md bg-neutral-800/90 hover:bg-red-700 border border-neutral-600 text-neutral-200">QUIT ✕</button>
  </div>
  <div data-footer class="text-center text-[11px] text-neutral-500 select-none">
    <span class="text-neutral-400">WASD move · mouse aim · LMB fire · RMB block · F throw · H help · R rematch · Esc pause · Q quit</span>
    <span class="mx-2 text-neutral-700">|</span>
    <span>LAN: host <span class="font-mono text-green-400">npm run host</span> then join <span class="font-mono text-green-300">ws://${lanHost}:8080</span></span>
  </div>`;
const stage = app.querySelector('[data-stage]') as HTMLElement;
const canvas = app.querySelector('canvas') as HTMLCanvasElement;
const overlay = app.querySelector('[data-overlay]') as HTMLElement;
const quitBtn = app.querySelector('[data-quit]') as HTMLButtonElement;

function fit(): void {
  // Letterbox the fixed 1280x720 buffer: uniform scale, never stretch.
  // Reserve room for the footer hint (~28px) so the stage never overflows.
  const availW = window.innerWidth - 8;
  const availH = window.innerHeight - 36;
  const s = Math.min(availW / W, availH / H);
  const cw = Math.max(1, Math.floor(W * s));
  const ch = Math.max(1, Math.floor(H * s));
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  canvas.style.aspectRatio = '16 / 9';
  canvas.style.maxWidth = '100vw';
  canvas.style.imageRendering = 'auto';
}
window.addEventListener('resize', fit);
fit();

const ui = new Ui(overlay);
let mode: Mode | null = null;

function stopMode(): void {
  try { mode?.stop(); } catch { /* already torn down */ }
  mode = null;
  quitBtn.classList.add('hidden');
}

function showMenu(): void {
  stopMode();
  ui.showMenu({
    onLocal: (n, bots) => void startLocal(n, bots),
    onHost: () => showHostSetup(),
    onJoin: () => showJoinSetup(),
    onHow: () => ui.showHow({ onBack: showMenu }),
  });
}

async function startLocal(humans: number, bots: boolean): Promise<void> {
  stopMode();
  ui.clear();
  canvas.width = W; canvas.height = H; // OnlineMode may have resized the backing store
  try {
    const { LocalMode } = await import('./modes/LocalMode.js');
    const total = Math.min(4, Math.max(1, humans + (bots ? 1 : 0)));
    const botCount = Math.max(total - Math.min(humans, 2), bots ? 1 : 0);
    const m = new LocalMode(canvas, { humans: Math.min(humans, 4), bots: botCount, winsTarget: getWinsTarget() }) as Mode;
    mode = m;
    if (m.onQuit !== undefined) m.onQuit = showMenu;
    ui.showHud(() => m.getHudState?.() ?? { players: [], round: 1, levelName: '' });
    quitBtn.classList.remove('hidden');
    m.start();
  } catch (err) {
    console.error(err);
    ui.toast('Failed to start local game');
    showMenu();
  }
}

function showHostSetup(): void {
  ui.showSetup('HOST GAME', (d) => {
    if (d.back) { showMenu(); return; }
    const host = window.location.hostname || 'localhost';
    const addr = `${host}:8080`;
    ui.showLobby(
      { title: 'LOBBY — HOST', addr: `ws://${addr}`, players: [{ name: d.name, color: PLAYER_COLORS[0], bot: false }] },
      {
        onStart: () => void startOnline(`ws://${addr}`, d.name),
        onLeave: showMenu,
      },
    );
    ui.toast('Run `npm run host` on this machine, then press FIGHT!');
  });
}

function showJoinSetup(): void {
  ui.showSetup('JOIN GAME', (d) => {
    if (d.back) { showMenu(); return; }
    // Screens.ts already validates + normalizes to a ws:// URL; re-normalize
    // defensively so bare IPs still work.
    const url = /^wss?:\/\//i.test(d.ip) ? d.ip : normalizeWsUrl(d.ip);
    if (!url) { ui.toast('Enter a valid address, e.g. ws://192.168.1.10:8080'); return; }
    void startOnline(url, d.name);
  }, { ip: true, startLabel: 'CONNECT' });
}

/** Map low-level NetClient connect failures to actionable toasts. */
function connectErrorToast(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (/server full/i.test(raw)) return 'Server is full (max 4 players) — try again later';
  if (/protocol mismatch|version mismatch/i.test(raw)) return 'Version mismatch — update the game and retry';
  if (/no hello/i.test(raw)) return 'Server did not respond — is `npm run host` running?';
  if (/refused|failed|timed out|timeout|websocket error|not respond|could not connect|no welcome/i.test(raw)) {
    return 'Could not connect — is the server running? (`npm run host`)';
  }
  return raw ? `Could not connect — ${raw.slice(0, 90)}` : 'Could not connect — is the server running? (`npm run host`)';
}

// OnlineMode is lazy-loaded so the local game stays in its own chunk.
// API: new OnlineMode(canvas, url, name), async start(), stop().
async function startOnline(url: string, name: string): Promise<void> {
  stopMode();
  ui.clear();
  ui.toast(`Connecting to ${url} …`);
  try {
    const { OnlineMode } = await import('./modes/OnlineMode.js');
    const m = new OnlineMode(canvas, url, name);
    mode = m;
    await m.start();
    const maybeHud = m as unknown as { getHudState?: () => HudState };
    const fallback: HudState = { players: [], round: 1, levelName: 'ONLINE' };
    ui.showHud(() => {
      try {
        return maybeHud.getHudState?.() ?? fallback;
      } catch {
        return fallback;
      }
    });
    quitBtn.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    ui.toast(connectErrorToast(err));
    showMenu();
  }
}

quitBtn.onclick = () => showMenu();

// Global H toggles the How-to-play overlay from menus (in-game H is handled by LocalMode).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyH' || mode) return;
  try {
    ui.showHow({ onBack: showMenu });
  } catch {
    /* ignore */
  }
});

showMenu();
