# Teleprompter Overlay — Goal & Plan

A small, always-on-top, semi-transparent strip that loops phonetic-atlas
samples for **passive listening + reading practice**. Word-synced
highlighting, IPA under the current line, word/sentence navigation, and
A-B / sentence / full-loop modes. macOS desktop app via Tauri; reuses the
existing FastAPI + aligner backend untouched.

Reference mockup: `mockups/overlay.html`.

---

## Primary goal

> A user can launch `phonetic-atlas` as a small floating window on macOS,
> pick a sample, loop it (whole / sentence / A-B), and watch words light
> up in time with audio — with IPA under the current line and full
> word/sentence navigation — while continuing to work in other apps.

**Done when:** the overlay window stays above other apps, never steals
focus on launch, loops audio across full sample / current sentence /
A-B range without drift > 80 ms, exposes word + sentence nav (mouse +
keyboard), and the same TS bundle still renders the existing full
in-browser view at `/`.

---

## Success criteria (verifiable)

Each task below has its own check. Top-level criteria:

1. `cargo tauri dev` opens a 760×~160 px window that floats above Safari
   and Finder, with no dock icon stealing space and no traffic-light
   buttons.
2. Loading `tom-park` sample: words highlight within ±80 ms of audible
   word onset, measured by clicking ten random words and confirming
   `audio.currentTime` lands inside `[w.s, w.e]`.
3. Loop modes:
   - **All:** at `audio.ended` → restart from 0, no audible gap > 250 ms.
   - **Sentence:** when current word index leaves the locked sentence,
     `currentTime` snaps back to the sentence's first word.
   - **A-B:** clicking word A then word B sets `[a, b]`; playback wraps
     between them.
4. Navigation: ← / → step word; Shift+← / → step sentence; Space toggles
   play; clicking any rendered word seeks to it.
5. IPA toggle hides/shows the `ipa` row under current-line words; no
   layout shift on other lines.
6. α slider drags from 0.15 → 1.0 and updates **both** the overlay
   background AND `appWindow.setOpacity()` live.
7. Existing browser view at `http://localhost:8000/` still renders the
   full app unchanged (regression check).

---

## Status

- ✅ Phase 1 complete — `src/overlay.{ts,css}` shipped, `?view=overlay` route in `src/app.ts`, `npm run build` + `npm test` green.
- ✅ Phase 2 complete — `desktop/src-tauri/` scaffolded; cargo build green; binary at `desktop/src-tauri/target/release/phonetic-atlas-overlay` opens a borderless transparent always-on-top window pointing at `http://127.0.0.1:7842/?view=overlay`. Python backend spawned + reaped by the Rust shell (sees `.venv/bin/python`). `set_opacity` / `set_always_on_top` commands exposed; α slider wired to the native opacity bridge. Sample picker persists via WebView `localStorage` (no plugin-store needed).
- ⏳ Phase 3 (post-MVP): click-through, edge-snap, MediaSession, auto-advance, full pyinstaller-bundled `.app`.

## Plan

### Phase 1 — Overlay view inside existing Vite app (no Tauri yet)

Lets the look + the loop/nav UX be validated in a plain browser before
investing in the native shell.

1. **New route + entry**
   - Add `?view=overlay` branch in `src/app.ts` that mounts a separate
     component tree from the existing main app.
   - Extract the mockup's DOM into `src/overlay.ts` + `src/overlay.css`.
   - **Verify:** `npm run dev` → `http://localhost:5173/?view=overlay`
     renders the strip with no main-app chrome around it.

2. **Wire to real player**
   - Replace fake clock with the existing `Player` (`src/player.ts`):
     subscribe to `timeupdate`, read `transcript` + `lexicon` from the
     loaded `words.json`.
   - Render IPA from `lexicon[word_key].ipa_canonical` (fallback to
     `ipa` if canonical missing).
   - **Verify:** load `tom-park`; ten random word-clicks all land
     `t ∈ [w.s, w.e]`.

3. **Loop modes**
   - `mode: "all" | "sentence" | "ab"` in a small state object.
   - `all`: `audio.loop = true`.
   - `sentence`: on each `timeupdate`, if `t` outside
     `[sentence.start, sentence.end]`, `currentTime = sentence.start`.
   - `ab`: same idea with user-picked anchors. Click-to-set: first click
     after pressing the A-B button = A, second = B; third resets.
   - **Verify:** record 30s of each mode, confirm transitions on
     boundaries (no drift > 250 ms across loop seam).

4. **Navigation + keyboard**
   - Implement `stepWord(±1)`, `stepSentence(±1)`, `seekToWord(si, wi)`
     against `Player`.
   - Hotkeys via single `keydown` listener (Space / ←→ / Shift+←→).
   - Click handlers on `.w[data-i]` and `.line` elements.
   - **Verify:** each shortcut + click path produces the expected
     `currentTime` jump (manual smoke).

