# Transcript object schema (v2 — lexicon model)

Defines the JSON object the app produces/consumes. v2 splits two kinds of
fact that v1 (`words.json`) conflated:

- **Word-invariant** — same every time a word appears (citation IPA, part of
  speech, definition, gloss). Lives **once** in `lexicon`.
- **Occurrence-specific** — how *this* utterance was actually said (timing,
  real IPA, prosody). Lives in `transcript`, one entry per spoken token,
  referencing a lexicon key.

Sentence-level meaning lives in `sentences` (word-by-word EN→VI is
misleading; phrase translation is the honest unit).

## Who fills what

| Producer | Meaning |
|---|---|
| `aligner` | mechanical, from audio + transcript (existing pipeline) |
| `builder` | dedup/index pass that constructs the lexicon skeleton |
| `ai`      | generated, **context-aware** (you supply this step) |
| `player`  | consumed by the frontend |

The `ai` fields are intentionally the only ones requiring judgment: the
generator gets the full `transcript` + source `sentences` as context so the
gloss/definition match the sense actually used here, not a generic one.

## Shape

```jsonc
{
  "schema_version": 2,
  "session": {
    "id": "34f8ee1c23d5",        // builder
    "title": "dev-shm",           // builder
    "duration": 64.48,            // aligner (seconds)
    "lang_src": "en",             // source language; from samples/<slug>/meta.json `lang` (default "en")
    "lang_gloss": "vi",           // target language for ai glosses
    "aligner": "mfa"              // aligner | whisperx
  },

  // word-invariant, keyed by normalized form (lowercase, trailing
  // punctuation stripped, possessive/plural 's/s folded)
  "lexicon": {
    "data": {
      "key": "data",              // builder (= map key, for portability)
      "lemma": "data",            // ai (dictionary headword; default = key)
      "surface_forms": ["data", "data,"],   // builder
      "ipa_citation": "ˈdeɪtə",   // aligner (phonemizer canonical)
      "pos": "noun",              // ai | null
      "gloss": "dữ liệu",         // ai | null  (target lang, this sense)
      "definition": "facts/info processed by a computer",  // ai | null (src)
      "definition_gloss": "dữ liệu máy tính xử lý",         // ai | null
      "note": null,               // ai | null (usage / false-friend / tip)
      "occurrences": [42, 87]     // builder (indices into transcript)
    }
  },

  // occurrence-specific, ordered as spoken
  "transcript": [
    {
      "i": 42,                    // builder (index, = array position)
      "raw": "data,",             // aligner (original token, w/ punctuation)
      "lex": "data",              // builder (lexicon key; null = non-lexical)
      "sent": 3,                  // builder (index into sentences; null ok)
      "start": 8.10,              // aligner (seconds)
      "end": 8.50,                // aligner
      "ipa": "ɾɛɾə",              // aligner (REAL audio realization)
      "phonemes": [               // aligner (audio, timed)
        { "p": "ɾ", "start": 8.10, "end": 8.22 }
      ],
      "phonemes_citation": [      // aligner (canonical seq, timed to THIS
        { "p": "d", "start": 8.10, "end": 8.20 }   // utterance — so it is
      ],                          // occurrence-specific, not invariant)
      "f0_norm": [0.52, null],    // aligner (normalized pitch samples)
      "stress": false,            // aligner
      "peak": false,              // aligner
      "is_filler": false          // aligner
    }
  ],

  "sentences": [
    {
      "i": 3,                     // builder
      "span": [40, 53],           // builder ([firstTokenIdx, lastTokenIdx])
      "text": "POSIX shared memory is a filesystem in RAM.",  // builder
      "gloss": "Bộ nhớ chia sẻ POSIX là một hệ thống tệp trong RAM.", // ai
      "note": null                // ai | null
    }
  ],

  "pauses": [ { "after": 11, "gap_ms": 320 } ]   // aligner
}
```

## Rules / invariants

- `transcript[i].i === i`. `lexicon[k].key === k`.
- `transcript[i].lex` is either a key present in `lexicon` or `null`
  (pure punctuation / non-lexical). Fillers ("um") still get a lexicon
  entry; `is_filler` distinguishes them.
- Citation IPA is **never** duplicated onto the token — resolve via
  `lex` → `lexicon[lex].ipa_citation`. (`phonemes_citation` *is* on the
  token because its timing is per-utterance.)
- `occurrences` and `sent`/`span` are derivable from `transcript`; the
  builder writes them so consumers don't recompute.
- `ai` fields are always nullable. A valid object can ship with every
  `ai` field `null` (un-enriched); enrichment is an independent later pass.
- Versioned: consumers must check `schema_version`. v2 is a clean
  break from v1 `words.json` (no dual-shape compatibility).

The formal contract is `schemas/transcript.schema.json` (JSON Schema
2020-12) — validate AI output against it.
