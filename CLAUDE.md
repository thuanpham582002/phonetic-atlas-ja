# CLAUDE.md — phonetic-atlas

Project-specific guidance. See `README.md` for user-facing docs.

## What this is

Audio + transcript → clickable transcript with two parallel IPA layers
(audio-derived vs. citation), synced to the waveform. Backend: FastAPI
(`server.py`) + `aligner.py` (MFA → wav2vec2 → CTC forced align). Frontend:
Vite/TS in `src/*.ts`, built to `dist/`.

## Run / verify

```bash
.venv/bin/python -m py_compile aligner.py server.py   # syntax check
npm run build                                         # type-checks + emits dist/
npm test                                              # vitest
.venv/bin/python scripts/check_alignment.py           # batch reprocess + report
```

- Heavy deps (torch/whisperx/transformers/MFA) live in `.venv` + the conda
  `mfa` env. Always invoke Python as `.venv/bin/python`; pyright will flag
  these imports as unresolved — that is environmental, not a real error.
- `import server` needs the repo root on `sys.path`; run scripts with
  `PYTHONPATH=. .venv/bin/python scripts/…` (the script dir shadows cwd).

## Alignment pipeline invariants

- **Display unit = whitespace token.** Tokens whose spoken form ≠ written
  form are expanded for MFA only (`_normalize_token`) and collapsed back
  (`_collapse_groups`) so one display word keeps one correct time window.
- `_collapse_groups` is **tolerant**: MFA may drop unpronounceable tokens
  (em-dash, slashes) or emit `<unk>`. Don't reintroduce a strict
  word-count assumption.
- Acronyms are a two-layer map (global `acronyms.json` + per-sample
  `samples/<name>/acronyms.json`, per-sample wins), threaded through
  `Aligner.process(..., acronyms=)`. Values are MFA-dict tokens.
- Audio `ipa` (greedy decode) vs. `ipa_canonical` (forced-align of dictionary
  phonemes) legitimately diverge for expanded tokens — low string similarity
  there is **not** misalignment.
- `_normalize_token`'s no-acronym path tokenizes **like MFA**
  (`re.findall(r"[A-Za-z0-9']+")`): splits hyphens/punctuation, keeps
  apostrophes. MFA splits/strips internally, so the `expanded` list
  `_collapse_groups` matches against must mirror that — don't return raw
  tokens with embedded punctuation (regresses to ~8 surviving tokens).
- MFA is **isolated per `_mfa_align` call** (per-run `MFA_ROOT_DIR` with
  `pretrained_models` symlinked in, unique corpus name,
  `--temporary_directory`). MFA's global root is not concurrency-safe; a
  shared root / fixed corpus name makes concurrent runs collide and silently
  fall back to whisperx. Costs one model re-extraction per call (cached
  result amortizes it).

## Caching

One folder per sample — alignment output lives **next to** its inputs at
`samples/<slug>/words.json`, paired with `samples/<slug>/manifest.json`
which holds the input fingerprint (`sample_fingerprint`: hash of audio
bytes + transcript + `ALIGNER_VERSION` + `lang` + acronyms + enrichment).
Source language is per-sample via `meta.json` `lang` (default `en`),
threaded `process_samples → Aligner.process(lang=) → session.lang_src`. `sid = slug`; no
opaque hash directories. On load, `is_stale(sample_dir)` compares the
manifest fingerprint to a freshly-computed one; the server still serves
the stale `words.json` but flags `stale: true` in `/api/sample-session`.
Bump `ALIGNER_VERSION` when aligner *logic* changes so stale flags fire.
Reprocess with `scripts/process_samples.py <slug>` (add `--force` to
overwrite a fresh manifest).

## Transcript schema

`words.json` is the **v2 lexicon model** (word-invariant `lexicon` +
occurrence `transcript` + `sentences` + `pauses`), defined in
`docs/transcript-schema.md`, validated against
`schemas/transcript.schema.json`. The aligner emits it (`_to_v2`); the
server injects `session.id/title`; `player.ts` adapts `transcript` →
its internal `Word[]` for rendering and keeps `lexicon` for the
dictionary card (`src/dict.ts`, spec in `docs/dictionary-card-ux.md`).
`ai` fields (`gloss`/`definition`/`pos`/`note`) ship `null`; an external
AI pass fills them. v2 is a clean break — no v1 compatibility.

## Adding a sample

Auto-discovered from `samples/<slug>/` (needs `audio.*` + `transcript.txt`;
optional `meta.json`, `acronyms.json`, `enrichment.json`). For audio +
transcript that originate outside `samples/`, adopt them in one step:
`scripts/process_samples.py --from path/to/audio.wav --transcript path/to/t.txt
--as my-slug` (creates `samples/my-slug/` and preprocesses). Enrichment is
keyed by **v2 lexicon key**, which only exists after alignment, so it's a
two-pass flow: process once (lexicon emitted, `ai` = `null`) → write
`samples/<slug>/enrichment.json` against those keys → reprocess `--force`
(`apply_enrichment` merges + schema-validates). `enrichment.json` is the
durable source of truth and re-applies every process; **never hot-patch
`words.json` directly** — `scripts/apply_enrichment.py` writes the cached
words.json only and is lost on reprocess. Lexicon keys shift on transcript
edits or `ALIGNER_VERSION` bumps — regenerate the affected enrichment keys
then.

## Conventions

- Surgical changes (see `~/.claude/CLAUDE.md`): every changed line traces to
  the request; match surrounding style.
- Sample audio + transcript + meta + enrichment live in `samples/<slug>/` and
  are tracked in git (audio is small). Derived files in the same folder —
  `words.json`, `manifest.json` — are gitignored and regenerated by
  `scripts/process_samples.py`. `dist/` is gitignored — rebuild on deploy.
- Commit + push only when the user asks; conventional-commit messages.
