# phonetic-atlas

Word- and phoneme-level pronunciation drill tool. You feed it audio + transcript;
it produces a clickable transcript with two parallel IPA layers — what was
actually said (audio-derived) vs. the citation form from a dictionary — both
synced to the audio waveform.

Built on top of **Montreal Forced Aligner (MFA)** for word-level alignment
(with WhisperX as fallback) and a wav2vec2 phoneme model
(`facebook/wav2vec2-lv-60-espeak-cv-ft`) for phoneme timing and IPA
extraction.

## What you get

- Click any word or any phoneme to jump to that exact moment in the audio.
- Loop a single word with adjustable delay and repeat count for drill practice.
- Two IPA layers per word:
  - **Audio**: greedy decoding from the model's logits — captures real
    pronunciation, weak forms, linking, flap T, etc.
  - **Citation**: canonical IPA from `phonemizer` + `espeak-ng` aligned to
    audio via CTC forced alignment.
- Live phoneme highlighting at ~60fps (sub-50ms phonemes still get highlighted).
- Full keyboard shortcuts. Settings persist across reloads.
- IPA simplification toggle (learner-style: `ɹ` → `r`, `ɾ` → `r`, `ᵻ` → `ɪ`, …).

## Quick start

```bash
brew install ffmpeg espeak-ng python@3.12
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Install MFA in a conda env (recommended for accurate alignment)
# If you skip this, the pipeline falls back to whisperx alignment.
curl -sL -o /tmp/mf.sh https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-MacOSX-arm64.sh
bash /tmp/mf.sh -b -p $HOME/miniforge3
$HOME/miniforge3/bin/mamba create -n mfa -c conda-forge montreal-forced-aligner -y
$HOME/miniforge3/envs/mfa/bin/mfa model download acoustic english_mfa
$HOME/miniforge3/envs/mfa/bin/mfa model download dictionary english_us_mfa
```

#### Japanese samples (optional)

Python deps (fugashi, unidic-lite, jaconv, jamdict, jamdict-data) are already in
`requirements.txt`. For accurate Japanese alignment, also install the
`japanese_mfa` models and MeCab/Sudachi tokenizer support in the conda env
(without these, JA samples fall back to whisperX, which tokenizes by character —
see `docs/japanese-pipeline.md`):

```bash
$HOME/miniforge3/envs/mfa/bin/mfa model download acoustic japanese_mfa
$HOME/miniforge3/envs/mfa/bin/mfa model download dictionary japanese_mfa
$HOME/miniforge3/bin/conda install -n mfa -c conda-forge -y spacy sudachipy sudachidict-core
```

Then either:

### Run the web app

The frontend is a Vite + TypeScript app (`src/*.ts`, `src/styles.css`).

```bash
npm install

# Production: build once, then serve via FastAPI
npm run build           # emits dist/
python server.py        # http://127.0.0.1:7842  (serves dist/)

# Development: two processes — Vite dev server proxies /api to FastAPI
python server.py        # backend on :7842
npm run dev             # frontend on http://127.0.0.1:5173 (HMR)
```

`npm run typecheck` runs `tsc --noEmit`; `npm test` runs vitest.

### Docker

Bundles the Vite frontend + FastAPI backend + MFA (conda) into one image
(CPU-only torch). MFA acoustic model and dictionary are baked in at build.

```bash
docker compose up --build      # http://127.0.0.1:7842
```

`./data` (aligned sessions + model cache) and `./samples` are mounted as
volumes, so they survive rebuilds. First build is large and slow (torch,
whisperx, MFA + models).

### Run the CLI scripts directly

```bash
# preprocess a sample into samples/<slug>/words.json
.venv/bin/python scripts/process_samples.py <slug>
```

View the result through the web app (see *Run the web app* above).

## How it works

0. **Token normalization** rewrites tokens whose written form ≠ spoken form
   *for the aligner only*, then collapses the result back so the displayed
   word stays the original whitespace token (see *Acronyms & symbols*).
1. **Montreal Forced Aligner** force-aligns your transcript to the audio at
   the word level (HMM-GMM based; precise on both natural speech and TTS).
   Falls back to WhisperX if MFA isn't installed.
2. **espeak-ng** phonemizes each word (citation form).
3. The phoneme sequence is greedy-tokenised against the wav2vec2 vocab.
4. **`torchaudio.functional.forced_align`** (CTC forced alignment) is run
   *per word*, slicing the wav2vec2 log-probs to the MFA-provided word
   boundaries — this gives accurate timing per canonical phoneme.
5. Inside each word's frame range, the model's argmax is collapsed to produce
   the **audio** phoneme sequence — capturing what was really said, not what
   the dictionary says (weak forms, linking, flap T, etc.).
6. The browser plays the audio and highlights the active word and phoneme on
   each animation frame.

