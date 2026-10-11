# Stick Fight

A Stick Fight: The Game clone for LAN parties — TypeScript + Canvas + Tailwind,
with local sofa multiplayer and online LAN multiplayer (authoritative server).

## How to run

```sh
npm.cmd install
npm run dev      # open http://localhost:5173
```

Typecheck / production build:

```sh
npm run typecheck
npm run build
```

## LAN multiplayer (rooms)

One command runs the room server — web UI + game server on port 8080
(rebuilds the client first so friends always get the latest UI).
It can run on ANY machine on the LAN, not necessarily the host's:

```sh
npm run host          # open http://<server-ip>:8080 in a browser
```

Anyone can then host a match from their own browser:

1. Click **HOST** → pick a name, arena, wins, bots (optional custom map
   upload) → **CREATE ROOM**. You get a short 4-letter room code.
2. Friends click **JOIN** → enter a fighter name + the 4-letter room code →
   **JOIN ROOM**. No server address needed — the client finds the LAN
   room server(s) itself, then joins with the code.

Everyone must be on the same network (same Wi-Fi / SSID — the server's LAN
IP changes with DHCP, so the client re-discovers it fresh every time;
nothing is remembered). Each room is an independent match
(max 4 fighters). The room host can **DELETE ROOM** (everyone is kicked
out); if the host quits/disconnects the room is auto-deleted.

Advanced fallback: the JOIN screen has a collapsed "manual server address"
field (`ws://<server-ip>:8080`) for networks where auto-discovery is
blocked (e.g. the page was opened over `https://`, or AP isolation blocks
the scan).

Fast restart without rebuilding the client:

```sh
npm run host:quick   # serve dist/ + WS as-is
npm run host:ws-only # WS game server only, no web UI (old behavior)
```

Match config: the create-room screen has a round-wins picker (3 / 5 / 10,
default 5) plus arena + bots. First to the target takes the match. Every
5th round is a boss round. A custom editor JSON uploaded while creating a
room is sent to the server with the room — joiners receive it automatically.

### Host flags

```sh
npm run host -- --port 8080 --level woods1 --wins 5 --bots 1
```

| Flag           | Default  | Description                                                                                               |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `--port`       | `8080`   | Port serving the web UI + WS game server                                                                  |
| `--level`      | `woods1` | Default starting arena for new rooms                                                                      |
| `--wins`       | `5`      | Default round wins needed to take the match                                                               |
| `--bots`       | `0`      | Default prefilled bot fighters (clamped to max 4 total; `Match` still tops up to a minimum of 2 fighters) |
| `--no-static`  | off      | Serve the WS game server only (no web UI)                                                                 |
| `--static-dir` | `dist`   | Directory to serve the web UI from                                                                        |

`--flag value` and `--flag=value` forms both work. `--level` / `--wins` /
`--bots` are only room _defaults_ — the creating client can override them
per room. Extra bots are trimmed as humans join so humans + bots never
exceed 4 fighters.

### Docker LAN host

The image builds the web client and serves it together with the room
server on `:8080` — one port for everything.

```sh
npm run docker:build
npm run docker:host
# or: docker compose up
```

Friends open `http://<server-ip>:8080`, then HOST creates a room and
shares the code, or JOIN with just the code (auto-discovery finds the
server; manual address is an advanced fallback).

Firewall note: allow inbound TCP on `8080` (web UI + game server) on the
server machine — Windows Defender Firewall (and any third-party firewall)
must allow it for the current network profile.

### Troubleshooting

- **Port in use** (`EADDRINUSE` on 8080): another server is already running —
  stop it, or pick a free port: `npm run host -- --port 8081` (compose maps
  `8080:8080`, so adjust the mapping for Docker).
- **Friends can't connect**: confirm everyone is on the same network
  (same Wi-Fi / SSID, no guest isolation or client-AP isolation on the
  router), and the firewall rules above are in place. `ping <server-ip>` is
  a quick check. JOIN auto-discovers `http://<server-ip>:8080` — no address
  typing needed; use the manual address only if the scan reports no server.
