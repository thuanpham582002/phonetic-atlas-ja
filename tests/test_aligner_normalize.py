from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aligner import Aligner


def test_normalize_token_leaves_plain_words_unchanged():
    assert Aligner._normalize_token("hello") == ["hello"]
    assert Aligner._normalize_token("world") == ["world"]


def test_normalize_token_expands_acronym_from_map():
    amap = {"vllm": "v l l m", "nccl": "n c c l"}
    assert Aligner._normalize_token("vLLM", amap) == ["v", "l", "l", "m"]
    assert Aligner._normalize_token("NCCL", amap) == ["n", "c", "c", "l"]


def test_normalize_token_handles_acronym_plural():
    amap = {"gpu": "g p u"}
    assert Aligner._normalize_token("GPUs", amap) == ["g", "p", "u", "s"]
    assert Aligner._normalize_token("GPU's", amap) == ["g", "p", "u", "s"]


def test_normalize_token_expands_all_caps_alphanumeric():
    # All-caps + digits: spell each char, speak numbers
    result = Aligner._normalize_token("V1")
    assert result == ["v", "one"]
    
    result = Aligner._normalize_token("GPT4")
    assert result == ["g", "p", "t", "four"]


def test_normalize_token_speaks_multi_digit_numbers():
    # Multi-digit numbers are expanded
    result = Aligner._normalize_token("64")
    assert result == ["sixty", "four"]
    
    result = Aligner._normalize_token("20")
    assert result == ["twenty"]
    
    # Single-digit numbers stay as-is (no expansion needed)
    result = Aligner._normalize_token("3")
    assert result == ["3"]


def test_normalize_token_handles_decimal_numbers():
    # Decimals not in ALL_CAPS pattern stay as multi-token fallback
    result = Aligner._normalize_token("3.14")
    assert result == ["3", "14"]


def test_normalize_token_strips_punctuation_before_processing():
    amap = {"gpu": "g p u"}
    assert Aligner._normalize_token("GPU.", amap) == ["g", "p", "u"]
    assert Aligner._normalize_token("(GPUs)", amap) == ["g", "p", "u", "s"]


def test_normalize_token_returns_single_element_for_known_word():
    # Known MFA vocab word should stay as-is (not split)
    result = Aligner._normalize_token("hello")
    assert result == ["hello"]


def _ja_tokenizer():
    # Build the JA path without Aligner.__init__ (no torch/MFA needed).
    a = Aligner.__new__(Aligner)
    a._ja_tagger = None
    return a


def test_tokenize_ja_segments_morphemes():
    a = _ja_tokenizer()
    assert [m["surface"] for m in a._tokenize_ja("食べる")] == ["食べる"]
    assert [m["surface"] for m in a._tokenize_ja("私は寿司を食べました")] == [
        "私", "は", "寿司", "を", "食べ", "まし", "た"]
    # surviving morphemes carry reading/romaji/mora
    taberu = a._tokenize_ja("食べる")[0]
    assert taberu["reading"] == "タベル"
    assert taberu["romaji"] == "taberu"
    assert taberu["mora"] == ["タ", "ベ", "ル"]


def test_tokenize_ja_drops_punctuation():
    a = _ja_tokenizer()
    # Trailing 。 (補助記号) must not become an empty alignment window.
    surfaces = [m["surface"] for m in a._tokenize_ja("行きたい。")]
    assert "。" not in surfaces
    assert [m["surface"] for m in a._tokenize_ja("東京タワーに行きたい")] == [
        "東京", "タワー", "に", "行き", "たい"]


def test_ja_romaji_handles_gemination_palatal_and_long_vowel():
    assert Aligner._ja_romaji("タベル") == "taberu"
    assert Aligner._ja_romaji("ガッコウ") == "gakkou"      # ッ gemination
    assert Aligner._ja_romaji("シャシン") == "shashin"    # ャ palatal
    assert Aligner._ja_romaji("コーヒー") == "koohii"     # ー long vowel -> doubled


def test_ja_mora_attaches_small_kana_only():
    assert Aligner._ja_mora("タベル") == ["タ", "ベ", "ル"]
    assert Aligner._ja_mora("シャシン") == ["シャ", "シ", "ン"]   # ャ attaches
    assert Aligner._ja_mora("ガッコウ") == ["ガ", "ッ", "コ", "ウ"]   # ッ stands alone
    assert Aligner._ja_mora("コーヒー") == ["コ", "ー", "ヒ", "ー"]   # ー stands alone


def test_ja_pitch_accent_tokyo_patterns():
    hashi = ["ハ", "シ"]
    # 箸 atamadaka (type 1): H L
    assert Aligner._ja_pitch_accent(hashi, "1") == {"accent": 1, "pattern": ["H", "L"]}
    # 端 heiban (type 0): L H
    assert Aligner._ja_pitch_accent(hashi, "0") == {"accent": 0, "pattern": ["L", "H"]}
    # 日本 ニッポン (type 3): L H H L
    assert Aligner._ja_pitch_accent(["ニ", "ッ", "ポ", "ン"], "3") == {
        "accent": 3, "pattern": ["L", "H", "H", "L"]}


def test_ja_pitch_accent_compound_and_unknown():
    # Compound aType '1,2' takes the first nucleus.
    assert Aligner._ja_pitch_accent(["ス", "シ"], "1,2") == {"accent": 1, "pattern": ["H", "L"]}
    # Unknown / missing accent -> None (not a guessed pattern).
    assert Aligner._ja_pitch_accent(["ス", "シ"], "*") is None
    assert Aligner._ja_pitch_accent(["ス", "シ"], None) is None
    assert Aligner._ja_pitch_accent([], "1") is None


def test_phonemize_ja_uses_reading_not_kanji():
    a = _ja_tokenizer()
    assert a._phonemize_ja("") == ""
    # espeak ja mis-reads kanji (emits '(en)...chinese...'); phonemizing the
    # kana reading must yield clean IPA without those leak markers.
    for reading in ("スシ", "タベル", "トウキョウ"):
        ipa = a._phonemize_ja(reading)
        assert ipa
        assert "(en)" not in ipa and "(ja)" not in ipa and "chinese" not in ipa.lower()


if __name__ == "__main__":
    test_normalize_token_leaves_plain_words_unchanged()
    test_normalize_token_expands_acronym_from_map()
    test_normalize_token_handles_acronym_plural()
    test_normalize_token_expands_all_caps_alphanumeric()
    test_normalize_token_speaks_multi_digit_numbers()
    test_normalize_token_handles_decimal_numbers()
    test_normalize_token_strips_punctuation_before_processing()
    test_normalize_token_returns_single_element_for_known_word()
    test_tokenize_ja_segments_morphemes()
    test_tokenize_ja_drops_punctuation()
    test_ja_romaji_handles_gemination_palatal_and_long_vowel()
    test_ja_mora_attaches_small_kana_only()
    test_ja_pitch_accent_tokyo_patterns()
    test_ja_pitch_accent_compound_and_unknown()
    test_phonemize_ja_uses_reading_not_kanji()
    print("aligner normalize: 15 tests passed")
