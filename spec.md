# Relic Run — specification

Relic Run is a branching runner through lush ancient ruins reclaimed by vegetation. The runner moves
forward on its own along a three-lane stone causeway: the player changes lanes to gather relic fragments,
turns at forks (left: the safe route; right: the risk route where fragments count double), jumps the gaps
and slides under the vine barriers. It is a StarHermit engine **script game** (engine 1.22.0, host API
1.21, `engine.minor=20`), played natively by the StarHermit client and in browsers by the engine's web
runtime from one package.

## Files

| Path | What it is |
| --- | --- |
| `starhermit.txt` | Manifest: entry `native/main.ts`, capabilities `platform,storage,clipboard`, `server=score-script.js`, the actions and their key and pad defaults. |
| `native/main.ts` | Game flow, the fixed-step run, commands and invalid-move toasts, hints, Practice undo, progression, achievements, score posting, lifecycle. |
| `native/screens.ts` | Status bar, rails, every menu screen, the HUD, tray, hazard mirror, countdown and toasts on `starhermit:ui`. |
| `native/render.ts` | The ruins on `starhermit:scene`. |
| `native/quality.ts` | The look per graphics tier and level. |
| `native/audio.ts` | Sound effects and the rendered wind bed and music loop on `starhermit:audio`. |
| `native/platform.ts` | Save, game options, legacy migration, the player, the clock, score posting, the board. |
| `native/i18n.ts`, `native/style.ts`, `native/game.ts` | Strings, the UI style sheet, typed facade over the rules. |
| `src/rules.js`, `src/session.js`, `src/content.js` | Rules, session (command ids, hashes, snapshots), content registry and validator — pure ES modules, unchanged from the browser build. |
| `src/progress.js` | The stored progress: normalize, merge, achievements, the browser build's cloud slot and settings keys. |
| `src/strings.js`, `src/platform-i18n.js` | Translations (nine locales). |
| `assets/textures/*.png` | Stone tile, block and moss textures baked from the browser build's canvas painters (`npm run bake`). |
| `tools/ui-style.css` → `assets/ui-style.json` | The style sheet, converted with `npm run css`. |
| `sfx/*.opus` | The authored one-shots (`sfx/manifest.md`). |
| `score-script.js` | The platform script that range-checks a posted score for the `high-score` board. |
| `index.html`, `starhermit-files.json` | The web loader and file index from `npm run package` (never edited by hand). |

## Rules

- The course is an array of cells (24 units each) generated from a seed: gaps, low barriers, relic
  fragments (lane, set 0–2) and forks. The simulation runs at 30 ticks a second; the runner advances
  `speed` units a tick (stage dependent).
- Commands: `left` / `right` change lane (or, inside a fork's decision window — 6 cells before it —
  choose the safe or risk route), `jump` (air for 3 cells), `slide` (under barriers for 3 cells). An
  illegal command is refused with a reason (edge lane, airborne, sliding, a fork needing a choice, a
  mechanic the stage doesn't use) and counts as an invalid.
- Entering a gap on the ground ends the run (`fell`). A barrier hit without sliding costs a heart and
  gives 12 ticks of grace; no hearts left ends it (`crashed`). Reaching the last cell finishes; running
  out of the time limit ends it (`time-up`). Passing a fork without choosing takes the safe route.
- Score: distance (cells), 25 a fragment (risk-route fragments count double: the extra half is the risk
  bonus), 100 a completed set of three of a kind. Results show the breakdown.

## Modes and content

- **Journey**: 40 authored stages in five bands of rising length, speed, hazard rates and forks; stages
  1–4 introduce turn, jump, slide and collect; every 8th is a mastery stage. Finishing a stage unlocks the
  next. Ranked.
- **Learn**: four lessons, one mechanic each (Choosing the Path, Leaping the Gaps, Under the Vines,
  Gathering Fragments); each shows its intro and prompt as a toast.
- **Daily**: one seed per UTC day by the platform's clock (`serverNow()`, the device's when offline);
  the same course for everyone. Ranked.
