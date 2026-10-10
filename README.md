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

## Roadmap

- Online: player skins, rematch voting, chat, reconnection
- Sound effects + music, screen-shake tuning, particle polish
- Mobile / touch controls
- Docker image for one-command LAN hosting
- More weapons, boss variety, and level hazards
