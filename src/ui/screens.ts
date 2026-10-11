import { renderHud, type HudState } from './hud.js';
import { LEVELS } from '../levels/levels.js';
import type { LevelDef } from '../../shared/types.js';
import { blankLevel, clearCustom, exportLevel, importLevel, loadCustom, saveCustom } from '../levels/editor.js';
import { findServerForCode } from '../net/discover.js';

export interface MenuHandlers {
  onLocal(n: number, bots: boolean): void;
  onHost(): void;
  onJoin(): void;
  onHow(): void;
  onEditor(): void;
}

// Match config: wins target stepper (3/5/10, default 5) persisted to localStorage.
// main.ts reads getWinsTarget() and passes it as LocalMode's `winsTarget` opt
// (first to target takes the match).
export const WINS_OPTIONS = [3, 5, 10] as const;
const WINS_KEY = 'sf_wins';

export function getWinsTarget(): number {
  try {
    const v = Number(localStorage.getItem(WINS_KEY));
    if (v === 3 || v === 5 || v === 10) return v;
  } catch {
    /* headless/ssr — fall through to default */
  }
  return 5;
}

export function setWinsTarget(v: number): void {
  try {
    localStorage.setItem(WINS_KEY, String(v));
  } catch {
    /* storage unavailable — ignore */
  }
}

export interface SetupData {
  name: string;
  ip: string;
  humans: number;
  bots: boolean;
  back?: boolean;
}

export interface SetupOpts {
  ip?: boolean;
  local?: boolean;
  startLabel?: string;
}

/**
 * Normalize a user-typed server address to a ws:// URL.
 * Accepts `ws://host:port`, `ws://host`, `host:port`, or bare `host`
 * (default port 8080). Returns null when the input is not a valid host[:port].
 */
export function normalizeWsUrl(raw: string): string | null {
  let s = (raw || '').trim();
  if (!s) return null;
  s = s.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  if (!/^wss?:\/\//i.test(s)) s = `ws://${s}`;
  const m = s.match(/^(wss?:\/\/)([^/:]+)(?::(\d+))?(?:\/.*)?$/i);
  if (!m) return null;
  const host = m[2].trim();
  if (!host || /[^a-zA-Z0-9.\-_]/.test(host)) return null;
  const port = m[3] ? Number(m[3]) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${m[1].toLowerCase()}${host}:${port}`;
}

function lanHint(): string {
  let host = '';
  try {
    host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : '';
  } catch {
    host = '';
  }
  return host || 'localhost';
}

/**
 * Port hint for the game server. When the page itself was served by the
 * combined host (`npm run host`, any --port), the page's own port IS the
 * game port — use it so custom ports work with zero config. Vite dev
 * (:5173) and `vite preview` (:4173) are client-only ports, so fall back
 * to the default game port there.
 */
function lanPort(): string {
  try {
    const p = typeof window !== 'undefined' ? window.location?.port : '';
    if (p && /^\d+$/.test(p) && p !== '5173' && p !== '4173') return p;
  } catch {
    /* non-browser — fall through */
  }
  return '8080';
}

/** `host:port` hint for the game server (dynamic port, see lanPort). */
export function lanWsHint(): string {
  return `${lanHint()}:${lanPort()}`;
}

export interface LobbyPlayer {
  name: string;
  color: string;
  bot: boolean;
  /** Client id from the roster broadcast (used for YOU detection). */
  id?: number;
  /** Slot from the roster broadcast (drives color fallback). */
  slot?: number;
  /** True for the local player. */
  isSelf?: boolean;
  /** True for the room host. */
  isHost?: boolean;
  /** Ready-up flag (non-host humans; bots always true). */
  ready?: boolean;
}

/**
 * Normalize a user-typed room code to uppercase alphanumeric.
 * Accepts 4–6 chars (server issues 4-letter codes). Returns null when invalid.
 */
export function normalizeRoomCode(raw: string): string | null {
  const s = (raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length < 4 || s.length > 6) return null;
  if (!/^[A-Z0-9]+$/.test(s)) return null;
  return s;
}

export interface CreateRoomData {
  name: string;
  serverUrl: string;
  wins: number;
  bots: boolean;
  levelId: string;
  levelJson?: string;
  back?: boolean;
}

export interface JoinRoomData {
  name: string;
  serverUrl: string;
  code: string;
  back?: boolean;
}

export interface EditorHandlers {
  onSave(level: LevelDef): void;
  onBack(): void;
}

const EDITOR_TIPS = `All coords are normalized 0..1 (x: 0 = left, 1 = right; y: 0 = top, 1 = bottom).
Boxes (platforms, movers, crates, killRects) need x/y/w/h with x+w ≤ 1 and y+h ≤ 1.
Spawns must be exactly 4 [x, y] points inside the arena — avoid putting them
inside solids or hazards. weaponDrops need at least 1 point; drops fall from
the sky and land on platforms. Save &amp; Play puts your map first in the
local rotation (banner shows CUSTOM). Copy-paste the JSON to share it.`;

function editorErrorsHTML(errors: string[]): string {
  if (errors.length === 0) {
    return `<p class="text-[12px] text-green-300">✓ Valid level — ready to save.</p>`;
  }
  const items = errors.map((e) => `<li>${esc(e)}</li>`).join('');
  return `<ul class="list-disc pl-5 text-[12px] text-red-300 max-h-28 overflow-auto">${items}</ul>`;
}

export interface LobbyInfo {
  title: string;
  /** Short room code (4 letters) — shown big for sharing. */
  code?: string;
  addr?: string;
  players: LobbyPlayer[];
  /** True when the local player is the room host (shows START + DELETE). */
  isHost?: boolean;
  /** Optional footer line. Rendered as plain text. */
  hint?: string;
  /** Local player's ready flag (non-host). */
  myReady?: boolean;
  /** True when the host may press START (all non-host humans ready). */
  canStart?: boolean;
  /** True when every non-host human is ready. */
  allReady?: boolean;
  /** Number of non-host humans still not ready. */
  waitingCount?: number;
}

export interface LobbyHandlers {
  onLeave(): void;
  onDelete?(): void;
  onToggleReady?(): void;
  onStart?(): void;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const BTN =
  'font-display tracking-wider px-6 py-3 rounded-lg border-b-4 transition active:translate-y-0.5 active:border-b-0 cursor-pointer select-none';
const BTN_RED = `${BTN} bg-red-600 hover:bg-red-500 border-red-900 text-white text-xl`;
const BTN_BLUE = `${BTN} bg-blue-600 hover:bg-blue-500 border-blue-900 text-white`;
const BTN_GREEN = `${BTN} bg-green-600 hover:bg-green-500 border-green-900 text-white`;
const BTN_YELLOW = `${BTN} bg-yellow-500 hover:bg-yellow-400 border-yellow-700 text-black`;
const BTN_GHOST = `${BTN} bg-neutral-800 hover:bg-neutral-700 border-neutral-950 text-neutral-200 text-sm`;
const INPUT =
  'w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 text-white text-sm outline-none focus:border-yellow-400';
const PANEL = 'bg-neutral-900/90 border-2 border-neutral-700 rounded-2xl p-6 shadow-[0_0_60px_rgba(0,0,0,0.8)]';

function title(html: string): string {
  return `<h1 class="font-display text-4xl md:text-5xl text-center leading-tight mb-1">
    <span class="text-yellow-300 text-stroke">STICK FIGHT:</span>
    <span class="text-red-500 text-stroke">LAN CLONE</span></h1>
    ${html ? `<p class="text-center text-neutral-400 text-sm mb-4">${html}</p>` : ''}`;
}

function stepperHTML(id: string, label: string, min: number, max: number, value: number): string {
  return `<div class="flex items-center justify-between gap-3">
    <span class="text-sm text-neutral-300">${label}</span>
    <div class="flex items-center gap-2">
      <button data-step="${id}|-1" class="w-8 h-8 rounded bg-neutral-700 hover:bg-neutral-600 font-bold">−</button>
      <span id="step-${id}" class="w-8 text-center font-display text-xl text-yellow-300">${value}</span>
      <button data-step="${id}|1" class="w-8 h-8 rounded bg-neutral-700 hover:bg-neutral-600 font-bold">+</button>
    </div></div>`;
}

function wireSteppers(root: HTMLElement, state: { humans: number }, min: number, max: number): void {
  root.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) => {
    b.onclick = () => {
      const d = Number((b.dataset.step as string).split('|')[1]);
      state.humans = Math.min(max, Math.max(min, state.humans + d));
      const el = root.querySelector('#step-humans');
      if (el) el.textContent = String(state.humans);
    };
  });
}

function botToggleHTML(on: boolean): string {
  return `<div class="flex items-center justify-between gap-3">
    <span class="text-sm text-neutral-300">Add bots</span>
    <button id="bot-toggle" class="px-4 py-1.5 rounded-md font-bold text-sm border ${
      on ? 'bg-green-600 border-green-800' : 'bg-neutral-700 border-neutral-900'
    }">${on ? 'ON' : 'OFF'}</button></div>`;
}

