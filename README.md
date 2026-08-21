# mechameleon-web

**English** | [한국어](README.ko.md)

A web-based hide-and-seek game you can sneak in with coworkers during office hours, inspired by [MECCHA CHAMELEON](https://store.steampowered.com/app/4704690/MECCHA_CHAMELEON/). One player camouflages a white stickman by **painting it with colors picked from a screenshot of any web page** — everyone else scrolls around trying to spot it.

| Hider — paint & hide | Seeker — scroll & find |
| --- | --- |
| ![Hider demo](docs/media/demo-hider.gif) | ![Seeker demo](docs/media/demo-seeker.gif) |

*Full demo videos: [hider](docs/media/demo-hider.webm) · [seeker](docs/media/demo-seeker.webm) — recorded by the automated E2E playthrough.*

## How it works

- The host enters **any URL**; the server captures a full-page screenshot with Playwright (fixed 1440 px width) and uses it as the arena. Buttons on it don't work — it's just pixels, which doubles as your "I'm totally working" screen. Login-walled pages can be replaced by a **direct image upload**.
- **Half the room hides by default** — hiders are drawn randomly (floor(n/2), so with an odd count the seekers outnumber them), and the host can dial the split anywhere from 1 hider to all-but-one with a lobby stepper. Each hider paints their own stickman (60 s) from a spread-out starting spot: move with arrow keys, **drag with the mouse to brush-paint** the white body, picking colors from the background with **Alt(⌥)+click** — the classic eyedropper. Seeking starts the moment every hider locks in (or the timer ends).
- Everyone else **seeks** (120 s): scroll freely and click where a stickman is. A miss locks *you* out for 3 s and shows a subtle ripple **on everyone's screen**. A hit reveals just that hider and the round keeps going — the seekers win when **every hider is found**; if time runs out, the **surviving hiders win**.
- The server is the only judge — clicks are validated server-side against the shared stickman geometry.
- After the result screen, a **10-second countdown** ("대기실로 돌아갑니다") returns everyone to the room lobby automatically — with the **previous map and hider-count setting still in place**, so the host can start a rematch instantly or capture a fresh URL.
- **Leaving is first-class**: every screen has a 나가기 button that returns you to the main lobby without a page reload — nickname kept, socket alive (mid-game it asks for a confirming second tap). A room stays alive down to its last player: if the host walks out, a remaining player is **auto-promoted to host**, and an empty room deletes itself. If a departure makes the round unplayable — fewer than 2 players, no hiders left, or no seekers left — the game **ends for everyone with a message saying why**, and the rest return to the room lobby.

## Quick start

```bash
git clone https://github.com/choiyounggi/mechameleon-web.git
cd mechameleon-web
npm install
npx playwright install chromium   # first run on a new machine — the capture browser
npm run build
PORT=3000 npx tsx server/src/index.ts
```

Then share `http://<your-ip>:3000` with coworkers on the same network. Two players minimum, eight max per room.

## Playing

1. **Lobby** — enter a nickname, then create a room (public, or **private with a password**) or click one in the live room list. Rooms mid-game carry a **"게임 중" badge** and can't be joined until the round ends.
2. The host fetches a background URL (or uploads an image), optionally adjusts the hider count ("숨는 사람 N명" stepper, default half the room), and presses start once 2+ players are in.
3. Hide / seek / result — see the controls below. While the hider paints, seekers watch a themed hold screen (spinner + rotating hints) instead of a blank wait.
4. After each round the whole room auto-returns to the lobby (10 s countdown) with the map preserved — restart right away or swap the map.
5. Leave whenever you like — the room-lobby button exits immediately; during a round the button arms first ("한 번 더 누르면 나가요") so a stray click can't drop you out of a live game.

### Controls (hider)

| Action | Input |
| --- | --- |
| Paint | **Drag** on the background — strokes only stick to the body, like a stencil |
| Eyedropper | **Alt (⌥ Option on Mac) + click** a background pixel |
| Move | Arrow keys (Shift = faster) |
| Resize | `+` / `-` (0.5×–2×) |
| Lock in | **확정** button — seeking starts once every hider has locked in (or the timer expires) |

### Controls (seeker)

Scroll anywhere, click to accuse. Wrong click = 3 s personal lockout + a ripple everyone sees.

## Architecture

- **npm workspaces**: `shared/` (typed Socket.io protocol + stickman geometry/hit-test), `server/` (Express + Socket.io room engine, Playwright capture), `client/` (Vite + vanilla TS, canvas rendering).
- All real-time state flows over **Socket.io broadcasts** scoped to a room; rooms live in server memory only (no DB — a finished round leaves nothing behind).
- Brush strokes travel as stickman-local polylines (bounded by the protocol schema), so paint follows the stickman when it moves or scales, and every client renders the identical body.

## Development

```bash
npm test        # shared + server + client (vitest)
npm run build   # type-check + client bundle
```

The repo also contains scripted Playwright E2E playthroughs (see `e2e-videos/` after running them) — the demo media above comes straight from them.

## Notes & limits

- Single server instance by design (in-memory rooms) — office scale, not internet scale.
- Rematch is built in: every round ends with an automatic 10 s return to the same room's lobby, map preserved.
- The capture endpoint fetches URLs server-side with only an http(s) scheme check — run it on a trusted LAN.
- Fan homage: game concept inspired by MECCHA CHAMELEON. No assets, code, or art were copied; the visual DNA (painted-camouflage mascot, playful per-letter title) was re-created from scratch.