## Acronyms & symbols

MFA places garbage time boundaries on tokens it can't pronounce as written
(`/dev/shm`, `vLLM`, `V1`, `3am`). Spoken aloud these are several syllables
("forward slash dev…", "V L L M", "three A M") but MFA collapses them into one
short window, which cascades misalignment down the line.

Fix: expand such tokens to their **spoken form** before MFA, then collapse the
sub-words back into the original token (one display word, one correct window).
`/`-bearing tokens are expanded automatically; acronyms use a two-layer map:

- **Global** — `acronyms.json` at the repo root. Shared defaults applied to
  every sample (`{"vllm": "v l l m", "nccl": "n c c l", …}`). Path overridable
  via the `ACRONYMS_FILE` env var.
- **Per-sample** — `samples/<name>/acronyms.json` (same JSON format). Merged
  on top of global, **per-sample wins**. Use it for recording-specific
  pronunciations or to override a global entry.

Values are space-separated MFA dictionary tokens (single letters `v l l m`,
number words `one two`). The effective map is part of the session hash, so
editing either layer regenerates that sample on next run. When a new acronym
is mistimed the aligner prints a `WARN short window …` line naming the token —
add it to the appropriate layer.

## Caching & reprocessing

Each run is cached to `data/<sid>/words.json`, where `sid` hashes the audio +
transcript + `ALIGNER_VERSION` + effective acronym map. Cached sessions
**persist across server/container restarts** (`./data` is volume-mounted) and
are *not* recomputed on restart — a cache hit is served directly.

To regenerate after an aligner or acronym change without editing inputs, run
the sample preprocess CLI:

```bash
python3 scripts/process_samples.py sample-slug --force
python3 scripts/process_samples.py --force  # all samples
```

You can manually edit `data/<sid>/words.json` when you need to correct IPA or
timed phonemes for the player. The UI reads that file directly. Treat it as a
cache, not durable source: a later `python3 scripts/process_samples.py <slug>
--force` run overwrites it. If you edit timed phoneme arrays, keep `start` /
`end` values consistent because the player uses them for highlighting.

> **Restart `server.py` after any `aligner.py`/`server.py` change or
> `ALIGNER_VERSION` bump.** The running process holds the old code and the
> old version constant in memory, so it keeps computing the *old* `sid` and
> serving stale caches. The fix lands only once the process is restarted.

## Adding a sample

Samples are auto-discovered: any `samples/<slug>/` dir with an audio file and
`transcript.txt` appears in the picker — no manifest to edit.

> **Japanese samples**: set `"lang": "ja"` in `meta.json`. The pipeline then
> tokenizes with fugashi/UniDic and emits reading, romaji, mora, pitch accent,
> furigana, and JMdict glosses. See `docs/japanese-pipeline.md` (and install the
> `japanese_mfa` MFA model for correct alignment). Reference sample:
> `samples/ja-pm-role/`.

| File | Required | Purpose |
|------|----------|---------|
| `audio.{mp3,wav,m4a,ogg}` | yes | source audio |
| `transcript.txt` | yes | text to align |
| `meta.json` | no | `title`, `description`, `level`, `duration`, `scene` (UI metadata), `lang` (`"en"` default / `"ja"`) |
| `acronyms.json` | no | per-sample acronym → spoken-form overrides (see *Acronyms & symbols*) |
| `enrichment.json` | no | per-lexeme gloss/POS/definition + per-sentence translation (dictionary card) |

`enrichment.json` is keyed by **lexicon key**, which only exists after the
aligner has run — so adding a sample is a two-pass flow:

1. Create the dir with audio + transcript (+ optional `meta.json`,
   `acronyms.json`).
2. Process once to generate the lexicon:
   `python3 scripts/process_samples.py <slug>`. This writes
   `data/<sid>/words.json`.
3. Write `samples/<slug>/enrichment.json` keyed against the lexicon keys in
   that `words.json`: `{"lexemes": {"<key>": {"gloss","pos","definition",
   "definition_gloss","note"}}, "sentences": {"<i>": {"gloss","note"}}}`.
4. Reprocess with `python3 scripts/process_samples.py <slug> --force`; the CLI
   merges `enrichment.json` onto the fresh result. Confirm every
   lexeme/sentence is glossed.
5. Commit `samples/<slug>/` — audio, transcript and the JSON files are all
   tracked; only `data/` is gitignored.

`enrichment.json` is the durable source of truth and re-applies on *every*
process: a later CLI `--force` run (same audio/transcript/`ALIGNER_VERSION`/
acronyms) keeps the dictionary intact. Only a transcript edit or an
`ALIGNER_VERSION` bump shifts lexicon keys and needs an enrichment touch-up.

## Teleprompter Overlay (macOS desktop app)