function wireBotToggle(root: HTMLElement, state: { bots: boolean }): void {
  const b = root.querySelector<HTMLButtonElement>('#bot-toggle');
  if (!b) return;
  b.onclick = () => {
    state.bots = !state.bots;
    b.textContent = state.bots ? 'ON' : 'OFF';
    b.className = `px-4 py-1.5 rounded-md font-bold text-sm border ${
      state.bots ? 'bg-green-600 border-green-800' : 'bg-neutral-700 border-neutral-900'
    }`;
  };
}

function winsHTML(cur: number): string {
  const btns = WINS_OPTIONS.map(
    (v) =>
      `<button data-wins="${v}" class="px-3 py-1.5 rounded-md font-bold text-sm border ${
        v === cur ? 'bg-yellow-500 border-yellow-700 text-black' : 'bg-neutral-700 border-neutral-900 text-neutral-200'
      }">${v}</button>`,
  ).join('');
  return `<div class="flex items-center justify-between gap-3">
    <span class="text-sm text-neutral-300">Round wins to take match</span>
    <div class="flex items-center gap-1.5">${btns}</div></div>`;
}

function wireWins(root: HTMLElement, state: { wins: number }): void {
  const paint = () => {
    root.querySelectorAll<HTMLButtonElement>('[data-wins]').forEach((x) => {
      const on = Number(x.dataset.wins) === state.wins;
      x.className = `px-3 py-1.5 rounded-md font-bold text-sm border ${
        on ? 'bg-yellow-500 border-yellow-700 text-black' : 'bg-neutral-700 border-neutral-900 text-neutral-200'
      }`;
    });
    const note = root.querySelector('[data-wins-note]');
    if (note) note.textContent = `first to ${state.wins} wins takes the match`;
  };
  root.querySelectorAll<HTMLButtonElement>('[data-wins]').forEach((b) => {
    b.onclick = () => {
      state.wins = Number(b.dataset.wins);
      setWinsTarget(state.wins);
      paint();
    };
  });
}

const CONTROLS: [string, string][] = [
  ['A / D or ← / →', 'Move'],
  ['W or ↑', 'Jump'],
  ['S or ↓', 'Fall through platform'],
  ['Mouse', 'Aim'],
  ['Left click', 'Fire weapon'],
  ['Right click', 'Block (reduces damage)'],
  ['F', 'Throw weapon'],
  ['H', 'Toggle help overlay'],
  ['R', 'Restart match'],
  ['Esc', 'Pause'],
  ['Q', 'Quit to menu'],
];