5. **IPA toggle + α slider + sentence indicator**
   - IPA toggle: class on `.overlay`, hides `.ipa` spans via CSS.
   - α slider: bind to `--bg-alpha` CSS var; expose a callback so phase 2
     can also call `setOpacity`.
   - Sentence counter (`2 / 4`) in the title bar.
   - **Verify:** toggling does not reflow prev/next lines.

**Exit criterion for phase 1:** the overlay view in a browser tab
behaves end-to-end like the mockup, against real audio.

---

### Phase 2 — Tauri shell

Promote the overlay into an always-on-top macOS app. FastAPI + aligner
stay as-is and run as a sidecar.

1. **Scaffold**
   - `bun create tauri-app` (or `cargo create-tauri-app`) inside repo at
     `desktop/`. Frontend dist points to `../dist`.
   - `tauri.conf.json` window:
     `decorations: false, transparent: true, alwaysOnTop: true,
     skipTaskbar: true, resizable: true, width: 760, height: 160,
     fullscreen: false, focus: false`.
   - **Verify:** `cargo tauri dev` opens a borderless transparent window
     pointing at `index.html?view=overlay`.

2. **Python sidecar**
   - Add `tauri.conf.json > tauri.bundle.externalBin` for a packaged
     `uvicorn` launcher script (`server_launcher.py`) that boots
     `server:app` on a free localhost port and prints it on stdout.
   - Tauri Rust side: spawn sidecar via `Command::new_sidecar`, parse
     port, set it on a JS-injected `window.__API_BASE__`.
   - **Verify:** killing the Tauri window also kills the python process
     (`ps aux | grep uvicorn` returns nothing after quit).

3. **Window controls bridge**
   - JS → Rust: `setOpacity(v)`, `setAlwaysOnTop(b)`, `quit()`.
   - α slider calls `setOpacity` in addition to the CSS var.
   - Add a hidden right-click context menu (or hotkey ⌘Q) to quit,
     since no traffic lights.
   - **Verify:** opacity changes the *whole* window (visible by dragging
     it over a bright app like Numbers).

4. **First-run sample picker**
   - Reuse `/api/samples` from FastAPI; render a tiny dropdown in the
     title bar.
   - Persist last-picked sample to `tauri-plugin-store`.
   - **Verify:** quit, relaunch; same sample is preloaded.

**Exit criterion for phase 2:** a `.app` bundle that can be dragged into
`/Applications`, launched, and used for an hour of looping without
crash, focus theft, or zombie python processes.

---

### Phase 3 — Polish (optional, post-MVP)

- Drag-snap to screen edges (Tauri's `onMoved` + `setPosition`).
- Click-through mode (toggle): pointer events pass to the app below,
  useful while reading the prompter without grabbing focus.
- macOS `MediaSession` + lockscreen controls so play/pause works from
  AirPods.
- Per-sample loop count + auto-advance to next sample.
- Compact / expanded heights (1 line vs. 3 lines).

---

## Non-goals (explicit)

- Recording / scoring — the recorder lives in the main app, not the
  overlay.
- Editing transcripts / IPA — view-only.
- Cross-platform. macOS only for v1. Tauri makes Windows/Linux trivial
  later, but it's not validated here.
- New backend endpoints. The overlay consumes the existing
  `/api/process` + static `data/<sid>/words.json` only.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Tauri WebView audio jitter on macOS | Phase 1 first; if drift > 80 ms, fall back to short native AVAudio sidecar via Tauri command. |
| Sidecar python startup time spikes first load | Show "warming…" toast until `/api/health` returns 200; existing server is already fast on warm cache. |
| Transparent + always-on-top + focus theft on launch | `focus: false` in window config + `NSWindow.setCanHide(false)` via tauri Rust shim if needed. |
| MFA model cold-start on a fresh machine | Out of scope — same constraint as today; document in README. |

---

## File touch-map (delivered)

```
src/
  app.ts              # ?view=overlay branch dynamically imports overlay
  overlay.ts          # standalone overlay (samples → words.json → render)
  overlay.css         # extracted from mockup
desktop/
  src-tauri/
    Cargo.toml        # tauri 2 + cocoa
    tauri.conf.json   # borderless transparent always-on-top window
    build.rs
    src/main.rs       # entry → lib::run
    src/lib.rs        # sidecar spawn + reap, set_opacity, all-Spaces float
    server_launcher.py
    capabilities/default.json
    icons/            # placeholder icons (φ on dark)
docs/
  teleprompter-overlay-plan.md
mockups/
  overlay.html        # reference, kept in repo
```

No changes to `server.py` or `aligner.py`.

## Run the desktop overlay

```bash
# build the frontend
npm run build

# one-off: rebuild the desktop binary (≈1 min after the first slow build)
cd desktop/src-tauri && cargo build --release

# run
./target/release/phonetic-atlas-overlay
# Rust process spawns `.venv/bin/python -m uvicorn server:app --port 7842`
# in the repo root and kills it on quit. The WebView loads ?view=overlay.
```

For iterative work, `bun tauri dev` (from `desktop/`) gives hot-reload but
expects an existing dev server on :7842 — for this project that's the FastAPI
server, not Vite, since the overlay loads `dist/` through the FastAPI route.
