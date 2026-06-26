"""Japanese dictionary helpers: furigana spans + JMdict gloss.

Furigana is derived locally from the morpheme surface + its kana reading
(both already produced by the UniDic tokenizer), so no multi-MB ruby data
file is bundled. Glosses come from JMdict via `jamdict` (EDRDG, CC BY-SA);
the lookup is lazy and optional so the pipeline runs without it.
"""
from __future__ import annotations

import jaconv

FuriganaSpan = tuple[str, str | None]


def _is_kana(c: str) -> bool:
    return ("\u3041" <= c <= "\u3096") or ("\u30a1" <= c <= "\u30fa") or c in "\u30fc\u309d\u309e\u30fd\u30fe"


def furigana_spans(surface: str, reading: str | None) -> list[FuriganaSpan]:
    """Split a morpheme into (text, ruby) spans for furigana rendering.

    Kana that already match the reading (okurigana, leading kana) carry no
    ruby; the residual reading sits over the inner kanji block. Whole-word
    jukujikun (e.g. \u4eca\u65e5\u2192\u304d\u3087\u3046) stay a single ruby'd span.
    """
    if not reading:
        return [(surface, None)]
    r = jaconv.kata2hira(reading)
    s = surface
    sh = jaconv.kata2hira(s)

    p = 0
    while p < len(s) and p < len(r) and _is_kana(s[p]) and sh[p] == r[p]:
        p += 1
    q = 0
    while q < len(s) - p and q < len(r) - p and _is_kana(s[len(s) - 1 - q]) and sh[len(s) - 1 - q] == r[len(r) - 1 - q]:
        q += 1

    spans: list[FuriganaSpan] = []
    if p:
        spans.append((s[:p], None))
    mid_s, mid_r = s[p:len(s) - q], r[p:len(r) - q]
    if mid_s:
        spans.append((mid_s, mid_r or None))
    if q:
        spans.append((s[len(s) - q:], None))
    return spans or [(surface, None)]


_JAM = None
_JAM_FAILED = False


def _jamdict():
    global _JAM, _JAM_FAILED
    if _JAM is None and not _JAM_FAILED:
        try:
            from jamdict import Jamdict
            _JAM = Jamdict()
        except Exception:
            _JAM_FAILED = True
    return _JAM


def lookup_gloss(query: str, max_senses: int = 3) -> str | None:
    """First English glosses for a headword from JMdict, or None if absent."""
    jam = _jamdict()
    if not jam or not query:
        return None
    try:
        result = jam.lookup(query)
    except Exception:
        return None
    if not result.entries:
        return None
    glosses: list[str] = []
    for sense in result.entries[0].senses:
        for g in sense.gloss:
            text = str(g).strip()
            if text and text not in glosses:
                glosses.append(text)
            if len(glosses) >= max_senses:
                return "; ".join(glosses)
    return "; ".join(glosses) or None