function footerHTML(): string {
  let host = '';
  try {
    host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : '';
  } catch {
    host = '';
  }
  const ipHint = host ? ` · LAN room server <span class="font-mono text-green-300">ws://${esc(lanWsHint())}</span> — HOST creates a room, friends JOIN with the code` : '';
  return `<p class="text-center text-[11px] text-neutral-500 mt-4">clone for LAN parties · <span data-wins-note>first to ${getWinsTarget()} wins takes the match</span>${ipHint}</p>
    <p class="text-center text-[11px] text-neutral-600 mt-1">press <span class="font-mono text-neutral-400">H</span> in-game to toggle this help</p>`;
}

function lobbyCountText(players: LobbyPlayer[]): string {
  return `${players.length}/4 players`;
}

function lobbyChipsHTML(players: LobbyPlayer[]): string {
  return players
    .map((p) => {
      const botBadge = p.bot
        ? `<span class="ml-auto text-[11px] px-2 py-0.5 rounded bg-purple-700 text-purple-100">BOT</span>`
        : '';
      const readyBadge = !p.bot && !p.isHost
        ? p.ready
          ? `<span class="text-[11px] px-1.5 py-0.5 rounded bg-green-700 text-green-50 font-bold">✓ READY</span>`
          : `<span class="text-[11px] px-1.5 py-0.5 rounded bg-neutral-700 text-neutral-300">○ NOT READY</span>`
        : '';
      const tags = `${p.isSelf ? `<span class="text-[11px] px-1.5 py-0.5 rounded bg-blue-700 text-blue-50">YOU</span>` : ''}${p.isHost ? `<span class="text-[11px] px-1.5 py-0.5 rounded bg-yellow-600 text-black font-bold">HOST</span>` : ''}${readyBadge}`;
      return `<div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-neutral-800 border ${p.isSelf ? 'border-blue-600' : 'border-neutral-700'}">
        <span class="w-4 h-4 rounded-full shrink-0" style="background:${p.color}"></span>
        <span class="font-bold text-sm">${esc(p.name)}</span>${tags ? `<span class="flex gap-1">${tags}</span>` : ''}${botBadge}</div>`;
    })
    .join('');
}

/** Status line under the chips: ready progress for host, ready state for guests. */
function lobbyStatusText(info: Pick<LobbyInfo, 'isHost' | 'players' | 'myReady' | 'allReady' | 'waitingCount'>): string {
  const humans = info.players.filter((p) => !p.bot);
  if (info.isHost) {
    if (humans.length <= 1) return 'Share the code — waiting for players to join… (you can START solo anytime)';
    const n = info.waitingCount ?? humans.filter((p) => !p.isHost && !p.ready).length;
    if (n <= 0) return 'All players ready — press START MATCH!';
    return `Waiting for ${n} player${n === 1 ? '' : 's'} to ready up…`;
  }
  if (info.myReady) return 'You are READY! Waiting for the host to start…';
  return 'Press READY UP when you are ready to fight!';
}

