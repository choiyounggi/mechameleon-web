# mechameleon-web

**English** | [한국어](README.ko.md)

A web-based hide-and-seek game you can sneak in with coworkers during office hours, inspired by [MECCHA CHAMELEON](https://store.steampowered.com/app/4704690/MECCHA_CHAMELEON/). One player camouflages a white stickman by **painting it with colors picked from a screenshot of any web page** — everyone else scrolls around trying to spot it.

| Hider — paint & hide | Seeker — scroll & find |
| --- | --- |
| ![Hider demo](docs/media/demo-hider.gif) | ![Seeker demo](docs/media/demo-seeker.gif) |

*Full demo videos: [hider](docs/media/demo-hider.webm) · [seeker](docs/media/demo-seeker.webm) — recorded by the automated E2E playthrough.*

## How it works

- The host enters **any URL**; the server captures a full-page screenshot with Playwright (fixed 1440 px width) and uses it as the arena. Buttons on it don't work — it's just pixels, which doubles as your "I'm totally working" screen. Login-walled pages can be replaced by a **direct image upload**.
- One player is **randomly chosen as the hider** (60 s): move the stickman with arrow keys, then **drag with the mouse to brush-paint** its white body, picking colors from the background with **Alt(⌥)+click** — the classic eyedropper.
- Everyone else **seeks** (120 s): scroll freely and click where the stickman is. A miss locks *you* out for 3 s and shows a subtle ripple **on everyone's screen**. First hit wins; if time runs out, the hider wins.
- The server is the only judge — clicks are validated server-side against the shared stickman geometry.

## Quick start

```bash
git clone https://github.com/choiyounggi/mechameleon-web.git
cd mechameleon-web
npm install
npm run build
PORT=3000 npx tsx server/src/index.ts
```

Then share `http://<your-ip>:3000` with coworkers on the same network. Two players minimum, eight max per room.

## Playing

1. **Lobby** — enter a nickname, then create a room (public, or **private with a password**) or click one in the live room list.
2. The host fetches a background URL (or uploads an image) and presses start once 2+ players are in.
3. Hide / seek / result — see the controls below.

### Controls (hider)

| Action | Input |
| --- | --- |
| Paint | **Drag** on the background — strokes only stick to the body, like a stencil |
| Eyedropper | **Alt (⌥ Option on Mac) + click** a background pixel |
| Move | Arrow keys (Shift = faster) |
| Resize | `+` / `-` (0.5×–2×) |
| Lock in | **확정** button (or wait for the timer) |

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
- "다시 하기" starts a fresh room; there is no rematch API yet.
- The capture endpoint fetches URLs server-side with only an http(s) scheme check — run it on a trusted LAN.
- Fan homage: game concept inspired by MECCHA CHAMELEON. No assets, code, or art were copied; the visual DNA (painted-camouflage mascot, playful per-letter title) was re-created from scratch.