- **Room not found (bad code)**: the code is 4 letters, case-insensitive —
  re-check it with the host. If the host quit, the room was auto-deleted
  and a new one must be created. With several servers up, the client tries
  each one until a server accepts the code.

## Controls

| Input       | Action                 |
| ----------- | ---------------------- |
| A / D       | Move (P2: ← / →)       |
| W           | Jump (P2: ↑)           |
| S           | Fall through platform  |
| Mouse       | Aim (P1)               |
| Left click  | Fire weapon            |
| Right click | Block (reduces damage) |
| F           | Throw weapon           |
| H           | Toggle help overlay    |
| R           | Restart match          |
| Esc         | Pause                  |
| Q           | Quit to menu           |

P2 uses auto-aim at the nearest enemy. Extra local humans beyond 2 become bots.

## Level editor

Click **LEVEL EDITOR** on the menu to paste or edit level JSON, then
**VALIDATE**, **SAVE & PLAY**, or **CLEAR** (resets to a blank level).

- All coordinates are normalized `0..1` (`x`: 0 = left, 1 = right;
  `y`: 0 = top, 1 = bottom). Boxes (`platforms`, `movers`, `crates`,
  `killRects`) need `x/y/w/h` with `x+w ≤ 1` and `y+h ≤ 1`.
- `spawns` must be exactly 4 `[x, y]` points inside the arena — keep them
  out of solids and hazards. `weaponDrops` needs at least 1 point; drops
  fall from the sky and land on platforms.
- **SAVE & PLAY** stores the map in `localStorage` (`sf_custom`) and starts
  a local match (2 humans + bots) with your map first in the rotation —
  the banner shows `CUSTOM — ROUND n`.
- Share maps by copy-pasting the JSON (the editor opens with your last
  saved map, or a blank starter when none is saved).

## Features

- Local multiplayer (1–4 fighters, keyboard + bots) with 12 rotating arenas:
  Woods 1, Box Fort, Factory Lifts (conveyor + movers), Windmill (rotator),
  Ice Spikes (ice + spikes), Lava Pit, Laser Grid (gated lasers),
  Barrel Showdown, Ghost House (bouncy + blink), Chain Hold (blink chains +
  spike-ball pendulum), Rooftop (side lifts + drop-catching roof), Chandelier
  (crate stack + barrels + side perches) — with crates, barrels,
  movers/rotators and lava/spike/laser kills
- 20 weapons: fists, pistol, revolver, Desert Eagle, uzi, AK-47, M16, sniper
  (beam), shotgun, sawed-off, bouncer (bouncing shots), minigun (jetpack
  recoil), grenade (arc + explosion), RPG (rocket + big explosion),
  flamethrower (burn), sword / spear (melee arcs), laser (beam), snake /
  snakeshot (homing) — falling drops, weapon throwing (55 dmg, re-pickup
  reloads), punch-boost, recoil-fly, block (−65% damage)
- Boss round every 5th round
- Match config on the menu: local humans stepper, bots toggle, round-wins
  target (3 / 5 / 10, persisted) with a live arena-count preview
- Arcade HUD: win stars, alive dots, ammo, killfeed, round banners
- Online LAN rooms: authoritative 60 Hz room server, client prediction +
  snapshots, create/join-by-code lobby flow, host delete + host-quit
  auto-delete, ping display
- Keyboard bots with seek / aim / jump / block behavior
- Minimal level editor (menu → LEVEL EDITOR): JSON validate / save / clear,
  custom map plays first in the local rotation, shareable via copy-paste

## Roadmap

- Online: player skins, rematch voting, reconnection
- Sound effects + music, screen-shake tuning, particle polish
- Mobile / touch controls
- Docker image for one-command LAN hosting (see Docker LAN host section)
- More weapons, boss variety, and level hazards