export class Ui {
  root: HTMLElement;
  private screen: HTMLElement;
  private toasts: HTMLElement;
  private hudRaf = 0;
  private pendingScan: AbortController | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `<div data-screen class="absolute inset-0 overflow-auto"></div>
      <div data-toasts class="absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none z-50"></div>`;
    this.screen = this.root.querySelector('[data-screen]') as HTMLElement;
    this.toasts = this.root.querySelector('[data-toasts]') as HTMLElement;
  }

  clear(): void {
    cancelAnimationFrame(this.hudRaf);
    this.hudRaf = 0;
    try {
      this.pendingScan?.abort();
    } catch {
      /* ignore */
    }
    this.pendingScan = null;
    this.screen.innerHTML = '';
  }

  toast(msg: string): void {
    const d = document.createElement('div');
    d.className =
      'toast-in px-4 py-2 rounded-lg bg-black/85 border border-yellow-400/60 text-sm text-yellow-100 whitespace-nowrap';
    d.textContent = msg;
    this.toasts.appendChild(d);
    while (this.toasts.children.length > 3) this.toasts.firstChild?.remove();
    setTimeout(() => d.remove(), 2600);
  }

  private shell(inner: string, wide = false): void {
    this.clear();
    this.screen.innerHTML = `<div class="min-h-full flex items-center justify-center p-4 bg-[radial-gradient(ellipse_at_center,rgba(60,0,0,0.55),transparent_70%)]">
      <div class="${PANEL} ${wide ? 'w-[560px]' : 'w-[440px]'}">${inner}</div></div>`;
  }

  showMenu(cb: MenuHandlers): void {
    const state = { humans: 2, bots: true, wins: getWinsTarget() };
    let customNote = '';
    try {
      if (loadCustom()) {
        customNote = `<p class="text-center text-[12px] text-green-300 mb-1">custom map saved — EDITOR → SAVE &amp; PLAY to fight on it</p>`;
      }
    } catch {
      /* storage unavailable — no note */
    }
    this.shell(`${title('a clone for LAN parties')}
      <p class="text-center text-[12px] text-neutral-400 -mt-2 mb-1">${LEVELS.length} rotating arenas · random every round</p>
      ${customNote}
      <div class="flex flex-col gap-2.5 my-4">
        ${stepperHTML('humans', 'Local humans (rest become bots)', 1, 4, state.humans)}
        ${botToggleHTML(state.bots)}
        ${winsHTML(state.wins)}
      </div>
      <div class="flex flex-col gap-2.5">
        <button id="m-local" class="${BTN_RED}">LOCAL FIGHT</button>
        <div class="grid grid-cols-2 gap-2.5">
          <button id="m-host" class="${BTN_BLUE}">HOST</button>
          <button id="m-join" class="${BTN_GREEN}">JOIN</button>
        </div>
        <div class="grid grid-cols-2 gap-2.5">
          <button id="m-how" class="${BTN_GHOST}">HOW TO PLAY</button>
          <button id="m-editor" class="${BTN_GHOST}">LEVEL EDITOR</button>
        </div>
      </div>
      ${footerHTML()}`);
    wireSteppers(this.screen, state, 1, 4);
    wireBotToggle(this.screen, state as { bots: boolean });
    wireWins(this.screen, state as { wins: number });
    const q = (s: string) => this.screen.querySelector<HTMLButtonElement>(s);
    (q('#m-local') as HTMLButtonElement).onclick = () => cb.onLocal(state.humans, state.bots);
    (q('#m-host') as HTMLButtonElement).onclick = () => cb.onHost();
    (q('#m-join') as HTMLButtonElement).onclick = () => cb.onJoin();
    (q('#m-how') as HTMLButtonElement).onclick = () => cb.onHow();
    (q('#m-editor') as HTMLButtonElement).onclick = () => cb.onEditor();
  }

  showCreateRoom(cb: (d: CreateRoomData) => void): void {
    const state = { wins: getWinsTarget(), bots: false, levelId: LEVELS[0]?.id ?? 'woods1' };
    let customJson: string | null = null;
    const levelOpts = LEVELS.map(
      (l) => `<option value="${esc(l.id)}"${l.id === state.levelId ? ' selected' : ''}>${esc(l.name)}</option>`,
    ).join('');
    this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-4">HOST — CREATE ROOM</h2>
      <div class="flex flex-col gap-3">
        <label class="text-sm text-neutral-300">Fighter name
          <input id="s-name" class="${INPUT} mt-1" maxlength="12" placeholder="Enter your name" value="" autocomplete="off" spellcheck="false" />
          <span id="s-name-err" class="hidden block text-[12px] text-red-400 mt-1"></span>
        </label>
        <label class="text-sm text-neutral-300">Room server address
          <input id="s-server" class="${INPUT} mt-1 font-mono" value="ws://${esc(lanWsHint())}" />
          <span class="block text-[11px] text-neutral-500 mt-1">the LAN game server (any machine on your network runs <span class="font-mono text-neutral-300">npm run host</span>). Same Wi-Fi, use its LAN IP.</span>
          <span id="s-server-err" class="hidden block text-[12px] text-red-400 mt-1"></span>
        </label>
        <label class="text-sm text-neutral-300">Arena
          <select id="s-level" class="${INPUT} mt-1">${levelOpts}</select>
        </label>
        ${winsHTML(state.wins)}
        ${botToggleHTML(state.bots)}
        <div class="rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-[12px] text-neutral-300">
          <span class="font-bold text-neutral-200">Custom map (optional)</span><br />
          <span class="text-neutral-400">Upload an editor JSON — it is sent to the server with your room. Joiners receive it automatically.</span>
          <input id="s-custom-file" type="file" accept=".json,application/json"
            class="mt-2 block w-full text-[12px] text-neutral-400 file:mr-2 file:px-3 file:py-1 file:rounded file:border file:border-neutral-900 file:bg-neutral-700 file:text-neutral-100" />
          <span id="s-custom-status" class="block mt-1 text-neutral-500">no custom map — using arena above</span>
        </div>
        <button id="s-go" class="${BTN_YELLOW} mt-1">CREATE ROOM</button>
        <button id="s-back" class="${BTN_GHOST}">BACK</button>
      </div>`);
    wireBotToggle(this.screen, state as { bots: boolean });
    wireWins(this.screen, state as { wins: number });
    const name = this.screen.querySelector<HTMLInputElement>('#s-name');
    const server = this.screen.querySelector<HTMLInputElement>('#s-server');
    const serverErr = this.screen.querySelector<HTMLElement>('#s-server-err');
    const nameErr = this.screen.querySelector<HTMLElement>('#s-name-err');
    const level = this.screen.querySelector<HTMLSelectElement>('#s-level');
    name?.focus();
    name?.addEventListener('input', () => nameErr?.classList.add('hidden'));
    level?.addEventListener('change', () => {
      state.levelId = level.value;
    });
    const customFile = this.screen.querySelector<HTMLInputElement>('#s-custom-file');
    const customStatus = this.screen.querySelector<HTMLElement>('#s-custom-status');
    if (customFile && customStatus) {
      customFile.addEventListener('change', () => {
        const f = customFile.files?.[0];
        if (!f) {
          customJson = null;
          customStatus.textContent = 'no custom map — using arena above';
          customStatus.className = 'block mt-1 text-neutral-500';
          return;
        }
        void f.text().then((text) => {
          try {
            importLevel(text); // full editor validation
            customJson = text;
            customStatus.textContent = `custom map ready: ${f.name} — sent with your room`;
            customStatus.className = 'block mt-1 text-green-300';
            this.toast('Custom map validated — it will be sent with your room');
          } catch (err) {
            customJson = null;
            customStatus.textContent = err instanceof Error ? err.message.split('\n')[0] : String(err);
            customStatus.className = 'block mt-1 text-red-300';
          }
        });
      });
    }
    const go = () => {
      const rawName = (name?.value || '').trim().toUpperCase().slice(0, 12);
      if (!rawName) {
        if (nameErr) {
          nameErr.textContent = 'Enter your fighter name before creating a room';
          nameErr.classList.remove('hidden');
        }
        this.toast('Enter your fighter name before creating a room');
        name?.focus();
        return;
      }
      const url = normalizeWsUrl(server?.value || '');
      if (!url) {
        if (serverErr) {
          serverErr.textContent = 'Enter a valid address, e.g. ws://192.168.1.10:8080';
          serverErr.classList.remove('hidden');
        }
        this.toast('Enter a valid server address, e.g. ws://192.168.1.10:8080');
        server?.focus();
        return;
      }
      cb({
        name: rawName, serverUrl: url, wins: state.wins,
        bots: state.bots, levelId: state.levelId,
        ...(customJson ? { levelJson: customJson } : {}),
      });
    };
    (this.screen.querySelector('#s-go') as HTMLButtonElement).onclick = go;
    (this.screen.querySelector('#s-back') as HTMLButtonElement).onclick = () =>
      cb({ name: '', serverUrl: '', wins: state.wins, bots: false, levelId: state.levelId, back: true });
  }

  showJoinRoom(cb: (d: JoinRoomData) => void): void {
    this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-4">JOIN — ROOM CODE</h2>
      <div class="flex flex-col gap-3">
        <label class="text-sm text-neutral-300">Fighter name
          <input id="s-name" class="${INPUT} mt-1" maxlength="12" placeholder="Enter your name" value="" autocomplete="off" spellcheck="false" />
          <span id="s-name-err" class="hidden block text-[12px] text-red-400 mt-1"></span>
        </label>
        <label class="text-sm text-neutral-300">Room code
          <input id="s-code" class="${INPUT} mt-1 font-mono uppercase tracking-[0.3em] text-center !text-xl font-bold" maxlength="6" placeholder="AB12" autocomplete="off" spellcheck="false" />
          <span class="block text-[11px] text-neutral-500 mt-1">4-letter code from the host (e.g. <span class="font-mono text-neutral-300">AB12</span>). Same Wi-Fi — the game finds the server itself.</span>
          <span id="s-code-err" class="hidden block text-[12px] text-red-400 mt-1"></span>
        </label>
        <div id="s-status" class="hidden rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-[12px] text-neutral-300"></div>
        <button id="s-go" class="${BTN_YELLOW} mt-1">🔍 JOIN ROOM</button>
        <details class="rounded-md bg-neutral-800/60 border border-neutral-800 px-3 py-2">
          <summary class="cursor-pointer text-[12px] text-neutral-400 hover:text-neutral-200 select-none">Advanced: manual server address</summary>
          <div class="mt-2 flex flex-col gap-2">
            <input id="s-server" class="${INPUT} font-mono" value="ws://${esc(lanWsHint())}" />
            <span class="block text-[11px] text-neutral-500">same server the host used (ask the host for the address if auto-find fails).</span>
            <span id="s-server-err" class="hidden block text-[12px] text-red-400 mt-1"></span>
            <button id="s-manual" class="${BTN_GHOST}">JOIN WITH ADDRESS</button>
          </div>
        </details>
        <button id="s-back" class="${BTN_GHOST}">BACK</button>
      </div>`);
    const name = this.screen.querySelector<HTMLInputElement>('#s-name');
    const server = this.screen.querySelector<HTMLInputElement>('#s-server');
    const code = this.screen.querySelector<HTMLInputElement>('#s-code');
    const nameErr = this.screen.querySelector<HTMLElement>('#s-name-err');
    const serverErr = this.screen.querySelector<HTMLElement>('#s-server-err');
    const codeErr = this.screen.querySelector<HTMLElement>('#s-code-err');
    const status = this.screen.querySelector<HTMLElement>('#s-status');
    const goBtn = this.screen.querySelector<HTMLButtonElement>('#s-go');
    const manualBtn = this.screen.querySelector<HTMLButtonElement>('#s-manual');
    const backBtn = this.screen.querySelector<HTMLButtonElement>('#s-back');
    name?.focus();
    name?.addEventListener('input', () => nameErr?.classList.add('hidden'));
    code?.addEventListener('input', () => {
      if (code.value) code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });
    let ctrl: AbortController | null = null;
    const setStatus = (msg: string, kind: 'info' | 'error' | 'ok' = 'info'): void => {
      if (!status || !status.isConnected) return;
      status.classList.remove('hidden');
      status.textContent = msg;
      status.className =
        kind === 'error'
          ? 'rounded-md bg-neutral-800 border border-red-500/60 px-3 py-2 text-[12px] text-red-200'
          : kind === 'ok'
            ? 'rounded-md bg-neutral-800 border border-green-500/60 px-3 py-2 text-[12px] text-green-200'
            : 'rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-[12px] text-neutral-300';
    };
    const clearStatus = (): void => {
      if (!status) return;
      status.classList.add('hidden');
      status.textContent = '';
    };
    const setBusy = (busy: boolean): void => {
      if (goBtn) {
        goBtn.disabled = busy;
        goBtn.textContent = busy ? 'SCANNING LAN…' : '🔍 JOIN ROOM';
        goBtn.classList.toggle('opacity-60', busy);
      }
      if (manualBtn) {
        manualBtn.disabled = busy;
        manualBtn.classList.toggle('opacity-60', busy);
      }
    };
    const failCode = (msg: string): void => {
      if (codeErr) {
        codeErr.textContent = msg;
        codeErr.classList.remove('hidden');
      }
      this.toast(msg);
      code?.focus();
    };
    const failName = (): boolean => {
      const v = (name?.value || '').trim();
      if (v) {
        nameErr?.classList.add('hidden');
        return false;
      }
      if (nameErr) {
        nameErr.textContent = 'Enter your fighter name before joining a room';
        nameErr.classList.remove('hidden');
      }
      this.toast('Enter your fighter name before joining a room');
      name?.focus();
      return true;
    };
    const goAuto = (): void => {
      if (failName()) return;
      const rawName = (name?.value || '').trim().toUpperCase().slice(0, 12);
      const roomCode = normalizeRoomCode(code?.value || '');
      if (!roomCode) {
        failCode('Enter the 4-letter room code from the host');
        return;
      }
      if (codeErr) codeErr.classList.add('hidden');
      if (serverErr) serverErr.classList.add('hidden');
      // Abort any in-flight scan before starting a new one.
      try {
        ctrl?.abort();
      } catch {
        /* ignore */
      }
      ctrl = new AbortController();
      this.pendingScan = ctrl;
      const my = ctrl;
      setBusy(true);
      setStatus('Scanning LAN…');
      void findServerForCode(roomCode, rawName, {
        timeoutMs: 800,
        concurrency: 64,
        signal: my.signal,
        onProgress: (done, total) => {
          if (my.signal.aborted) return;
          setStatus(`Scanning LAN… ${done}/${total}`);
        },
        onStage: (msg) => {
          if (my.signal.aborted) return;
          setStatus(msg);
        },
      })
        .then((found) => {
          if (my.signal.aborted) return;
          if (this.pendingScan === my) this.pendingScan = null;
          setStatus(`Found ${found.ip}:${found.port}, joining…`, 'ok');
          cb({ name: rawName, serverUrl: found.wsUrl, code: roomCode });
        })
        .catch((err: unknown) => {
          if (my.signal.aborted) return;
          if (this.pendingScan === my) this.pendingScan = null;
          setBusy(false);
          const msg = err instanceof Error ? err.message : String(err ?? 'Could not connect');
          setStatus(msg.slice(0, 160), 'error');
          this.toast(msg.slice(0, 90));
        });
    };
    const goManual = (): void => {
      if (failName()) return;
      const rawName = (name?.value || '').trim().toUpperCase().slice(0, 12);
      const url = normalizeWsUrl(server?.value || '');
      if (!url) {
        if (serverErr) {
          serverErr.textContent = 'Enter a valid address, e.g. ws://192.168.1.10:8080';
          serverErr.classList.remove('hidden');
        }
        this.toast('Enter a valid server address, e.g. ws://192.168.1.10:8080');
        server?.focus();
        return;
      }
      const roomCode = normalizeRoomCode(code?.value || '');
      if (!roomCode) {
        failCode('Enter the 4-letter room code from the host');
        return;
      }
      try {
        ctrl?.abort();
      } catch {
        /* ignore */
      }
      if (this.pendingScan === ctrl) this.pendingScan = null;
      ctrl = null;
      clearStatus();
      cb({ name: rawName, serverUrl: url, code: roomCode });
    };
    if (goBtn) goBtn.onclick = goAuto;
    if (manualBtn) manualBtn.onclick = goManual;
    if (backBtn) {
      backBtn.onclick = () => {
        try {
          ctrl?.abort();
        } catch {
          /* ignore */
        }
        if (this.pendingScan === ctrl) this.pendingScan = null;
        ctrl = null;
        cb({ name: '', serverUrl: '', code: '', back: true });
      };
    }
  }

  /** Legacy setup (local-only flows). Kept for compat; online uses create/join above. */
  showSetup(titleText: string, cb: (d: SetupData) => void, opts: SetupOpts = {}): void {
    const state = { humans: 2, bots: true };
    this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-4">${esc(titleText)}</h2>
      <div class="flex flex-col gap-3">
        <label class="text-sm text-neutral-300">Fighter name
          <input id="s-name" class="${INPUT} mt-1" maxlength="12" placeholder="Enter your name" value="" autocomplete="off" spellcheck="false" />
          <span id="s-name-err" class="hidden block text-[12px] text-red-400 mt-1"></span>
        </label>
        ${
          opts.ip
            ? `<label class="text-sm text-neutral-300">Host address
                 <input id="s-ip" class="${INPUT} mt-1 font-mono" placeholder="ws://${lanWsHint()}" />
                 <span class="block text-[11px] text-neutral-500 mt-1">examples: <span class="font-mono text-neutral-300">ws://192.168.1.10:8080</span> · <span class="font-mono text-neutral-300">192.168.1.10:8080</span> · <span class="font-mono text-neutral-300">192.168.1.10</span> (port 8080)</span>
                 <span id="s-ip-err" class="hidden block text-[12px] text-red-400 mt-1"></span>
               </label>`
            : ''
        }
        ${
          opts.local
            ? `${stepperHTML('humans', 'Humans', 1, 4, state.humans)}${botToggleHTML(state.bots)}`
            : ''
        }
        <button id="s-go" class="${BTN_YELLOW} mt-1">${esc(opts.startLabel ?? 'START')}</button>
        <button id="s-back" class="${BTN_GHOST}">BACK</button>
      </div>`);
    wireSteppers(this.screen, state, 1, 4);
    wireBotToggle(this.screen, state as { bots: boolean });
    const name = this.screen.querySelector<HTMLInputElement>('#s-name');
    const ip = this.screen.querySelector<HTMLInputElement>('#s-ip');
    const ipErr = this.screen.querySelector<HTMLElement>('#s-ip-err');
    const nameErr = this.screen.querySelector<HTMLElement>('#s-name-err');
    name?.focus();
    name?.addEventListener('input', () => nameErr?.classList.add('hidden'));
    const go = () => {
      const rawName = (name?.value || '').trim().toUpperCase().slice(0, 12);
      if (!rawName) {
        if (nameErr) {
          nameErr.textContent = 'Enter your fighter name before continuing';
          nameErr.classList.remove('hidden');
        }
        this.toast('Enter your fighter name before continuing');
        name?.focus();
        return;
      }
      if (opts.ip) {
        const url = normalizeWsUrl(ip?.value || '');
        if (!url) {
          if (ipErr) {
            ipErr.textContent = 'Enter a valid address, e.g. ws://192.168.1.10:8080';
            ipErr.classList.remove('hidden');
          }
          this.toast('Enter a valid address, e.g. ws://192.168.1.10:8080');
          ip?.focus();
          return;
        }
        cb({ name: rawName, ip: url, humans: state.humans, bots: state.bots });
        return;
      }
      cb({ name: rawName, ip: (ip?.value || '').trim(), humans: state.humans, bots: state.bots });
    };
    (this.screen.querySelector('#s-go') as HTMLButtonElement).onclick = go;
    (this.screen.querySelector('#s-back') as HTMLButtonElement).onclick = () =>
      cb({ name: '', ip: '', humans: state.humans, bots: state.bots, back: true });
  }

  showLobby(info: LobbyInfo, cb: LobbyHandlers): void {
    const status = lobbyStatusText(info);
    const startDisabled = info.isHost && !info.canStart ? 'disabled' : '';
    this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-1">${esc(info.title)}</h2>
      ${
        info.code
          ? `<div class="text-center mb-1">
               <div class="text-[11px] tracking-[0.25em] text-neutral-400 font-bold">ROOM CODE</div>
               <div class="font-mono font-bold text-4xl tracking-[0.2em] text-yellow-300 select-all">${esc(info.code)}</div>
               <div class="text-[11px] text-neutral-500 mt-0.5">share this code — friends JOIN with it</div>
             </div>`
          : `<div class="mb-1"></div>`
      }
      ${
        info.addr
          ? `<p class="text-center text-sm text-neutral-300 mb-1">Server: <span class="font-mono text-green-300">${esc(
              info.addr,
            )}</span></p>`
          : ``
      }
      <p id="lobby-count" class="text-center text-[12px] text-neutral-400 mb-2">${esc(lobbyCountText(info.players))}</p>
      <div id="lobby-players" class="flex flex-col gap-2 mb-3">${lobbyChipsHTML(info.players)}</div>
      <p id="lobby-status" class="text-center text-[13px] font-bold mb-3 ${info.isHost && info.canStart ? 'text-green-300' : 'text-yellow-200'}">${esc(status)}</p>
      ${
        info.hint
          ? `<p class="text-center text-[11px] text-neutral-500 mb-3">${esc(info.hint)}</p>`
          : ''
      }
      <div class="flex flex-col gap-2.5">
        ${info.isHost
          ? `<button id="l-start" class="${BTN_GREEN} !text-lg disabled:opacity-40 disabled:cursor-not-allowed" ${startDisabled}>▶ START MATCH</button>`
          : `<button id="l-ready" class="${info.myReady ? BTN_YELLOW : BTN_GREEN} !text-lg">${info.myReady ? '✓ READY — TAP TO UNREADY' : 'READY UP'}</button>`}
        ${info.isHost ? `<button id="l-delete" class="${BTN_RED} !text-base">DELETE ROOM</button>` : ''}
        <button id="l-leave" class="${BTN_GHOST}">${info.isHost ? 'QUIT (DELETES ROOM)' : 'LEAVE'}</button>
      </div>`);
    (this.screen.querySelector('#l-leave') as HTMLButtonElement).onclick = () => cb.onLeave();
    const del = this.screen.querySelector<HTMLButtonElement>('#l-delete');
    if (del) del.onclick = () => cb.onDelete?.() ?? cb.onLeave();
    const start = this.screen.querySelector<HTMLButtonElement>('#l-start');
    if (start) start.onclick = () => cb.onStart?.();
    const ready = this.screen.querySelector<HTMLButtonElement>('#l-ready');
    if (ready) ready.onclick = () => cb.onToggleReady?.();
  }

  /**
   * Live-update lobby chips + player count + ready/start state
   * (e.g. from NetClient onRoster). No-op when no lobby is shown.
   */
  updateLobby(
    players: LobbyPlayer[],
    opts: { isHost?: boolean; myReady?: boolean; canStart?: boolean; allReady?: boolean; waitingCount?: number } = {},
  ): void {
    const chips = this.screen.querySelector('#lobby-players');
    if (!chips && !this.screen.querySelector('#lobby-count')) return;
    if (chips) chips.innerHTML = lobbyChipsHTML(players);
    const count = this.screen.querySelector('#lobby-count');
    if (count) count.textContent = lobbyCountText(players);
    const isHost = opts.isHost ?? !!this.screen.querySelector('#l-start');
    const statusEl = this.screen.querySelector('#lobby-status');
    if (statusEl) {
      const text = lobbyStatusText({
        isHost,
        players,
        myReady: opts.myReady,
        allReady: opts.allReady,
        waitingCount: opts.waitingCount,
      });
      statusEl.textContent = text;
      const canStart = opts.canStart ?? false;
      statusEl.className = `text-center text-[13px] font-bold mb-3 ${isHost && canStart ? 'text-green-300' : 'text-yellow-200'}`;
    }
    const start = this.screen.querySelector<HTMLButtonElement>('#l-start');
    if (start && isHost) {
      const can = opts.canStart ?? false;
      start.disabled = !can;
      start.textContent = can ? '▶ START MATCH' : '▶ START MATCH (WAITING…)';
    }
    const ready = this.screen.querySelector<HTMLButtonElement>('#l-ready');
    if (ready && !isHost) {
      const myReady = opts.myReady ?? false;
      ready.textContent = myReady ? '✓ READY — TAP TO UNREADY' : 'READY UP';
      ready.className = `${myReady ? BTN_YELLOW : BTN_GREEN} !text-lg`;
    }
  }

  showHow(cb: { onBack(): void }): void {
    const rows = CONTROLS.map(
      ([k, v]) => `<tr class="border-b border-neutral-800 last:border-0">
        <td class="py-1.5 pr-3 font-mono text-xs text-yellow-200 whitespace-nowrap">${esc(k)}</td>
        <td class="py-1.5 text-sm text-neutral-300">${esc(v)}</td></tr>`,
    ).join('');
    this.shell(
      `${title('')}
      <table class="w-full mb-4"><tbody>${rows}</tbody></table>
      <p class="text-[12px] text-neutral-400 mb-4">Grab falling weapons, knock your friends off the stage, and don't stand in lava. First to ${getWinsTarget()} round wins takes the match.</p>
      <button id="h-back" class="${BTN_YELLOW} w-full">BACK</button>
      ${footerHTML()}`,
      true,
    );
    (this.screen.querySelector('#h-back') as HTMLButtonElement).onclick = () => cb.onBack();
  }

  /** Minimal level editor: JSON textarea + Validate / Save&Play / Clear + tips. */
  showEditor(initial: string, cb: EditorHandlers): void {
    this.shell(
      `<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-1">LEVEL EDITOR</h2>
      <p class="text-center text-neutral-400 text-sm mb-3">paste or edit level JSON, validate, then save &amp; play</p>
      <textarea id="ed-json" spellcheck="false" class="${INPUT} font-mono !text-[11px] leading-relaxed h-56 resize-y">${esc(initial)}</textarea>
      <div id="ed-errors" class="mt-2 min-h-6"></div>
      <div class="grid grid-cols-3 gap-2.5 mt-2">
        <button id="ed-validate" class="${BTN_BLUE} !px-2">VALIDATE</button>
        <button id="ed-save" class="${BTN_YELLOW} !px-2">SAVE &amp; PLAY</button>
        <button id="ed-clear" class="${BTN_GHOST} !px-2">CLEAR</button>
      </div>
      <button id="ed-back" class="${BTN_GHOST} w-full mt-2.5">BACK</button>
      <p class="text-[11px] text-neutral-400 whitespace-pre-line mt-3">${EDITOR_TIPS}</p>`,
      true,
    );
    const area = this.screen.querySelector<HTMLTextAreaElement>('#ed-json');
    const errBox = this.screen.querySelector<HTMLElement>('#ed-errors');
    const showErrors = (errors: string[]) => {
      if (errBox) errBox.innerHTML = editorErrorsHTML(errors);
    };
    const currentText = (): string => area?.value ?? '';
    (this.screen.querySelector('#ed-validate') as HTMLButtonElement).onclick = () => {
      try {
        importLevel(currentText());
        showErrors([]);
        this.toast('Level is valid');
      } catch (err) {
        showErrors(err instanceof Error ? err.message.replace(/^Invalid level:\n/, '').split('\n- ') : [String(err)]);
      }
    };
    (this.screen.querySelector('#ed-save') as HTMLButtonElement).onclick = () => {
      try {
        const level = importLevel(currentText());
        saveCustom(level);
        showErrors([]);
        this.toast('Custom level saved — good luck!');
        cb.onSave(level);
      } catch (err) {
        showErrors(err instanceof Error ? err.message.replace(/^Invalid level:\n/, '').split('\n- ') : [String(err)]);
        this.toast('Fix the errors before saving');
      }
    };
    (this.screen.querySelector('#ed-clear') as HTMLButtonElement).onclick = () => {
      clearCustom();
      if (area) area.value = exportLevel(blankLevel());
      showErrors([]);
      this.toast('Editor reset to a blank level');
    };
    (this.screen.querySelector('#ed-back') as HTMLButtonElement).onclick = () => cb.onBack();
  }

  /** Pause menu overlay with resume / restart / quit. */
  showPause(cb: { onResume(): void; onRestart(): void; onQuit(): void }): void {
    this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-1">PAUSED</h2>
      <p class="text-center text-neutral-400 text-sm mb-4">take a breath — first to ${getWinsTarget()} takes the match</p>
      <div class="flex flex-col gap-2.5">
        <button id="p-resume" class="${BTN_GREEN}">RESUME (Esc)</button>
        <button id="p-restart" class="${BTN_YELLOW}">RESTART (R)</button>
        <button id="p-quit" class="${BTN_RED}">QUIT TO MENU (Q)</button>
      </div>
      ${footerHTML()}`);
    (this.screen.querySelector('#p-resume') as HTMLButtonElement).onclick = () => cb.onResume();
    (this.screen.querySelector('#p-restart') as HTMLButtonElement).onclick = () => cb.onRestart();
    (this.screen.querySelector('#p-quit') as HTMLButtonElement).onclick = () => cb.onQuit();
  }

  /** Match-win banner: first-to-5 with REMATCH + MENU buttons. */
  showWin(winner: string, wins: number, target: number, cb: { onRematch(): void; onMenu(): void }): void {
    this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-1">🏆 ${esc(winner)} WINS!</h2>
      <p class="text-center text-neutral-300 text-sm mb-4">final score ${wins} — first to ${target} takes the match</p>
      <div class="grid grid-cols-2 gap-2.5">
        <button id="w-rematch" class="${BTN_YELLOW}">REMATCH (R)</button>
        <button id="w-menu" class="${BTN_GHOST}">MENU (Q)</button>
      </div>
      ${footerHTML()}`);
    (this.screen.querySelector('#w-rematch') as HTMLButtonElement).onclick = () => cb.onRematch();
    (this.screen.querySelector('#w-menu') as HTMLButtonElement).onclick = () => cb.onMenu();
  }

  showHud(getter: () => HudState): () => void {
    this.clear();
    const hud = document.createElement('div');
    hud.className = 'absolute inset-0 pointer-events-none';
    this.screen.appendChild(hud);
    const tick = () => {
      try {
        renderHud(hud, getter());
      } catch {
        /* mode torn down */
      }
      this.hudRaf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(this.hudRaf);
  }
}
