---
name: create-sample
description: Create a phonetic-atlas sample from audio + transcript (English or Japanese), including the two-pass dictionary enrichment. Use whenever someone wants to add, adopt, process, or enrich drill content under samples/ — e.g. mentions a new sample, an audio + transcript pair, a slug, words.json, acronyms.json, or enrichment.json — even if they don't say the word sample.
---

# Create a sample

A sample is a folder under `samples/<slug>/`. The **only required inputs** are
audio and a transcript; everything else is optional or generated.

| File | Required | Purpose |
|------|----------|---------|
| `audio.{mp3,wav,m4a,ogg}` | **yes** | source audio (mono speech, one speaker) |
| `transcript.txt` | **yes** | exact text spoken in the audio |
| `meta.json` | no | `title`, `description`, `level`, `lang` (`"en"` default / `"ja"`) |
| `acronyms.json` | no | spell-out map for tokens MFA can't pronounce |
| `enrichment.json` | no | per-lexeme gloss/POS/definition (dictionary card) — **two-pass, see below** |

Derived `words.json` + `manifest.json` are written by the processor and are
gitignored — never edit them by hand.

## Step 1 — create the folder

Either drop files in directly:

```bash
mkdir -p samples/<slug>
cp your-audio.wav samples/<slug>/audio.wav
printf '%s\n' "the exact transcript text" > samples/<slug>/transcript.txt
```

Or adopt external files in one step (converts non-mp3 audio):

```bash
.venv/bin/python scripts/process_samples.py \
  --from path/to/audio.wav --transcript path/to/transcript.txt --as <slug>
```

Add `meta.json` (set `"lang": "ja"` for Japanese):

```json
{ "title": "Display Title", "description": "one line", "level": "A1", "lang": "en" }
```

## Step 2 — process (first pass)

```bash
.venv/bin/python scripts/process_samples.py <slug>
```

Writes `samples/<slug>/words.json` (the v2 lexicon model) + `manifest.json`.
On this pass every `gloss`/`pos`/`definition` is `null`.

- **English**: citation IPA via espeak `en-us`; alignment via MFA `english_*`
  (whisperX fallback if MFA absent).
- **Japanese** (`lang: "ja"`): fugashi/UniDic morpheme tokens; reading, romaji,
  mora, pitch accent, furigana, and JMdict glosses are filled automatically;
  citation IPA via espeak `ja`. Needs the `japanese_mfa` MFA model for correct
  word windows — see `docs/japanese-pipeline.md`. (JMdict already supplies JA
  glosses, so step 3 is usually only needed for English.)

If the aligner prints `WARN short window` for a spelled-out token (acronym,
bare number like `64`, `CI/CD`), add it to `acronyms.json` (repo-root global or
`samples/<slug>/acronyms.json` per-sample) and reprocess:

```json
{ "gpu": "g p u", "v1": "v one" }
```

## Step 3 — enrich (second pass, optional)

`enrichment.json` is keyed by **lexicon key**, which only exists after step 2.
This is why it is a two-pass flow — you cannot write it from raw audio.

1. Open `samples/<slug>/words.json`, read the keys under `"lexicon"`.
2. Write `samples/<slug>/enrichment.json` against those keys:

```json
{
  "lexemes": {
    "<lexicon-key>": { "gloss": "…", "pos": "…", "definition": "…", "note": null }
  },
  "sentences": { "0": { "gloss": "sentence translation", "note": null } }
}
```

This is the layer an AI pass fills (gloss/definition/translation). It is the
**durable source of truth** — it re-applies on every reprocess. Never hot-patch
`words.json`.

3. Reprocess with `--force` so `apply_enrichment` merges it in:

```bash
.venv/bin/python scripts/process_samples.py <slug> --force
```

> Lexicon keys shift if you edit the transcript or bump `ALIGNER_VERSION`;
> regenerate the affected enrichment keys then.

## Step 4 — verify

```bash
.venv/bin/python -m py_compile aligner.py server.py   # syntax
.venv/bin/python scripts/check_alignment.py           # batch reprocess + report
```

Then start the server and open the sample in the picker:

```bash
npm run build && python server.py   # http://127.0.0.1:7842
```

## Step 5 — commit

Track the inputs only; derived files are gitignored:

```bash
git add samples/<slug>/audio.* samples/<slug>/transcript.txt \
        samples/<slug>/meta.json samples/<slug>/acronyms.json \
        samples/<slug>/enrichment.json
git commit -m "feat(sample): add <slug>"
```
