import { renderHud, type HudState } from './hud.js';
import { LEVELS } from '../levels/levels.js';
import type { LevelDef } from '../../shared/types.js';
import { blankLevel, clearCustom, exportLevel, importLevel, loadCustom, saveCustom } from '../levels/editor.js';

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

export interface LobbyPlayer {
  name: string;
  color: string;
  bot: boolean;
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
  addr?: string;
  players: LobbyPlayer[];
}

export interface LobbyHandlers {
  onStart(): void;
  onLeave(): void;
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
  const ipHint = host ? ` · LAN: friends join <span class="font-mono text-green-300">ws://${esc(host)}:8080</span>` : '';
  return `<p class="text-center text-[11px] text-neutral-500 mt-4">clone for LAN parties · <span data-wins-note>first to ${getWinsTarget()} wins takes the match</span>${ipHint}</p>
    <p class="text-center text-[11px] text-neutral-600 mt-1">press <span class="font-mono text-neutral-400">H</span> in-game to toggle this help</p>`;
}

export class Ui {
  root: HTMLElement;
  private screen: HTMLElement;
  private toasts: HTMLElement;
  private hudRaf = 0;

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

  showSetup(titleText: string, cb: (d: SetupData) => void, opts: SetupOpts = {}): void {
    const state = { humans: 2, bots: true };
    this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-4">${esc(titleText)}</h2>
      <div class="flex flex-col gap-3">
        <label class="text-sm text-neutral-300">Fighter name
          <input id="s-name" class="${INPUT} mt-1" maxlength="12" placeholder="PLAYER1" value="PLAYER1" />
        </label>
        ${
          opts.ip
            ? `<label class="text-sm text-neutral-300">Host address
                 <input id="s-ip" class="${INPUT} mt-1 font-mono" placeholder="ws://${lanHint()}:8080" />
                 <span class="block text-[11px] text-neutral-500 mt-1">examples: <span class="font-mono text-neutral-300">ws://192.168.1.10:8080</span> · <span class="font-mono text-neutral-300">192.168.1.10:8080</span> · <span class="font-mono text-neutral-300">192.168.1.10</span> (port 8080)</span>
                 <span id="s-ip-err" class="hidden block text-[12px] text-red-400 mt-1"></span>
               </label>`
            : ''
        }
        ${
          !opts.ip && !opts.local
            ? `<div class="rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-[12px] text-neutral-300">
                 Friends join at <span class="font-mono text-green-300">ws://${esc(lanHint())}:8080</span><br />
                 <span class="text-neutral-400">On the host PC first run <span class="font-mono text-green-300">npm run host</span>, then press START below.</span>
               </div>`
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
    name?.select();
    const go = () => {
      const rawName = (name?.value || 'PLAYER').toUpperCase().slice(0, 12);
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
    const chips = info.players
      .map(
        (p) => `<div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700">
          <span class="w-4 h-4 rounded-full shrink-0" style="background:${p.color}"></span>
          <span class="font-bold text-sm">${esc(p.name)}</span>
          <span class="ml-auto text-[11px] px-2 py-0.5 rounded ${
            p.bot ? 'bg-purple-700 text-purple-100' : 'bg-green-700 text-green-100'
          }">${p.bot ? 'BOT' : 'HUMAN'}</span></div>`,
      )
      .join('');
    this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-1">${esc(info.title)}</h2>
      ${
        info.addr
          ? `<p class="text-center text-sm text-neutral-300 mb-3">Server: <span class="font-mono text-green-300">${esc(
              info.addr,
            )}</span></p>`
          : `<div class="mb-3"></div>`
      }
      <div class="flex flex-col gap-2 mb-4">${chips}</div>
      <div class="grid grid-cols-2 gap-2.5">
        <button id="l-start" class="${BTN_GREEN}">FIGHT!</button>
        <button id="l-leave" class="${BTN_GHOST}">LEAVE</button>
      </div>`);
    (this.screen.querySelector('#l-start') as HTMLButtonElement).onclick = () => cb.onStart();
    (this.screen.querySelector('#l-leave') as HTMLButtonElement).onclick = () => cb.onLeave();
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
