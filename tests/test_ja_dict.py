from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ja_dict


def test_furigana_kanji_block_gets_residual_reading():
    # Okurigana kana carry no ruby; the kanji block gets the residual reading.
    assert ja_dict.furigana_spans("食べ", "タベ") == [("食", "た"), ("べ", None)]
    assert ja_dict.furigana_spans("行き", "イキ") == [("行", "い"), ("き", None)]


def test_furigana_whole_word_and_leading_kana():
    # Jukujikun stays a single ruby'd span.
    assert ja_dict.furigana_spans("今日", "キョウ") == [("今日", "きょう")]
    # Leading kana (お) carries no ruby.
    assert ja_dict.furigana_spans("お寿司", "オスシ") == [("お", None), ("寿司", "すし")]


def test_furigana_pure_kana_and_missing_reading():
    assert ja_dict.furigana_spans("は", "ハ") == [("は", None)]
    assert ja_dict.furigana_spans("食べる", None) == [("食べる", None)]


def test_lookup_gloss_present_and_absent():
    # JMdict (jamdict-data) ships in requirements; gloss resolves for real words.
    assert "eat" in (ja_dict.lookup_gloss("食べる") or "")
    assert ja_dict.lookup_gloss("xyzzy123") is None
    assert ja_dict.lookup_gloss("") is None


if __name__ == "__main__":
    test_furigana_kanji_block_gets_residual_reading()
    test_furigana_whole_word_and_leading_kana()
    test_furigana_pure_kana_and_missing_reading()
    test_lookup_gloss_present_and_absent()
    print("ja_dict: 4 tests passed")
