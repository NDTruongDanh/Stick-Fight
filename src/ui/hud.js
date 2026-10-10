function esc(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Text weapon icons for the killfeed (emoji + short tag fallback). */
const WEAPON_ICON = {
    fists: '👊', pistol: '🔫', revolver: '🔫', deagle: '🔫', uzi: '🔫',
    ak47: '🔫', m16: '🔫', sniper: '🎯', shotgun: '💥', sawedoff: '💥',
    bouncer: '🔮', minigun: '🔫', grenade: '💣', rpg: '🚀', flamethrower: '🔥',
    sword: '🗡️', spear: '🔱', laser: '🔆', thrown: '🌀', boom: '💥', explosion: '💥',
    burn: '🔥', lava: '🌋', fell: '🕳', spikes: '🦔',
};
function iconFor(cause) {
    const k = String(cause ?? '').toLowerCase();
    return WEAPON_ICON[k] ?? '⚔️';
}
/** Killfeed entries are "KILLER ▸ VICTIM [cause]" or "VICTIM died [cause]"; render cause as icon + tag. */
function feedHTML(f) {
    const m = f.match(/^(.*)▸(.*)\[(.*)\]\s*$/);
    if (!m) {
        const d = f.match(/^(.*) died \[(.*)\]\s*$/);
        if (!d)
            return esc(f);
        const victim = esc(d[1].trim());
        const cause = d[2].trim();
        return `<span class="text-neutral-300 font-bold">${victim}</span> <span class="text-neutral-400">${iconFor(cause)} died</span> <span class="ml-1 px-1 rounded bg-neutral-700 text-xs text-neutral-200">${esc(cause)}</span>`;
    }
    const killer = esc(m[1].trim());
    const victim = esc(m[2].trim());
    const cause = m[3].trim();
    const icon = iconFor(cause);
    return `<span class="text-red-300 font-bold">${killer}</span> <span class="text-neutral-400">${icon} ▸</span> <span class="text-blue-300 font-bold">${victim}</span> <span class="ml-1 px-1 rounded bg-neutral-700 text-xs text-neutral-200">${esc(cause)}</span>`;
}
export function renderHud(el, s) {
    const sig = JSON.stringify(s);
    if (el.dataset.sig === sig)
        return;
    el.dataset.sig = sig;
    const chips = s.players
        .map((p) => `
    <div class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/60 backdrop-blur-sm border ${p.alive ? 'border-white/20' : 'border-red-900 opacity-50'}">
      <span class="w-3.5 h-3.5 rounded-full shrink-0" style="background:${p.color}"></span>
      <span class="text-sm font-bold tracking-wide">${esc(p.name)}</span>
      <span class="text-yellow-300 text-sm leading-none">${'★'.repeat(Math.min(p.wins, 5))}${p.wins > 5 ? `+${p.wins - 5}` : ''}</span>
      <span class="text-sm ${p.alive ? 'text-green-400' : 'text-red-500'}">${p.alive ? '●' : '✕'}</span>
      <span class="text-sm text-neutral-200 ml-1">${esc(p.weapon)} ${p.ammo < 0 ? '∞' : p.ammo}</span>
    </div>`)
        .join('');
    const feed = (s.killfeed ?? [])
        .slice(-4)
        .map((f) => `<div class="px-3 py-1 rounded bg-black/60 backdrop-blur-sm border border-white/10 text-sm text-neutral-200">⚔️ ${feedHTML(f)}</div>`)
        .join('');
    // NOTE: center round/match banner is drawn on Canvas by LocalMode/OnlineMode.
    // HUD keeps only the small top bar (chips + round chip + killfeed) so the
    // two banners never overlap.
    el.innerHTML = `
    <div class="absolute top-0 inset-x-0 flex items-start gap-2 p-2 pointer-events-none">
      <div class="flex flex-wrap gap-2 flex-1">${chips}</div>
      <div class="shrink-0 px-3 py-1.5 rounded-md bg-black/60 backdrop-blur-sm border border-white/20 text-sm font-bold tracking-wider">
        ROUND ${s.round} · ${esc(s.levelName)}${s.ping !== undefined ? ` · <span class="text-green-400">${s.ping}ms</span>` : ''}
      </div>
      <div class="flex flex-col items-end gap-1.5 flex-1">${feed}</div>
    </div>
    <div class="absolute bottom-1 left-0 right-0 text-center text-xs text-white/60 pointer-events-none">
      <span class="px-2 py-0.5 rounded bg-black/40">WASD move · mouse aim · LMB fire · RMB block · F throw · H help · R restart · Esc pause · Q quit</span>
    </div>`;
}