- **Practice**: Easy, Medium or Hard on a fresh seed; U undoes a few seconds (snapshots every 2 s, six
  kept). Unranked.
- **Challenge**: Frugal Footing (at most 12 moves: further inputs are refused) and Swift Relic (speed 16,
  60 s). Ranked.
- Themes: Emerald Overgrowth, Sunstone Court, Moss Cistern, Rootbound Vault, Dusk Canopy.

## Screens

Every screen is drawn each frame on `starhermit:ui` (`native/screens.ts`) in the browser build's layout:

- **Status bar**: Relic Run, the player's name, the run's label, sync state, online/offline, the UTC
  clock (two lines when it doesn't fit).
- **Rails** (windows 1024 logical px and wider): Objective, Progress, Next up (the hazard text) on the
  left; Actions (Turn / Left, Turn / Right, Jump, Slide, Hint) and Status on the right. The 3D stage sits
  between them (a camera view offset).
- **Menus** over the stage behind a dark wash: title (Play, Daily Challenge, Journey, Learn, Profile, Help,
  Settings, Friends, Invite a friend / Sign in), Choose a mode, the Journey list (scrolling, locks, done
  badges with best scores), Learn, Practice, Challenges, Daily, Paused (with a while-you-were-away line
  after a hidden window), Run complete (headline, breakdown, progress line, leaderboard line,
  achievements, Retry / Next recommended / Back to title), How to play (the effective keys and the rules),
  Settings, Friends & scores (local records and the platform's high-score board), Profile (totals and
  achievements).
- **Run**: HUD (objective; score · fragments · hearts · speed; Pause), the tray (◀ Left, Jump ▲, Slide ▼,
  Right ▶), the "Ahead" hazard mirror, the 3-2-1 countdown and toasts (hints, invalid moves in the
  danger colour). Portrait phones put the stats and Pause above a full-width objective and share the
  width between the tray buttons; short landscape windows use smaller status text and put the tray at
  the end.

## Controls

| Action | Keys | Pad | Touch / pointer |
| --- | --- | --- | --- |
| Left / safe route | ← A | D-pad left, stick left | swipe left, ◀ Left |
| Right / risk route | → D | D-pad right, stick right | swipe right, Right ▶ |
| Jump | ↑ W Space | A, D-pad up, stick up | tap or swipe up, Jump ▲ |
| Slide | ↓ S | B, D-pad down, stick down | swipe down, Slide ▼ |
| Pause / back | Escape | Start | Pause |
| Undo (Practice) | U | X | — |
| Hint | H | Y | Hint (rail) |
| Reset camera | C | right stick press | — |

Swipes and taps count on the stage outside the HUD, tray, mirror and rails (a tap: under 14 px and
0.4 s). Players rebind keys and pads in the runtime's Options. The left-handed layout mirrors the tray.

## Look

`native/render.ts` draws what the browser build's `src/render.js` drew with three.js r185: the theme's sky
colour and exponential fog, the sky dome with horizon haze and sun glow (WGSL), the stone tiles (one a
lane a cell, none over gaps), barriers with vine drapes, spinning relic octahedrons (hidden once
collected), twin fork arrows and orange risk-route strips, crumbling pillars, bushes and trees swaying in
the wind (a vertex hook), fireflies (instanced camera-facing quads with the old GPU motion), and the
runner (body, head; satchel and lantern when detailed) under a warm key light with a hemisphere fill and
a cool rim, followed by the damped chase camera with a shake on barrier hits; behind the menus the camera
glides along the course. Punctual lights are ÷ π (engine light units); the RoomEnvironment is r185's
(renderer room lowered 3.5 m) at environmentIntensity 0.4.

Per graphics tier (`native/quality.ts`, the old presets): Low — Lambert, sparse foliage, plain colours,
MSAA, no shadows or post; Balanced — standard materials, textures, sky dome, room reflections, 1024
shadows, bloom, grade, FXAA, normal foliage, some fireflies, wind; High — clear-coated relics, bump maps,
2048 shadows, GTAO, SMAA, dense foliage, all fireflies; Ultra — 512 px textures, 4096 shadows, full GTAO,
MSAA, 1.5× segments. Fireflies scale with the level within a tier. The colorblind-safe palette turns the
relics bright cyan.

## Audio

The authored one-shots per event (jump, lane change, slide, pickup, set bonus, fork choice, barrier hit,
fall, finish, UI click, invalid move, countdown tick, go) on the effects / interface buses; while a run
plays, a brown-noise wind bed and the pentatonic music loop (rendered once into clips, in slices) on the
music bus. Volumes, mute, haptics and the voice limit are the runtime's Options.

## Platform

- Progress (Journey unlocks and records, achievements, best scores, lessons, totals) is the engine save,
  on the device and in the player's cloud slot; two copies merge (best of each side). The browser
  build's slot (its JSON profile under `game:<slug>`) is read as a foreign save, merged once and replaced.
- Game options (left-handed layout, colorblind-safe palette, timing assistance) are engine settings; the
  browser build's values in the account's settings KV are adopted, then its keys removed.
- Signed in, a finished Journey, Daily or Challenge run posts its total through `score-script.js` (a
  practice session's `result` message) and the results show the rank on the `high-score` board.
  Achievements are local progress, as before.
- Invite a friend copies the invite link; Sign in opens the platform's sign-in.

## Localization and accessibility

All strings in en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT by the runtime's
interface language. High contrast swaps the UI tokens to the old palette; reduced motion stills the
wind, relic spin, idle glide, shake and countdown glow; larger text is the runtime's UI scale. Timing
assistance makes a rules tick last 1.5× as long. Every control is a real widget (keyboard focus, screen
readers, the browser's accessibility mirror); state changes are announced.

## Lifecycle and determinism

The runtime's fixed steps run at 60 Hz; a rules tick takes two steps (three with timing assistance). The
countdown counts 48 steps a number. A command applies at the start of the next step. Pausing, a hidden
window (which pauses the run) and slow frames cost no simulated time; the runner is drawn between ticks.
Cosmetic randomness (decoration, shake) never touches the rules.

## Checks

- `npm run test:unit`: rules, session, content validator (`tests/expect.mjs` maps the old vitest calls
  onto `node:test`), progress and i18n coverage.
- `npm run test:native` (`tests/native.mjs`): web index up to date, `tsc`, `starhermit check .` with no
  warnings, and the render-check play scripts in `tests/native/` — Journey stages 1–2 by keys with the
  rails, two lessons on a portrait phone (DPR 3) by the tray, the Swift Relic challenge on a phone held
  sideways, the menus (Help keys, Settings, Profile, Friends, Daily, a Practice run with a hint, pause and
  results), and today's Daily (planned at test time). Scripts come from `npm run plays`
  (`tools/gen-plays.mjs`): a bot plays the real rules and its commands become key or touch lines on exact
  frames (a key on frame 145 + 2t acts before tick t + 1); each script expects the planned total.
- `npm run test:browser` (`tools/browser-play.mjs`): the package in GPU Chrome at desktop, phone and
  landscape (DPR 3), played to the results with keys, taps and swipes, with no console errors.
- `npm run package` after every change.

## Known limitations

- The stone textures are baked once from the first stage's decoration seed (the old build painted them
  per course; only speckle placement differed).
- The music is one rendered loop from a fixed seed (the old build picked notes per course seed).
- Sheen on the runner's tunic (High/Ultra) is not drawn by the engine; it is a standard surface.
- The old Graphics panel's per-category overrides and FPS readout are the runtime's Options; the old
  "Hold to slide" option never did anything and is gone; haptics is the runtime's vibration option.
- The old dev `server.js` (static hosting, replay-validated local board) is gone; the platform board is
  the only leaderboard. Solo scores keep `score-script.js`'s range check (no server-side replay).
- Signed-in paths (foreign save, legacy settings, score posting) are covered by unit tests, not live.
