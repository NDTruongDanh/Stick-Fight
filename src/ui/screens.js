import { renderHud } from './hud.js';
import { LEVELS } from '../levels/levels.js';
import { blankLevel, clearCustom, exportLevel, importLevel, loadCustom, saveCustom } from '../levels/editor.js';
// Match config: wins target stepper (3/5/10, default 5) persisted to localStorage.
// main.ts reads getWinsTarget() and passes it as LocalMode's `winsTarget` opt
// (first to target takes the match).
export const WINS_OPTIONS = [3, 5, 10];
const WINS_KEY = 'sf_wins';
export function getWinsTarget() {
    try {
        const v = Number(localStorage.getItem(WINS_KEY));
        if (v === 3 || v === 5 || v === 10)
            return v;
    }
    catch {
        /* headless/ssr — fall through to default */
    }
    return 5;
}
export function setWinsTarget(v) {
    try {
        localStorage.setItem(WINS_KEY, String(v));
    }
    catch {
        /* storage unavailable — ignore */
    }
}
/**
 * Normalize a user-typed server address to a ws:// URL.
 * Accepts `ws://host:port`, `ws://host`, `host:port`, or bare `host`
 * (default port 8080). Returns null when the input is not a valid host[:port].
 */
export function normalizeWsUrl(raw) {
    let s = (raw || '').trim();
    if (!s)
        return null;
    s = s.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    if (!/^wss?:\/\//i.test(s))
        s = `ws://${s}`;
    const m = s.match(/^(wss?:\/\/)([^/:]+)(?::(\d+))?(?:\/.*)?$/i);
    if (!m)
        return null;
    const host = m[2].trim();
    if (!host || /[^a-zA-Z0-9.\-_]/.test(host))
        return null;
    const port = m[3] ? Number(m[3]) : 8080;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        return null;
    return `${m[1].toLowerCase()}${host}:${port}`;
}
function lanHint() {
    let host = '';
    try {
        host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : '';
    }
    catch {
        host = '';
    }
    return host || 'localhost';
}
const EDITOR_TIPS = `All coords are normalized 0..1 (x: 0 = left, 1 = right; y: 0 = top, 1 = bottom).
Boxes (platforms, movers, crates, killRects) need x/y/w/h with x+w ≤ 1 and y+h ≤ 1.
Spawns must be exactly 4 [x, y] points inside the arena — avoid putting them
inside solids or hazards. weaponDrops need at least 1 point; drops fall from
the sky and land on platforms. Save &amp; Play puts your map first in the
local rotation (banner shows CUSTOM). Copy-paste the JSON to share it.`;
function editorErrorsHTML(errors) {
    if (errors.length === 0) {
        return `<p class="text-[12px] text-green-300">✓ Valid level — ready to save.</p>`;
    }
    const items = errors.map((e) => `<li>${esc(e)}</li>`).join('');
    return `<ul class="list-disc pl-5 text-[12px] text-red-300 max-h-28 overflow-auto">${items}</ul>`;
}
export function esc(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const BTN = 'font-display tracking-wider px-6 py-3 rounded-lg border-b-4 transition active:translate-y-0.5 active:border-b-0 cursor-pointer select-none';
const BTN_RED = `${BTN} bg-red-600 hover:bg-red-500 border-red-900 text-white text-xl`;
const BTN_BLUE = `${BTN} bg-blue-600 hover:bg-blue-500 border-blue-900 text-white`;
const BTN_GREEN = `${BTN} bg-green-600 hover:bg-green-500 border-green-900 text-white`;
const BTN_YELLOW = `${BTN} bg-yellow-500 hover:bg-yellow-400 border-yellow-700 text-black`;
const BTN_GHOST = `${BTN} bg-neutral-800 hover:bg-neutral-700 border-neutral-950 text-neutral-200 text-sm`;
const INPUT = 'w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 text-white text-sm outline-none focus:border-yellow-400';
const PANEL = 'bg-neutral-900/90 border-2 border-neutral-700 rounded-2xl p-6 shadow-[0_0_60px_rgba(0,0,0,0.8)]';
function title(html) {
    return `<h1 class="font-display text-4xl md:text-5xl text-center leading-tight mb-1">
    <span class="text-yellow-300 text-stroke">STICK FIGHT:</span>
    <span class="text-red-500 text-stroke">LAN CLONE</span></h1>
    ${html ? `<p class="text-center text-neutral-400 text-sm mb-4">${html}</p>` : ''}`;
}
function stepperHTML(id, label, min, max, value) {
    return `<div class="flex items-center justify-between gap-3">
    <span class="text-sm text-neutral-300">${label}</span>
    <div class="flex items-center gap-2">
      <button data-step="${id}|-1" class="w-8 h-8 rounded bg-neutral-700 hover:bg-neutral-600 font-bold">−</button>
      <span id="step-${id}" class="w-8 text-center font-display text-xl text-yellow-300">${value}</span>
      <button data-step="${id}|1" class="w-8 h-8 rounded bg-neutral-700 hover:bg-neutral-600 font-bold">+</button>
    </div></div>`;
}
function wireSteppers(root, state, min, max) {
    root.querySelectorAll('[data-step]').forEach((b) => {
        b.onclick = () => {
            const d = Number(b.dataset.step.split('|')[1]);
            state.humans = Math.min(max, Math.max(min, state.humans + d));
            const el = root.querySelector('#step-humans');
            if (el)
                el.textContent = String(state.humans);
        };
    });
}
function botToggleHTML(on) {
    return `<div class="flex items-center justify-between gap-3">
    <span class="text-sm text-neutral-300">Add bots</span>
    <button id="bot-toggle" class="px-4 py-1.5 rounded-md font-bold text-sm border ${on ? 'bg-green-600 border-green-800' : 'bg-neutral-700 border-neutral-900'}">${on ? 'ON' : 'OFF'}</button></div>`;
}
function wireBotToggle(root, state) {
    const b = root.querySelector('#bot-toggle');
    if (!b)
        return;
    b.onclick = () => {
        state.bots = !state.bots;
        b.textContent = state.bots ? 'ON' : 'OFF';
        b.className = `px-4 py-1.5 rounded-md font-bold text-sm border ${state.bots ? 'bg-green-600 border-green-800' : 'bg-neutral-700 border-neutral-900'}`;
    };
}
function winsHTML(cur) {
    const btns = WINS_OPTIONS.map((v) => `<button data-wins="${v}" class="px-3 py-1.5 rounded-md font-bold text-sm border ${v === cur ? 'bg-yellow-500 border-yellow-700 text-black' : 'bg-neutral-700 border-neutral-900 text-neutral-200'}">${v}</button>`).join('');
    return `<div class="flex items-center justify-between gap-3">
    <span class="text-sm text-neutral-300">Round wins to take match</span>
    <div class="flex items-center gap-1.5">${btns}</div></div>`;
}
function wireWins(root, state) {
    const paint = () => {
        root.querySelectorAll('[data-wins]').forEach((x) => {
            const on = Number(x.dataset.wins) === state.wins;
            x.className = `px-3 py-1.5 rounded-md font-bold text-sm border ${on ? 'bg-yellow-500 border-yellow-700 text-black' : 'bg-neutral-700 border-neutral-900 text-neutral-200'}`;
        });
        const note = root.querySelector('[data-wins-note]');
        if (note)
            note.textContent = `first to ${state.wins} wins takes the match`;
    };
    root.querySelectorAll('[data-wins]').forEach((b) => {
        b.onclick = () => {
            state.wins = Number(b.dataset.wins);
            setWinsTarget(state.wins);
            paint();
        };
    });
}
const CONTROLS = [
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
function footerHTML() {
    let host = '';
    try {
        host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : '';
    }
    catch {
        host = '';
    }
    const ipHint = host ? ` · LAN: friends join <span class="font-mono text-green-300">ws://${esc(host)}:8080</span>` : '';
    return `<p class="text-center text-[11px] text-neutral-500 mt-4">clone for LAN parties · <span data-wins-note>first to ${getWinsTarget()} wins takes the match</span>${ipHint}</p>
    <p class="text-center text-[11px] text-neutral-600 mt-1">press <span class="font-mono text-neutral-400">H</span> in-game to toggle this help</p>`;
}
function lobbyCountText(players) {
    const humans = players.filter((p) => !p.bot);
    const ready = humans.filter((p) => p.ready).length;
    return `${players.length}/4 players · ${ready}/${humans.length} ready`;
}
function lobbyChipsHTML(players) {
    return players
        .map((p) => {
        const badge = p.bot
            ? `<span class="ml-auto text-[11px] px-2 py-0.5 rounded bg-purple-700 text-purple-100">BOT</span>`
            : p.ready
                ? `<span class="ml-auto text-[11px] px-2 py-0.5 rounded bg-green-700 text-green-100">READY ✓</span>`
                : `<span class="ml-auto text-[11px] px-2 py-0.5 rounded bg-neutral-700 text-neutral-300">WAITING</span>`;
        return `<div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700">
        <span class="w-4 h-4 rounded-full shrink-0" style="background:${p.color}"></span>
        <span class="font-bold text-sm">${esc(p.name)}</span>${badge}</div>`;
    })
        .join('');
}
export class Ui {
    constructor(root) {
        Object.defineProperty(this, "root", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "screen", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "toasts", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "hudRaf", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        this.root = root;
        this.root.innerHTML = `<div data-screen class="absolute inset-0 overflow-auto"></div>
      <div data-toasts class="absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none z-50"></div>`;
        this.screen = this.root.querySelector('[data-screen]');
        this.toasts = this.root.querySelector('[data-toasts]');
    }
    clear() {
        cancelAnimationFrame(this.hudRaf);
        this.hudRaf = 0;
        this.screen.innerHTML = '';
    }
    toast(msg) {
        const d = document.createElement('div');
        d.className =
            'toast-in px-4 py-2 rounded-lg bg-black/85 border border-yellow-400/60 text-sm text-yellow-100 whitespace-nowrap';
        d.textContent = msg;
        this.toasts.appendChild(d);
        while (this.toasts.children.length > 3)
            this.toasts.firstChild?.remove();
        setTimeout(() => d.remove(), 2600);
    }
    shell(inner, wide = false) {
        this.clear();
        this.screen.innerHTML = `<div class="min-h-full flex items-center justify-center p-4 bg-[radial-gradient(ellipse_at_center,rgba(60,0,0,0.55),transparent_70%)]">
      <div class="${PANEL} ${wide ? 'w-[560px]' : 'w-[440px]'}">${inner}</div></div>`;
    }
    showMenu(cb) {
        const state = { humans: 2, bots: true, wins: getWinsTarget() };
        let customNote = '';
        try {
            if (loadCustom()) {
                customNote = `<p class="text-center text-[12px] text-green-300 mb-1">custom map saved — EDITOR → SAVE &amp; PLAY to fight on it</p>`;
            }
        }
        catch {
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
        wireBotToggle(this.screen, state);
        wireWins(this.screen, state);
        const q = (s) => this.screen.querySelector(s);
        q('#m-local').onclick = () => cb.onLocal(state.humans, state.bots);
        q('#m-host').onclick = () => cb.onHost();
        q('#m-join').onclick = () => cb.onJoin();
        q('#m-how').onclick = () => cb.onHow();
        q('#m-editor').onclick = () => cb.onEditor();
    }
    showSetup(titleText, cb, opts = {}) {
        const state = { humans: 2, bots: true };
        this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-4">${esc(titleText)}</h2>
      <div class="flex flex-col gap-3">
        <label class="text-sm text-neutral-300">Fighter name
          <input id="s-name" class="${INPUT} mt-1" maxlength="12" placeholder="PLAYER1" value="PLAYER1" />
        </label>
        ${opts.ip
            ? `<label class="text-sm text-neutral-300">Host address
                 <input id="s-ip" class="${INPUT} mt-1 font-mono" placeholder="ws://${lanHint()}:8080" />
                 <span class="block text-[11px] text-neutral-500 mt-1">examples: <span class="font-mono text-neutral-300">ws://192.168.1.10:8080</span> · <span class="font-mono text-neutral-300">192.168.1.10:8080</span> · <span class="font-mono text-neutral-300">192.168.1.10</span> (port 8080)</span>
                 <span id="s-ip-err" class="hidden block text-[12px] text-red-400 mt-1"></span>
               </label>
                <div class="flex items-center gap-2">
                  <button id="s-check" class="px-3 py-1.5 rounded-md bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-xs font-bold border border-neutral-900 cursor-pointer">CHECK PLAYERS</button>
                  <span id="s-count" class="text-[12px] text-neutral-400"></span>
                </div>`
            : ''}
        ${!opts.ip && !opts.local
            ? `<div class="rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-[12px] text-neutral-300">
                 Friends join at <span class="font-mono text-green-300">ws://${esc(lanHint())}:8080</span><br />
                 <span class="text-neutral-400">On the host PC first run <span class="font-mono text-green-300">npm run host</span>, then press START below.</span>
               </div>
               <div class="rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-[12px] text-neutral-300">
                 <span class="font-bold text-neutral-200">Custom map (optional)</span><br />
                 <span class="text-neutral-400">Pick an editor JSON file to validate it here, then start the server with
                 <span class="font-mono text-green-300">npm run host -- --level-file &lt;file&gt;</span>.
                 Joining players receive the map automatically. (The browser cannot inject a file
                 into the server process — the CLI flag is required.)</span>
                 <input id="s-custom-file" type="file" accept=".json,application/json"
                   class="mt-2 block w-full text-[12px] text-neutral-400 file:mr-2 file:px-3 file:py-1 file:rounded file:border file:border-neutral-900 file:bg-neutral-700 file:text-neutral-100" />
                 <span id="s-custom-status" class="block mt-1 text-neutral-500"></span>
                </div>
                <div class="rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-[12px] text-neutral-300">
                  <span class="font-bold text-neutral-200">Lobby chat commands</span><br />
                  <span class="text-neutral-400">Players: <span class="font-mono text-green-300">/ready</span> · <span class="font-mono text-green-300">/unready</span> — auto-starts when all 2+ are ready (else 3s timer).</span><br />
                  <span class="text-neutral-400">Host (first player): <span class="font-mono text-green-300">/start</span> force-start · <span class="font-mono text-green-300">/restart</span> reset scores + round 1 · <span class="font-mono text-green-300">/kick &lt;name&gt;</span> · <span class="font-mono text-green-300">/bots &lt;n&gt;</span></span>
                </div>`
            : ''}
        ${opts.local
            ? `${stepperHTML('humans', 'Humans', 1, 4, state.humans)}${botToggleHTML(state.bots)}`
            : ''}
        <button id="s-go" class="${BTN_YELLOW} mt-1">${esc(opts.startLabel ?? 'START')}</button>
        <button id="s-back" class="${BTN_GHOST}">BACK</button>
      </div>`);
        wireSteppers(this.screen, state, 1, 4);
        wireBotToggle(this.screen, state);
        const name = this.screen.querySelector('#s-name');
        const ip = this.screen.querySelector('#s-ip');
        const ipErr = this.screen.querySelector('#s-ip-err');
        name?.select();
        // Host-only custom-map picker: validates a level JSON file locally and
        // stages it for copy-paste. The browser cannot feed it to the node server
        // process — the host must pass it via --level-file (see instructions).
        const customFile = this.screen.querySelector('#s-custom-file');
        const customStatus = this.screen.querySelector('#s-custom-status');
        if (customFile && customStatus) {
            try {
                const stagedName = localStorage.getItem('sf_host_custom_name');
                if (stagedName && localStorage.getItem('sf_host_custom')) {
                    customStatus.textContent = `custom map ready — start server with --level-file ${stagedName}`;
                    customStatus.className = 'block mt-1 text-green-300';
                }
            }
            catch {
                /* storage unavailable — ignore */
            }
            customFile.addEventListener('change', () => {
                const f = customFile.files?.[0];
                if (!f)
                    return;
                void f.text().then((text) => {
                    try {
                        importLevel(text); // full editor validation
                        try {
                            localStorage.setItem('sf_host_custom', text);
                            localStorage.setItem('sf_host_custom_name', f.name);
                        }
                        catch {
                            /* storage unavailable — validation result still shown */
                        }
                        customStatus.textContent = `custom map ready — start server with --level-file ${f.name}`;
                        customStatus.className = 'block mt-1 text-green-300';
                        this.toast('Custom map validated — pass it to the server via --level-file');
                    }
                    catch (err) {
                        customStatus.textContent = err instanceof Error ? err.message.split('\n')[0] : String(err);
                        customStatus.className = 'block mt-1 text-red-300';
                    }
                });
            });
        }
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
        this.screen.querySelector('#s-go').onclick = go;
        this.screen.querySelector('#s-back').onclick = () => cb({ name: '', ip: '', humans: state.humans, bots: state.bots, back: true });
    }
    showLobby(info, cb) {
        this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-1">${esc(info.title)}</h2>
      ${info.addr
            ? `<p class="text-center text-sm text-neutral-300 mb-1">Server: <span class="font-mono text-green-300">${esc(info.addr)}</span></p>`
            : `<div class="mb-1"></div>`}
      <p id="lobby-count" class="text-center text-[12px] text-neutral-400 mb-2">${esc(lobbyCountText(info.players))}</p>
      <div id="lobby-players" class="flex flex-col gap-2 mb-4">${lobbyChipsHTML(info.players)}</div>
      ${info.hint
            ? `<p class="text-center text-[11px] text-neutral-500 mb-3">${esc(info.hint)}</p>`
            : ''}
      <div class="grid grid-cols-2 gap-2.5">
        <button id="l-start" class="${BTN_GREEN}">FIGHT!</button>
        <button id="l-leave" class="${BTN_GHOST}">LEAVE</button>
      </div>`);
        this.screen.querySelector('#l-start').onclick = () => cb.onStart();
        this.screen.querySelector('#l-leave').onclick = () => cb.onLeave();
    }
    /**
     * Live-update lobby chips + player count (e.g. from NetClient onRoster)
     * without rebuilding the buttons, so handlers stay wired. No-op when no
     * lobby is shown.
     */
    updateLobby(players) {
        const chips = this.screen.querySelector('#lobby-players');
        if (chips)
            chips.innerHTML = lobbyChipsHTML(players);
        const count = this.screen.querySelector('#lobby-count');
        if (count)
            count.textContent = lobbyCountText(players);
    }
    /** Update the join-setup `#s-count` status line. No-op when not shown. */
    setSetupCount(text, ok) {
        const el = this.screen.querySelector('#s-count');
        if (el) {
            el.textContent = text;
            el.className = `text-[12px] ${ok ? 'text-green-300' : 'text-neutral-400'}`;
        }
    }
    showHow(cb) {
        const rows = CONTROLS.map(([k, v]) => `<tr class="border-b border-neutral-800 last:border-0">
        <td class="py-1.5 pr-3 font-mono text-xs text-yellow-200 whitespace-nowrap">${esc(k)}</td>
        <td class="py-1.5 text-sm text-neutral-300">${esc(v)}</td></tr>`).join('');
        this.shell(`${title('')}
      <table class="w-full mb-4"><tbody>${rows}</tbody></table>
      <p class="text-[12px] text-neutral-400 mb-4">Grab falling weapons, knock your friends off the stage, and don't stand in lava. First to ${getWinsTarget()} round wins takes the match.</p>
      <button id="h-back" class="${BTN_YELLOW} w-full">BACK</button>
      ${footerHTML()}`, true);
        this.screen.querySelector('#h-back').onclick = () => cb.onBack();
    }
    /** Minimal level editor: JSON textarea + Validate / Save&Play / Clear + tips. */
    showEditor(initial, cb) {
        this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-1">LEVEL EDITOR</h2>
      <p class="text-center text-neutral-400 text-sm mb-3">paste or edit level JSON, validate, then save &amp; play</p>
      <textarea id="ed-json" spellcheck="false" class="${INPUT} font-mono !text-[11px] leading-relaxed h-56 resize-y">${esc(initial)}</textarea>
      <div id="ed-errors" class="mt-2 min-h-6"></div>
      <div class="grid grid-cols-3 gap-2.5 mt-2">
        <button id="ed-validate" class="${BTN_BLUE} !px-2">VALIDATE</button>
        <button id="ed-save" class="${BTN_YELLOW} !px-2">SAVE &amp; PLAY</button>
        <button id="ed-clear" class="${BTN_GHOST} !px-2">CLEAR</button>
      </div>
      <button id="ed-back" class="${BTN_GHOST} w-full mt-2.5">BACK</button>
      <p class="text-[11px] text-neutral-400 whitespace-pre-line mt-3">${EDITOR_TIPS}</p>`, true);
        const area = this.screen.querySelector('#ed-json');
        const errBox = this.screen.querySelector('#ed-errors');
        const showErrors = (errors) => {
            if (errBox)
                errBox.innerHTML = editorErrorsHTML(errors);
        };
        const currentText = () => area?.value ?? '';
        this.screen.querySelector('#ed-validate').onclick = () => {
            try {
                importLevel(currentText());
                showErrors([]);
                this.toast('Level is valid');
            }
            catch (err) {
                showErrors(err instanceof Error ? err.message.replace(/^Invalid level:\n/, '').split('\n- ') : [String(err)]);
            }
        };
        this.screen.querySelector('#ed-save').onclick = () => {
            try {
                const level = importLevel(currentText());
                saveCustom(level);
                showErrors([]);
                this.toast('Custom level saved — good luck!');
                cb.onSave(level);
            }
            catch (err) {
                showErrors(err instanceof Error ? err.message.replace(/^Invalid level:\n/, '').split('\n- ') : [String(err)]);
                this.toast('Fix the errors before saving');
            }
        };
        this.screen.querySelector('#ed-clear').onclick = () => {
            clearCustom();
            if (area)
                area.value = exportLevel(blankLevel());
            showErrors([]);
            this.toast('Editor reset to a blank level');
        };
        this.screen.querySelector('#ed-back').onclick = () => cb.onBack();
    }
    /** Pause menu overlay with resume / restart / quit. */
    showPause(cb) {
        this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-1">PAUSED</h2>
      <p class="text-center text-neutral-400 text-sm mb-4">take a breath — first to ${getWinsTarget()} takes the match</p>
      <div class="flex flex-col gap-2.5">
        <button id="p-resume" class="${BTN_GREEN}">RESUME (Esc)</button>
        <button id="p-restart" class="${BTN_YELLOW}">RESTART (R)</button>
        <button id="p-quit" class="${BTN_RED}">QUIT TO MENU (Q)</button>
      </div>
      ${footerHTML()}`);
        this.screen.querySelector('#p-resume').onclick = () => cb.onResume();
        this.screen.querySelector('#p-restart').onclick = () => cb.onRestart();
        this.screen.querySelector('#p-quit').onclick = () => cb.onQuit();
    }
    /** Match-win banner: first-to-5 with REMATCH + MENU buttons. */
    showWin(winner, wins, target, cb) {
        this.shell(`<h2 class="font-display text-3xl text-center text-yellow-300 text-stroke mb-1">🏆 ${esc(winner)} WINS!</h2>
      <p class="text-center text-neutral-300 text-sm mb-4">final score ${wins} — first to ${target} takes the match</p>
      <div class="grid grid-cols-2 gap-2.5">
        <button id="w-rematch" class="${BTN_YELLOW}">REMATCH (R)</button>
        <button id="w-menu" class="${BTN_GHOST}">MENU (Q)</button>
      </div>
      ${footerHTML()}`);
        this.screen.querySelector('#w-rematch').onclick = () => cb.onRematch();
        this.screen.querySelector('#w-menu').onclick = () => cb.onMenu();
    }
    showHud(getter) {
        this.clear();
        const hud = document.createElement('div');
        hud.className = 'absolute inset-0 pointer-events-none';
        this.screen.appendChild(hud);
        const tick = () => {
            try {
                renderHud(hud, getter());
            }
            catch {
                /* mode torn down */
            }
            this.hudRaf = requestAnimationFrame(tick);
        };
        tick();
        return () => cancelAnimationFrame(this.hudRaf);
    }
}
