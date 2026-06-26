# Japanese pipeline

Japanese support is a **per-sample `lang` fork** of the English pipeline, not a
separate app. A sample declares its language in `meta.json`; everything else
(caching, schema, server, frontend) is shared. English behaviour is unchanged
when `lang` is absent or `"en"`.

```jsonc
// samples/<slug>/meta.json
{ "title": "PM の役割", "lang": "ja" }
```

## How `lang` flows

```
meta.json `lang`
  └─ sample_cache.sample_lang(dir)          # default "en"
       ├─ sample_fingerprint(...)            # lang is part of the cache key
       └─ Aligner.process(..., lang=)        # forks tokenize + align + citation
            └─ _to_v2(..., lang, ja_features)
                 └─ session.lang_src          # consumed by player.ts / dict.ts
```

`ALIGNER_VERSION` is bumped whenever any of this logic changes so stale caches
re-fire (see `CLAUDE.md` → Caching).

## Fork points in `aligner.py`

| Stage | English | Japanese (`lang == "ja"`) |
|-------|---------|---------------------------|
| **Tokenize** | whitespace + `_normalize_token` | `_tokenize_ja` — fugashi/UniDic morphemes; display unit = morpheme; drops 補助記号/空白 punctuation. Each morpheme carries `reading` (UniDic kana), `romaji`, `mora`, `pos`, `a_type` (accent), `lemma`. |
| **Citation IPA** | espeak-ng `en-us` on the token | `_phonemize_ja` — espeak-ng `ja` on the **kana reading** (espeak mis-reads kanji). Source tag `espeak-ja`. |
| **Align** | MFA `english_*` → whisperX `en` fallback | MFA `japanese_mfa` (dict+acoustic) → whisperX `ja`+CTC fallback. Per-lang models in `MFA_MODELS`; per-lang whisperX cache in `self._align_models`. |
| **Audio-derived IPA** | wav2vec2 espeak-CTC (reliable for en) | same model, but it is English-trained so JA `ipa` (greedy decode) is unreliable — the frontend hides that row for JA. |
| **Lexeme enrich** | Oxford removed → espeak only | `reading`/`romaji`/`mora` from UniDic, `pitch_accent` from `a_type`, `furigana` from surface+reading, `gloss` from JMdict (`ja_dict.py`). |

`_collapse_groups` already preserves CJK (Python `str.isalnum()` is true for
kana/kanji), so the morpheme → MFA-word mapping needs no JA-specific change.

## Reading / romaji / mora / pitch

- **reading**: UniDic `kana` feature (katakana, dictionary form).
- **romaji**: `jaconv.kana2alphabet(hiragana)`, with `ー` → doubled vowel.
- **mora**: small kana (ゃゅょ…) attach to the preceding base; `ッ`/`ー`/`ン`
  stand alone (the unit pitch accent counts over).
- **pitch_accent**: Tokyo-dialect H/L pattern from the UniDic accent nucleus
  (`a_type`). type 0 = heiban `L H H…`, type 1 = atamadaka `H L L…`, type n≥2 =
  `L H…(to n) L`. Compound `a_type` (`"1,2"`) takes the first; `*`/missing → `null`.
  **Limit**: type-0 and type-2 look identical *within* a word (`L H`); the
  distinction only surfaces on a following particle. Word-level display can't
  show it.

## Furigana (`ja_dict.furigana_spans`)

Derived locally from the morpheme **surface + reading** (both from UniDic), so
no multi-MB ruby data file is bundled. Matching kana prefix/suffix (okurigana,
leading kana) get no ruby; the residual reading sits over the inner kanji block.
Whole-word jukujikun (今日→きょう) stay a single ruby'd span.

## Dictionary (`ja_dict.lookup_gloss`)

English glosses from **JMdict** via `jamdict` (+ bundled `jamdict-data`),
looked up by the UniDic **lemma** (dictionary form), so 食べ → 食べる → "to eat".
Lazy and optional: the pipeline runs if jamdict is unavailable (gloss = `null`).

## Licensing (public-safe)

- **JMdict/EDICT** — © EDRDG, CC BY-SA 4.0 (attribution in `README.md`).
- **UniDic** — via `fugashi` + `unidic-lite` (BSD/LGPL/GPL tri-license).
- **espeak-ng** — GPL, used as a binary phonemizer.

No proprietary dictionary data ships. (Oxford scraping was removed for this
reason — see git history.)

## Schema additions

Optional lexeme fields (null/absent for English), in
`schemas/transcript.schema.json`: `reading`, `romaji`, `mora`, `furigana`
(`[{text, ruby}]`), `pitch_accent` (`{accent, pattern:[H|L]}`). `session.lang_src`
holds the language.

## Frontend

- `src/lang.ts` — `isJapanese`/`detectScript` Unicode-range detection
  (Hiragana / Katakana / Kanji) for routing a selection.
- `player.ts` — carries `lang_src` + JA fields into `DictEntry`.
- `dict.ts` — for `lang === "ja"` renders furigana ruby, romaji, and a per-mora
  H/L pitch contour, and hides the unreliable audio-derived "said here" IPA row.

## Reproduce the reference sample

```bash
# one-time, in the conda `mfa` env:
mfa model download acoustic japanese_mfa
mfa model download dictionary japanese_mfa
conda install -n mfa -c conda-forge spacy sudachipy sudachidict-core

# process the bundled JA sample
.venv/bin/python scripts/process_samples.py ja-pm-role
```

Without the `japanese_mfa` MFA model installed, alignment falls back to
whisperX `ja`+CTC, which re-tokenizes by character (lexemes won't match the
fugashi morphemes and JA fields come back empty) — install the MFA model for
correct morpheme windows.
