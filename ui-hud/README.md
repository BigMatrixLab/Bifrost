# Bifrost HUD (experimental UI)

A restyle of the Bifrost interface after the reference HUD board (version 4).
Every page keeps the old app's layout, order of cards, colours and charts.
What changes is the card itself: each one is a glass window from the
reference, with a grey code plate and title (`FN01 ACTIVE TRANSFER`,
`H4 NETWORK`, `R7 RECEIPTS`), hatching, a large readout at the right
(`01-07`, `ONLINE`, `03 / 04`) that turns into the red alert band when
something needs attention, an inset body, a foot line (`WIN FN01` plus the
card's buttons) and corner brackets just outside the glass.

Numbers are larger: the summary strips at the top of each page use the
board's statistic boxes, sized to fill their box. The active transfer ring,
its facts, tile stats and the throughput legend are larger too.

Colours are the old dark theme's: green for running/online/done, amber for
waiting/paused/relayed, red for attention/offline. There is no light theme.

Behaviour is the same as the main app: the store, API calls and actions are
unchanged.

| File | What it is |
| --- | --- |
| `src/glass.tsx` | `Win` (the window card), `Chip`, the red time tag |
| `src/glass.css` | The window look and the large numbers (loaded after `styles.css`) |
| `src/*`, `src/pages/*` | The old app's code; each card is wrapped in a `Win` |
| `archive/v3-src/` | The previous attempt (fixed desk of small windows), for reference only; not built |

Nothing outside this folder is changed. To drop the experiment, delete `ui-hud/`.

| Command | What it does |
| --- | --- |
| `npm run dev:ui` | Browser preview with demo data at http://localhost:5174 |
| `npm run build` | Typecheck and build the frontend to `dist/` |
| `npm run build:exe` | Build `release/Bifrost-HUD.exe` |
| `./shoot.ps1` | Screenshots into `shots/` (needs `dev:ui`); `-Open connect\|browse` for dialogs |

## The exe

`build-exe.ps1` compiles the unchanged Rust shell in `../src-tauri` with
`tauri.hud.conf.json` layered on top, into `ui-hud/target`, so the main app's
`target/` is never touched.

The HUD app uses its own identifier (`app.bifrost.hud-preview`): its own data
folder (`%APPDATA%\app.bifrost.hud-preview`), its own device identity, and it
runs next to the installed Bifrost. To test transfers, pair it with the
installed copy like any second device.