A small, always-on-top, transparent strip that loops samples for passive
listening + pronunciation drill. Word-synced highlighting, IPA under each
word, A-B / sentence / full-loop modes, keyboard navigation. Ships as a
self-contained `.app` with the FastAPI backend bundled via PyInstaller — no
separate server process needed.

### Build & run

```bash
# prerequisites (one time)
.venv/bin/pip install pyinstaller

# full redeploy: frontend → PyInstaller → Tauri → /Applications
bash scripts/redeploy-overlay.sh

# or manually step by step:
npm run build                              # dist/
.venv/bin/pyinstaller --onefile --name server-bundle \
  --add-data "sample_cache.py:." server.py
mkdir -p desktop/src-tauri/binaries
cp dist/pyinstaller/server-bundle \
  desktop/src-tauri/binaries/server-bundle-aarch64-apple-darwin
cd desktop && npx tauri build --bundles app
open /Applications/phonetic-atlas-overlay.app
```

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` / `→` | Previous / next word |
| `⌘←` / `⌘→` | First / last word |
| `Shift+←` / `Shift+→` | Previous / next sentence |
| `I` | Toggle IPA row |
| `P` | Toggle prosody (stress, pitch) |
| `L` | Cycle loop mode (∞ → sentence → A-B) |
| `[` / `]` | Slower / faster playback |
| `D` | Open dictionary card for current word |
| `J` / `K` (dict open) | Previous / next occurrence in sample |
| `⌘K` | Search samples |
| `Esc` | Close search / dictionary |
| `⇧⌘O` | Collapse / expand overlay |

### Architecture

The overlay is a **Tauri 2** macOS app (`desktop/src-tauri/`). On launch:

1. Rust code spawns `server-bundle` (PyInstaller-packaged `server.py`)
   listening on `127.0.0.1:7842`.
2. The WebView loads `http://127.0.0.1:7842/?view=overlay` which serves
   `dist/index.html` with the `?view=overlay` branch activating the
   overlay component (`src/overlay.ts` + `src/overlay.css`).
3. The overlay fetches sample data via the same backend API (`/api/samples`,
   `/api/words/<id>`, `/api/sample-audio/<id>`).
4. On quit, Rust kills the spawned Python process.

No dock icon, no traffic-light buttons, no focus-steal on launch. The window
floats over fullscreen apps and persists across Space/display changes.

## Project layout

```
.
├── README.md
├── requirements.txt
├── aligner.py                # reusable alignment module (importable)
├── server.py                 # FastAPI static/cache backend
├── index.html                # sample player single-page app
├── acronyms.json             # global acronym → spoken-form map
├── src/
│   ├── overlay.ts            # teleprompter overlay component
│   └── overlay.css           # overlay styles
├── desktop/
│   └── src-tauri/            # Tauri 2 macOS shell
│       ├── src/lib.rs        # Rust: spawn backend, macOS overlay config
│       ├── src/main.rs
│       ├── tauri.conf.json
│       └── binaries/         # PyInstaller server bundle (copied at build)
├── scripts/
│   ├── align_transcript.py   # WhisperX word alignment only
│   ├── process_samples.py    # preprocess samples into samples/<slug>/words.json
│   ├── check_alignment.py    # batch reprocess + misalignment report
│   └── check_phonemes.py     # sanity-check IPA vs. dictionary reference
├── samples/<name>/           # transcript.txt, audio.*, meta.json, optional
│                             #   acronyms.json + enrichment.json (per-sample)
└── examples/                 # (gitignored) drop your audio + transcript here
```

## Known limits

- The alignment is only as good as the wav2vec2 phoneme model. Heavy accents,
  background music, or very fast speech degrade quality.
- Final consonants below the confidence threshold (e.g. tail `/d/`, `/m/` at
  end of utterance) may be dropped from the audio layer.
- English and Japanese are supported (per-sample `lang`); other languages need
  a phoneme model + espeak voice and a tokenizer (see `docs/japanese-pipeline.md`).
- Tokens that aren't in the acronym map and contain digits/symbols MFA can't
  pronounce (bare numbers like `64`/`20Gi`, `CI/CD`) may have an empty or
  mismatched **citation** IPA. The aligner prints a `WARN short window` line
  — add the token to `acronyms.json` (global or per-sample) to fix.

## Author

Thuan Pham — <thuanpham05082002@gmail.com>

## License

MIT.

### Third-party data (Japanese)

Japanese glosses come from **JMdict/EDICT**, the property of the
[Electronic Dictionary Research and Development Group (EDRDG)](https://www.edrdg.org/),
used under the [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
license (bundled via the `jamdict-data` package). Tokenization and readings use
**UniDic** (via `fugashi` + `unidic-lite`). Citation IPA is generated with
**espeak-ng**. No proprietary dictionary data is shipped.
