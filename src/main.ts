import './styles.css';
import { Ui, getWinsTarget, lanWsHint } from './ui/screens.js';
import type { HudState } from './ui/hud.js';
import type { LevelDef } from '../shared/types.js';
import { blankLevel, exportLevel, loadCustom } from './levels/editor.js';
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
app.innerHTML = `
  <div data-stage class="relative shrink-0">
    <canvas width="${W}" height="${H}" class="block bg-black rounded-sm shadow-[0_0_80px_rgba(220,38,38,0.25)] aspect-video max-w-full" style="image-rendering:auto;"></canvas>
    <div data-overlay class="absolute inset-0"></div>
    <button data-quit class="hidden absolute bottom-2 right-2 z-40 font-display text-xs px-3 py-1.5 rounded-md bg-neutral-800/90 hover:bg-red-700 border border-neutral-600 text-neutral-200">QUIT ✕</button>
  </div>
  <div data-footer class="text-center text-[11px] text-neutral-500 select-none">
    <span class="text-neutral-400">WASD move · mouse aim · LMB fire · RMB block · F throw · H help · R rematch · Esc pause · Q quit</span>
    <span class="mx-2 text-neutral-700">|</span>
    <span>LAN rooms: run <span class="font-mono text-green-400">npm run host</span> anywhere, HOST creates a room, friends JOIN with the code (<span class="font-mono text-green-300">ws://${lanWsHint()}</span>)</span>
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
    onEditor: () => showEditor(),
  });
}

async function startLocal(humans: number, bots: boolean, customLevel?: LevelDef): Promise<void> {
  stopMode();
  ui.clear();
  canvas.width = W; canvas.height = H; // OnlineMode may have resized the backing store
  try {
    const { LocalMode } = await import('./modes/LocalMode.js');
    const total = Math.min(4, Math.max(1, humans + (bots ? 1 : 0)));
    const botCount = Math.max(total - Math.min(humans, 2), bots ? 1 : 0);
    const m = new LocalMode(canvas, { humans: Math.min(humans, 4), bots: botCount, winsTarget: getWinsTarget(), ...(customLevel ? { customLevel } : {}) }) as Mode;
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

function showEditor(): void {
  stopMode();
  ui.showEditor(exportLevel(loadCustom() ?? blankLevel()), {
    onSave: (level) => void startLocal(2, true, level),
    onBack: showMenu,
  });
}

function showHostSetup(): void {
  ui.showCreateRoom((d) => {
    if (d.back) { showMenu(); return; }
    void startOnline(d.serverUrl, d.name, {
      mode: 'create',
      wins: d.wins,
      bots: d.bots ? 1 : 0,
      levelId: d.levelId,
      ...(d.levelJson ? { levelJson: d.levelJson } : {}),
    });
  });
}

function showJoinSetup(): void {
  ui.showJoinRoom((d) => {
    if (d.back) { showMenu(); return; }
    void startOnline(d.serverUrl, d.name, { mode: 'join', code: d.code });
  });
}

/** Map low-level NetClient connect failures to actionable toasts. */
function connectErrorToast(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (/no LAN server/i.test(raw)) return 'No LAN server found — is `npm run host` running on this network?';
  if (/served over https|mixed content|https.*http/i.test(raw)) {
    return 'Cannot auto-find server over HTTPS — open the http:// address or enter it manually';
  }
  if (/scan cancelled|cancelled/i.test(raw)) return 'Scan cancelled';
  if (/room full/i.test(raw)) return 'Room is full (max 4 players) — try another room';
  if (/room not found|bad room code|bad code/i.test(raw)) return 'Room not found — check the 4-letter code';
  if (/server full|max rooms/i.test(raw)) return 'Server is full (max rooms) — try again later';
  if (/protocol mismatch|version mismatch/i.test(raw)) return 'Version mismatch — update the game and retry';
  if (/no hello/i.test(raw)) return 'Server did not respond — is `npm run host` running?';
  if (/host left|room deleted|room closed/i.test(raw)) return raw.slice(0, 90);
  if (/refused|failed|timed out|timeout|websocket error|not respond|could not connect|no welcome/i.test(raw)) {
    return 'Could not connect — is the room server running? (`npm run host`)';
  }
  return raw ? `Could not connect — ${raw.slice(0, 90)}` : 'Could not connect — is the room server running? (`npm run host`)';
}

// OnlineMode is lazy-loaded so the local game stays in its own chunk.
// Room flow: create (host) or join (code) -> waiting lobby with room code ->
// game HUD once the server starts the match. Host DELETE kicks everyone;
// host quit auto-deletes the room.
async function startOnline(
  url: string,
  name: string,
  room: { mode: 'create'; wins?: number; bots?: number; levelId?: string; levelJson?: string } | { mode: 'join'; code: string },
): Promise<void> {
  stopMode();
  ui.clear();
  ui.toast(room.mode === 'create' ? `Creating room on ${url} …` : `Joining room ${room.code} …`);
  try {
    const { OnlineMode } = await import('./modes/OnlineMode.js');
    const m = new OnlineMode(canvas, url, name, room);
    mode = m;
    let inLobby = true;
    let inGame = false;
    // Guards menu transitions so roomClosed + socket close only navigate once.
    let settled = false;
    const goMenu = (toast?: string): void => {
      if (settled) return;
      settled = true;
      inLobby = false;
      inGame = false;
      stopMode();
      if (toast) ui.toast(toast);
      showMenu();
    };
    type RosterEntry = { id: number; name: string; slot?: number; bot: boolean; color?: string };
    // Recompute lobby view-model from the server roster: YOU + HOST badges.
    const refreshLobby = (roster: RosterEntry[]): void => {
      const myId = m.myId;
      const hostId = m.hostId;
      ui.updateLobby(
        roster.map((p, i) => ({
          name: p.name,
          color: p.color ?? PLAYER_COLORS[(p.slot ?? i) % PLAYER_COLORS.length],
          bot: !!p.bot,
          id: p.id,
          slot: p.slot,
          isSelf: p.id === myId,
          isHost: p.id === hostId,
        })),
      );
    };
    const showGameHud = (): void => {
      const fallback: HudState = { players: [], round: 1, levelName: 'ONLINE' };
      ui.showHud(() => {
        try {
          return m.getHudState?.() ?? fallback;
        } catch {
          return fallback;
        }
      });
      quitBtn.classList.remove('hidden');
    };
    const showLobbyNow = (): void => {
      const roster = (m.lobbyRoster ?? []) as RosterEntry[];
      const myId = m.myId;
      const hostId = m.hostId;
      ui.showLobby(
        {
          title: m.isHost ? 'LOBBY — YOUR ROOM' : 'LOBBY — ONLINE',
          code: m.roomCode,
          addr: url,
          players: roster.map((p, i) => ({
            name: p.name,
            color: p.color ?? PLAYER_COLORS[(p.slot ?? i) % PLAYER_COLORS.length],
            bot: !!p.bot,
            id: p.id,
            slot: p.slot,
            isSelf: p.id === myId,
            isHost: p.id === hostId,
          })),
          isHost: m.isHost,
          hint: m.isHost
            ? 'share the code above — match starts automatically once 2+ players have joined'
            : 'match starts automatically once 2+ players have joined',
        },
        {
          onLeave: () => {
            inLobby = false;
            stopMode();
            settled = true;
            showMenu();
          },
          onDelete: () => {
            try {
              m.deleteRoom();
            } catch {
              /* already closing */
            }
            ui.toast('Room deleted');
            // Server roomClosed + close will also fire — goMenu guards double nav.
          },
        },
      );
    };
    m.onLobbyRoster = (roster) => {
      if (!inLobby) return;
      try {
        refreshLobby(roster as RosterEntry[]);
      } catch {
        /* lobby torn down */
      }
    };
    m.onLobbyStart = () => {
      if (!inLobby) return;
      inLobby = false;
      inGame = true;
      showGameHud();
      ui.toast('Match started!');
    };
    m.onLobbyClose = (err) => {
      if (!inLobby) return;
      goMenu(err && /room|full|version|closed|deleted|left|lost|not found|bad code/i.test(err) ? err : 'Connection closed');
    };
    m.onRoomClosed = (reason) => {
      // Kicked/deleted at any phase: lobby or mid-game both return to menu.
      if (inLobby || inGame) goMenu(reason || 'Room closed');
    };
    m.onDisconnect = (err) => {
      if (inGame) goMenu(err || 'Connection lost');
    };
    await m.start();
    // start() resolves once the room connection is up (welcome received).
    // Show the lobby with the real room code (create learns it from server).
    // Late joins to a running match skip the lobby and go straight to HUD.
    if (settled) return;
    if (m.hasStarted) {
      inLobby = false;
      inGame = true;
      showGameHud();
    } else {
      showLobbyNow();
    }
  } catch (err) {
    console.error(err);
    ui.toast(connectErrorToast(err));
    showMenu();
  }
}

quitBtn.onclick = () => showMenu();

// Global H toggles the How-to-play overlay from menus (in-game H is handled by LocalMode).
// Skip when typing in an input/textarea so player names containing 'h' work.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyH' || mode) return;
  const el = e.target as HTMLElement | null;
  if (el) {
    const tag = el.tagName?.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return;
  }
  try {
    ui.showHow({ onBack: showMenu });
  } catch {
    /* ignore */
  }
});

showMenu();
