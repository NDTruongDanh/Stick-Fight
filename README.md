# Stick Fight: LAN Clone

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

## LAN multiplayer

1. On the host machine, start the game server:
   ```sh
   npm run host          # serves ws://<host-ip>:8080
   ```
2. On the host machine (or any LAN machine), open the web client:
   ```
   http://<host-ip>:5173
   ```
3. Click **HOST** (on the host) or **JOIN** and enter `ws://<host-ip>:8080`
   (JOIN screen: just the IP, e.g. `192.168.1.10`).

Everyone must be on the same network.

Match config: the menu has a round-wins stepper (3 / 5 / 10, default 5,
persisted to `localStorage` key `sf_wins`). First to the target takes the
match. Every 5th round is a boss round.

### Host flags

```sh
npm run host -- --port 8080 --level woods1 --wins 5 --bots 1
```

| Flag      | Default | Description                                    |
| --------- | ------- | ---------------------------------------------- |
| `--port`  | `8080`  | WS port the host server listens on             |
| `--level` | `woods1`| Starting arena id                              |
| `--wins`  | `5`     | Round wins needed to take the match            |
| `--bots`  | `0`     | Prefilled bot fighters (clamped to max 4 total; `Match` still tops up to a minimum of 2 fighters) |

`--flag value` and `--flag=value` forms both work. Extra bots are trimmed
as humans join so humans + bots never exceed 4 fighters.

### Docker LAN host

The image builds the web client and runs the host server on `:8080`.
The client (`dist/`) is served separately.

```sh
npm run docker:build
npm run docker:host
# or: docker compose up
```

Then serve the client on the host machine (or any static host):

```sh
npm run build
npm run preview -- --host   # serves dist/ on :4173, LAN-reachable
```

Friends open `http://<host-ip>:4173` and JOIN `ws://<host-ip>:8080`.

Firewall note: allow inbound TCP on `8080` (game server) and `4173`
(client preview) on the host machine — Windows Defender Firewall (and any
third-party firewall) must allow them for the current network profile.

### Troubleshooting

- **Port in use** (`EADDRINUSE` on 8080): another host is already running —
  stop it, or pick a free port: `npm run host -- --port 8081` (compose maps
  `8080:8080`, so adjust the mapping for Docker).
- **Friends can't connect**: confirm everyone is on the same network
  (same Wi-Fi / SSID, no guest isolation or client-AP isolation on the
  router), the join URL uses the host's LAN IP (not `localhost`), and the
  firewall rules above are in place. `ping <host-ip>` is a quick check.

## Controls

| Input        | Action                    |
| ------------ | ------------------------- |
| A / D        | Move (P2: ← / →)          |
| W            | Jump (P2: ↑)              |
| S            | Fall through platform     |
| Mouse        | Aim (P1)                  |
| Left click   | Fire weapon               |
| Right click  | Block (reduces damage)    |
| F            | Throw weapon              |
| H            | Toggle help overlay       |
| R            | Restart match             |
| Esc          | Pause                     |
| Q            | Quit to menu              |

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
- Online LAN mode: authoritative 60 Hz server, client prediction + snapshots,
  host/join lobby flow, ping display
- Keyboard bots with seek / aim / jump / block behavior
- Minimal level editor (menu → LEVEL EDITOR): JSON validate / save / clear,
  custom map plays first in the local rotation, shareable via copy-paste

## Roadmap

- Online: player skins, rematch voting, chat, reconnection
- Sound effects + music, screen-shake tuning, particle polish
- Mobile / touch controls
- Docker image for one-command LAN hosting (see Docker LAN host section)
- More weapons, boss variety, and level hazards
