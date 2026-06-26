import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import torch
import torchaudio
import whisperx
from phonemizer import phonemize
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

def clean_ipa(s):
    return s.strip().strip("/").strip() or None if s else None

os.environ.setdefault("PHONEMIZER_ESPEAK_LIBRARY", "/opt/homebrew/lib/libespeak-ng.dylib")

MODEL_NAME = "facebook/wav2vec2-lv-60-espeak-cv-ft"
DEVICE = "cpu"
GREEDY_CONF = 0.30
MFA_BIN = os.environ.get("MFA_BIN",
                         str(Path.home() / "miniforge3/envs/mfa/bin/mfa"))
MFA_DICT = os.environ.get("MFA_DICT", "english_us_mfa")
MFA_ACOUSTIC = os.environ.get("MFA_ACOUSTIC", "english_mfa")

# Per-language MFA (dictionary, acoustic) model names. English honours the
# legacy MFA_DICT/MFA_ACOUSTIC env overrides; Japanese uses the MFA-distributed
# `japanese_mfa` models. English MFA models cannot align Japanese.
MFA_MODELS = {
    "en": (MFA_DICT, MFA_ACOUSTIC),
    "ja": (os.environ.get("MFA_DICT_JA", "japanese_mfa"),
           os.environ.get("MFA_ACOUSTIC_JA", "japanese_mfa")),
}
ACRONYMS_FILE = os.environ.get(
    "ACRONYMS_FILE", str(Path(__file__).parent / "acronyms.json"))


def _load_acronyms():
    try:
        with open(ACRONYMS_FILE) as f:
            return {k.lower(): v for k, v in json.load(f).items()}
    except (OSError, ValueError) as e:
        print(f"acronyms map not loaded ({ACRONYMS_FILE}): {e}")
        return {}


def _load_mfa_vocab():
    candidates = []
    dict_path = Path(MFA_DICT)
    if dict_path.exists():
        candidates.append(dict_path)
    real_root = Path(os.environ.get("MFA_ROOT_DIR")
                     or Path.home() / "Documents" / "MFA")
    candidates.append(real_root / "pretrained_models" / "dictionary"
                      / f"{MFA_DICT}.dict")
    for path in candidates:
        try:
            vocab = set()
            with open(path, errors="ignore") as f:
                for line in f:
                    parts = line.strip().split()
                    if parts:
                        vocab.add(parts[0].lower())
            if vocab:
                return vocab
        except OSError:
            continue
    return set()


MFA_VOCAB = _load_mfa_vocab()


_SMALL_NUMBERS = {
    0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
    6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
    11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen",
    15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen",
    19: "nineteen",
}
_TENS = {
    20: "twenty", 30: "thirty", 40: "forty", 50: "fifty",
    60: "sixty", 70: "seventy", 80: "eighty", 90: "ninety",
}


def _integer_words(n: int) -> list[str]:
    if n < 20:
        return [_SMALL_NUMBERS[n]]
    if n < 100:
        ten = (n // 10) * 10
        rest = n % 10
        return [_TENS[ten]] + ([_SMALL_NUMBERS[rest]] if rest else [])
    if n < 1000:
        rest = n % 100
        return [_SMALL_NUMBERS[n // 100], "hundred"] + (_integer_words(rest) if rest else [])
    if n < 10000:
        rest = n % 1000
        return _integer_words(n // 1000) + ["thousand"] + (_integer_words(rest) if rest else [])
    return [str(d) for d in str(n)]


def _number_words(s: str) -> list[str]:
    raw = s.strip().strip(".,;:!?\"')([]{}…—–-")
    if re.fullmatch(r"\d+", raw):
        return _integer_words(int(raw))
    if re.fullmatch(r"\d+\.\d+", raw):
        left, right = raw.split(".", 1)
        return _integer_words(int(left)) + ["point"] + [_SMALL_NUMBERS[int(d)] for d in right]
    return []


class Aligner:
    def __init__(self):
        print("Loading wav2vec2 phoneme model ...")
        self.processor = Wav2Vec2Processor.from_pretrained(MODEL_NAME)
        self.model = Wav2Vec2ForCTC.from_pretrained(MODEL_NAME).to(DEVICE).eval()
        self.vocab = self.processor.tokenizer.get_vocab()
        self.id2tok = {i: t for t, i in self.vocab.items()}
        self.pad_id = self.processor.tokenizer.pad_token_id
        self.sorted_toks = sorted([t for t in self.vocab if not t.startswith("<")],
                                  key=len, reverse=True)
        self.mfa_available = Path(MFA_BIN).exists()
        if self.mfa_available:
            print(f"MFA available at {MFA_BIN}")
        self._align_models = {}  # lang -> (model, meta), lazily loaded
        self._ja_tagger = None
        print("Aligner ready.")

    def _greedy_tokenize(self, s):
        return [tid for tid, _ in self._greedy_tokenize_stressed(s)]

    def _greedy_tokenize_stressed(self, s):
        out = []
        i = 0
        pending = 0
        while i < len(s):
            c = s[i]
            if c == "ˈ":
                pending = 1
                i += 1
                continue
            if c == "ˌ":
                pending = 2
                i += 1
                continue
            if c.isspace():
                i += 1
                continue
            matched = None
            for tok in self.sorted_toks:
                if tok and s.startswith(tok, i):
                    matched = tok
                    break
            if matched:
                out.append((self.vocab[matched], pending))
                pending = 0
                i += len(matched)
            else:
                i += 1
        return out

    def _phonemize_word(self, w):
        clean = "".join(c for c in w if c.isalpha() or c == "'")
        if not clean:
            return ""
        try:
            return phonemize(clean, language="en-us", backend="espeak", strip=True,
                             preserve_punctuation=False, with_stress=True).strip()
        except Exception:
            return ""

    def _phonemize_ja(self, kana: str) -> str:
        """IPA for a Japanese morpheme from its kana pronunciation.

        Uses the deterministic kana→IPA table (_kana_to_ipa) rather than
        espeak-ng's `ja` voice, which mangles long vowels (doubled instead of
        ː), emits noisy diacritics, and — fed the citation reading — gets
        particles wrong. The caller passes UniDic 発音 (pron) so は→ワ etc. are
        already resolved.
        """
        return self._kana_to_ipa(kana)
    def _mfa_align(self, audio_path: str, transcript: str, lang: str = "en"):
        if not self.mfa_available:
            return None
        mfa_dict, mfa_acoustic = MFA_MODELS.get(lang, MFA_MODELS["en"])
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp) / f"corpus_{Path(tmp).name}"
            out = Path(tmp) / "out"
            mfa_tmp = Path(tmp) / "mfa"
            corpus.mkdir()
            out.mkdir()
            mfa_tmp.mkdir()
            ext = Path(audio_path).suffix or ".mp3"
            audio_dst = corpus / f"audio{ext}"
            shutil.copy(audio_path, audio_dst)
            (corpus / "audio.lab").write_text(transcript)
            real_root = Path(os.environ.get("MFA_ROOT_DIR")
                             or Path.home() / "Documents" / "MFA")
            (mfa_tmp / "pretrained_models").symlink_to(
                real_root / "pretrained_models")
            mfa_bin_dir = str(Path(MFA_BIN).parent)
            env = {**os.environ,
                   "PATH": mfa_bin_dir + ":" + os.environ.get("PATH", ""),
                   "MFA_ROOT_DIR": str(mfa_tmp)}
            try:
                subprocess.run(
                    [MFA_BIN, "align", "--clean", "--quiet",
                     "--temporary_directory", str(mfa_tmp),
                     "--output_format", "json",
                     str(corpus), mfa_dict, mfa_acoustic, str(out)],
                    check=True, capture_output=True, timeout=300, env=env)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                stderr = getattr(e, "stderr", b"")
                print(f"MFA failed: {e}\n{stderr.decode(errors='replace')[-500:]}")
                return None
            json_path = out / "audio.json"
            if not json_path.exists():
                return None
            data = json.loads(json_path.read_text())
            return [{"word": w[2], "start": float(w[0]), "end": float(w[1])}
                    for w in data["tiers"]["words"]["entries"]
                    if w[2].strip()]

    SPELLED_ACRONYMS = _load_acronyms()

    @staticmethod
    def _token_core(tok):
        return tok.strip(".,;:!?\"')([]{}…—–-")

    @staticmethod
    def _auto_alnum_parts(raw):
        if not re.fullmatch(r"[A-Z0-9]+(?:'s|s)?", raw):
            return []
        plural = False
        if raw.endswith("'s"):
            raw = raw[:-2]
            plural = True
        elif raw.endswith("s") and re.fullmatch(r"[A-Z0-9]+", raw[:-1]):
            raw = raw[:-1]
            plural = True
        parts = []
        for run in re.findall(r"[A-Z]+|\d+", raw):
            if run.isdigit():
                parts.extend(_number_words(run) or list(run))
            else:
                parts.extend(c.lower() for c in run)
        if plural:
            parts.append("s")
        if raw.isdigit() and len(raw) > 1 and parts:
            return parts
        return parts if len(parts) > 1 else []

    @staticmethod
    def _auto_oov_segments(raw):
        lower = raw.lower()
        if lower in MFA_VOCAB:
            return []
        if not re.fullmatch(r"[a-z0-9]+", lower):
            return []

        if any(c.isdigit() for c in lower):
            parts = []
            changed = False
            for run in re.findall(r"[a-z]+|\d+", lower):
                if run.isdigit():
                    parts.extend(_number_words(run) or list(run))
                    changed = True
                elif run in MFA_VOCAB:
                    parts.append(run)
                else:
                    sub = Aligner._auto_oov_segments(run)
                    parts.extend(sub or [run])
                    changed = changed or bool(sub)
            return parts if changed and len(parts) > 1 else []

        if len(lower) <= 5 and not re.search(r"[aeiou]", lower):
            return list(lower)

        def piece_cost(piece, at_end):
            if len(piece) == 1:
                return 3.0
            if len(piece) == 2:
                return 1.8
            cost = 1.0 - min(len(piece), 8) * 0.06
            # Prefer singular/non-inflected stems before another segment:
            # user+space should beat users+pace without naming either word.
            if not at_end and piece.endswith("s"):
                cost += 0.5
            return cost

        best = [(float("inf"), []) for _ in range(len(lower) + 1)]
        best[len(lower)] = (0.0, [])
        for i in range(len(lower) - 1, -1, -1):
            for j in range(len(lower), i + 1, -1):
                piece = lower[i:j]
                if piece in MFA_VOCAB and (len(piece) >= 3 or piece == "re"):
                    tail_cost, tail = best[j]
                    if tail_cost < float("inf"):
                        cost = tail_cost + piece_cost(piece, j == len(lower))
                        if cost < best[i][0]:
                            best[i] = (cost, [piece] + tail)
            letter = lower[i:i + 1]
            if letter in MFA_VOCAB:
                tail_cost, tail = best[i + 1]
                if tail_cost < float("inf"):
                    cost = tail_cost + piece_cost(letter, i + 1 == len(lower))
                    if cost < best[i][0]:
                        best[i] = (cost, [letter] + tail)

        _cost, parts = best[0]
        if len(parts) <= 1:
            return []
        single_letters = sum(1 for p in parts if len(p) == 1)
        longest = max(len(p) for p in parts)
        has_vowel = bool(re.search(r"[aeiou]", lower))
        if longest < 3:
            return []
        if has_vowel and single_letters / len(lower) > 0.4:
            return []
        if len(parts) == 2 and len(parts[-1]) == 1 and len(parts[0]) >= 3:
            return []
        return parts

    SMALL_KANA = set("ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ")

    @staticmethod
    def _ja_romaji(kana: str) -> str:
        import jaconv
        r = jaconv.kana2alphabet(jaconv.kata2hira(kana))
        return re.sub(r"([aeiou])-", r"\1\1", r)

    @staticmethod
    def _ja_pitch_accent(mora: list[str], a_type) -> dict | None:
        """Tokyo-dialect pitch pattern from a UniDic accent type.

        `a_type` is the accent nucleus (mora index where pitch falls). UniDic
        may emit a compound like '1,2' (take the first) or '*'/None (unknown).
        Returns {accent, pattern} where pattern is per-mora H/L:
          - 0 (heiban):   L H H ... (no fall within the word)
          - 1 (atamadaka): H L L ...
          - n>=2:          L H ... (H up to mora n) then L
        """
        if not mora or a_type in (None, "", "*"):
            return None
        first = str(a_type).split(",")[0].strip()
        if not first.lstrip("-").isdigit():
            return None
        accent = int(first)
        n = len(mora)
        if accent == 0:
            pattern = ["L"] + ["H"] * (n - 1)
        elif accent == 1:
            pattern = ["H"] + ["L"] * (n - 1)
        else:
            pattern = ["L"] + ["H"] * (accent - 1) + ["L"] * (n - accent)
            pattern = pattern[:n]
        return {"accent": accent, "pattern": pattern}

    # Hepburn for loanword combos jaconv.kana2alphabet romanizes wrong (ジェ→'jie').
    JA_ROMA_COMBO = {
        "シェ": "she", "ジェ": "je", "チェ": "che", "ニェ": "nye", "ヒェ": "hye",
        "ティ": "ti", "ディ": "di", "トゥ": "tu", "ドゥ": "du",
        "テュ": "tyu", "デュ": "dyu",
        "ファ": "fa", "フィ": "fi", "フェ": "fe", "フォ": "fo", "フュ": "fyu",
        "ウィ": "wi", "ウェ": "we", "ウォ": "wo", "イェ": "ye",
        "ツァ": "tsa", "ツィ": "tsi", "ツェ": "tse", "ツォ": "tso",
        "ヴ": "vu", "ヴァ": "va", "ヴィ": "vi", "ヴェ": "ve", "ヴォ": "vo",
    }

    @classmethod
    def _mora_roma(cls, mora: str) -> str:
        return cls.JA_ROMA_COMBO.get(mora) or cls._ja_romaji(mora)

    @classmethod
    def _ja_mora_pitch(cls, kana: str, a_type) -> list[dict] | None:
        """Per-mora Hepburn romaji + pitch (H/L) for the learner-facing display.

        Built from UniDic 発音 so particles read correctly (は→wa). ー repeats
        the previous vowel, ッ shows the geminated onset, ン is 'n' — each keeps
        its own mora slot so the pitch overline aligns to the romaji.
        """
        if not kana:
            return None
        import jaconv
        morae = cls._ja_mora(jaconv.hira2kata(kana))
        if not morae:
            return None
        pa = cls._ja_pitch_accent(morae, a_type)
        pattern = pa["pattern"] if pa else None
        base = [cls._mora_roma(m) if m not in ("ー", "ッ") else "" for m in morae]
        out = []
        for i, m in enumerate(morae):
            if m == "ー":                       # long vowel: repeat prev vowel
                prev = out[-1]["r"] if out else ""
                r = prev[-1] if prev else ""
            elif m == "ッ":                      # sokuon: double next onset
                nxt = base[i + 1] if i + 1 < len(base) else ""
                r = nxt[0] if nxt and nxt[0] not in "aeiou" else ""
            else:
                r = base[i]
            out.append({"r": r,
                        "h": bool(pattern and i < len(pattern) and pattern[i] == "H")})
        return out

    @classmethod
    def _ja_mora(cls, kana: str) -> list[str]:
        """Split a katakana reading into mora (small kana attach to the base)."""
        out: list[str] = []
        for ch in kana:
            if ch in cls.SMALL_KANA and out:
                out[-1] += ch
            else:
                out.append(ch)
        return out

    # Katakana mora → narrow IPA, consistent with the project's transcription
    # style (ɯᵝ compressed /u/, ɕ/dʑ/tɕ, ç/ɸ, ɽ flap, e/o lowered mids). Built
    # from UniDic 発音, so it already encodes contextual readings; long vowels
    # (ー) and geminates (ッ) are handled in _kana_to_ipa, not here.
    MORA_IPA = {
        "ア": "a", "イ": "i", "ウ": "ɯᵝ", "エ": "e", "オ": "o",
        "カ": "ka", "キ": "ki", "ク": "kɯᵝ", "ケ": "ke", "コ": "ko",
        "キャ": "kja", "キュ": "kjɯᵝ", "キョ": "kjo", "キェ": "kje",
        "ガ": "ɡa", "ギ": "ɡi", "グ": "ɡɯᵝ", "ゲ": "ɡe", "ゴ": "ɡo",
        "ギャ": "ɡja", "ギュ": "ɡjɯᵝ", "ギョ": "ɡjo",
        "サ": "sa", "シ": "ɕi", "ス": "sɯᵝ", "セ": "se", "ソ": "so",
        "シャ": "ɕa", "シュ": "ɕɯᵝ", "ショ": "ɕo", "シェ": "ɕe",
        "ザ": "za", "ジ": "dʑi", "ズ": "zɯᵝ", "ゼ": "ze", "ゾ": "zo",
        "ジャ": "dʑa", "ジュ": "dʑɯᵝ", "ジョ": "dʑo", "ジェ": "dʑe",
        "タ": "ta", "チ": "tɕi", "ツ": "tsɯᵝ", "テ": "te", "ト": "to",
        "チャ": "tɕa", "チュ": "tɕɯᵝ", "チョ": "tɕo", "チェ": "tɕe",
        "ツァ": "tsa", "ツィ": "tsi", "ツェ": "tse", "ツォ": "tso",
        "ティ": "ti", "トゥ": "tɯᵝ", "テュ": "tjɯᵝ",
        "ダ": "da", "ヂ": "dʑi", "ヅ": "zɯᵝ", "デ": "de", "ド": "do",
        "ディ": "di", "ドゥ": "dɯᵝ", "デュ": "djɯᵝ",
        "ナ": "na", "ニ": "ɲi", "ヌ": "nɯᵝ", "ネ": "ne", "ノ": "no",
        "ニャ": "ɲa", "ニュ": "ɲɯᵝ", "ニョ": "ɲo", "ニェ": "ɲe",
        "ハ": "ha", "ヒ": "çi", "フ": "ɸɯᵝ", "ヘ": "he", "ホ": "ho",
        "ヒャ": "ça", "ヒュ": "çɯᵝ", "ヒョ": "ço",
        "ファ": "ɸa", "フィ": "ɸi", "フェ": "ɸe", "フォ": "ɸo", "フュ": "ɸjɯᵝ",
        "バ": "ba", "ビ": "bi", "ブ": "bɯᵝ", "ベ": "be", "ボ": "bo",
        "ビャ": "bja", "ビュ": "bjɯᵝ", "ビョ": "bjo",
        "パ": "pa", "ピ": "pi", "プ": "pɯᵝ", "ペ": "pe", "ポ": "po",
        "ピャ": "pja", "ピュ": "pjɯᵝ", "ピョ": "pjo",
        "マ": "ma", "ミ": "mi", "ム": "mɯᵝ", "メ": "me", "モ": "mo",
        "ミャ": "mja", "ミュ": "mjɯᵝ", "ミョ": "mjo",
        "ヤ": "ja", "ユ": "jɯᵝ", "ヨ": "jo",
        "ラ": "ɽa", "リ": "ɽi", "ル": "ɽɯᵝ", "レ": "ɽe", "ロ": "ɽo",
        "リャ": "ɽja", "リュ": "ɽjɯᵝ", "リョ": "ɽjo",
        "ワ": "wa", "ヰ": "wi", "ヱ": "we", "ヲ": "o", "ン": "ɴ",
        "ウィ": "wi", "ウェ": "we", "ウォ": "wo",
        "ヴ": "vɯᵝ", "ヴァ": "va", "ヴィ": "vi", "ヴェ": "ve", "ヴォ": "vo",
    }
    # Consonant onsets that a sokuon (ッ) geminates by doubling the first segment.
    _JA_GEMINABLE = set("kɡsztcdnhçɸbpmɽwvɕ")

    # Split a JA IPA string into display phonemes: affricates stay whole, a
    # vowel keeps its diacritics + length mark, geminates remain two units.
    _JA_PHON_RE = re.compile(
        r"ts|tɕ|dʑ"                                # affricates (one unit)
        r"|[aiɯeo](?:[̀-ͯ]|ᵝ)*ː?"        # vowel + diacritics + length
        r"|[pbtdkɡszɕçɸhmnɲŋɴɽɾjwv]"               # single consonants
    )

    @classmethod
    def _ja_split_phonemes(cls, ipa: str) -> list[str]:
        return cls._JA_PHON_RE.findall(ipa) if ipa else []

    @classmethod
    def _ja_even_phonemes(cls, ipa: str, start: float, end: float) -> list[dict]:
        """Citation phonemes for a JA word, spread evenly across [start, end].

        The citation form is a normative pronunciation, not what was said, so
        sub-word timing is inherently synthetic — even distribution over the
        MFA-aligned word span is both honest and keeps the exact IPA (length
        marks, geminates, diacritics) that the wav2vec2 aligner would mangle.
        """
        segs = cls._ja_split_phonemes(ipa)
        if not segs:
            return []
        step = (end - start) / len(segs)
        return [{"p": p,
                 "start": round(start + i * step, 3),
                 "end": round(start + (i + 1) * step, 3)}
                for i, p in enumerate(segs)]

    @classmethod
    def _mora_ipa(cls, mora: str) -> str:
        if mora in cls.MORA_IPA:
            return cls.MORA_IPA[mora]
        # Unknown combo (rare loanword cluster): approximate as base + small kana.
        if len(mora) > 1 and mora[0] in cls.MORA_IPA:
            return cls.MORA_IPA[mora[0]] + cls.MORA_IPA.get(mora[1:], "")
        return ""

    @staticmethod
    def _nasal_realization(seq: list, i: int) -> str:
        """Place-assimilated realization of the moraic nasal ン at seq[i].

        [m] before labials, [ŋ] before velars, [n] before coronals, else [ɴ]
        (before a vowel/approximant or phrase-finally).
        """
        nxt = next((s[1] for s in seq[i + 1:] if s[0] == "v"), None)
        if not nxt:
            return "ɴ"
        c = nxt[0]
        if c in "pbm":
            return "m"
        if c in "kɡ":
            return "ŋ"
        if c in "tdnszɕɽ":
            return "n"
        return "ɴ"

    @classmethod
    def _kana_to_ipa(cls, kana: str) -> str:
        """Convert a katakana reading (ideally UniDic 発音) to narrow IPA.

        Deterministic and reference-quality, unlike espeak-ng's `ja` voice:
        long vowels (ー) become a length mark, geminates (ッ) double the next
        onset, and the moraic nasal (ン) assimilates to the following place.
        """
        if not kana:
            return ""
        import jaconv
        morae = cls._ja_mora(jaconv.hira2kata(kana))
        # Pass 1: classify each mora (ordinary syllable vs. the three specials).
        seq: list = []  # ('v', ipa) | ('long',) | ('soku',) | ('nasal',)
        for mora in morae:
            if mora == "ー":
                seq.append(("long",))
            elif mora == "ッ":
                seq.append(("soku",))
            elif mora == "ン":
                seq.append(("nasal",))
            else:
                ipa = cls._mora_ipa(mora)
                if ipa:
                    seq.append(("v", ipa))
        # Pass 2: emit, resolving gemination / lengthening / nasal from context.
        out: list[str] = []
        geminate = False
        for i, item in enumerate(seq):
            kind = item[0]
            if kind == "long":
                if out:
                    out[-1] += "ː"
                geminate = False
            elif kind == "soku":
                geminate = True
            elif kind == "nasal":
                out.append(cls._nasal_realization(seq, i))
                geminate = False
            else:  # ordinary syllable
                ipa = item[1]
                if geminate and ipa[0] in cls._JA_GEMINABLE:
                    ipa = ipa[0] + ipa
                geminate = False
                out.append(ipa)
        return "".join(out)

    def _tokenize_ja(self, transcript: str) -> list[dict]:
        """Segment a Japanese transcript into morpheme tokens (MeCab/UniDic).

        Japanese has no whitespace word boundary, so the display unit is the
        morpheme. Returns one dict per surviving morpheme with the surface plus
        JA features (reading/romaji/mora/pitch). Punctuation/symbol morphemes
        (UnidicFeatures pos1 補助記号/空白) are dropped so they don't become empty
        alignment windows.
        """
        if self._ja_tagger is None:
            import fugashi
            self._ja_tagger = fugashi.Tagger()
        out = []
        for m in self._ja_tagger(transcript):
            surface = m.surface.strip()
            if not surface:
                continue
            f = m.feature
            pos1 = getattr(f, "pos1", "") or ""
            if pos1 in ("補助記号", "空白"):
                continue
            reading = getattr(f, "kana", None) or None
            # UniDic 発音 (pron) is the *contextual* pronunciation, not the
            # citation reading: particle は→ワ, を→オ, へ→エ, long vowels as ー,
            # geminates kept. The IPA is derived from this; furigana/romaji keep
            # the citation `reading` (a learner expects は's furigana to be は).
            pron = getattr(f, "pron", None) or None
            lemma = getattr(f, "lemma", None) or None
            if lemma:
                lemma = lemma.split("-")[0]  # UniDic appends '-tower', '-代名詞' etc.
            out.append({
                "surface": surface,
                "reading": reading,
                "pron": pron,
                "romaji": self._ja_romaji(reading) if reading else None,
                "mora": self._ja_mora(reading) if reading else None,
                "pos": pos1 or None,
                "a_type": getattr(f, "aType", None),
                "lemma": lemma,
            })
        return out

    @staticmethod
    def _normalize_token(tok, acronyms=None):
        amap = Aligner.SPELLED_ACRONYMS if acronyms is None else acronyms
        key = tok.lower().strip(".,;:!?\"')(")
        plural = key.endswith("'s") or (key.endswith("s")
                                        and key[:-1] in amap)
        base = key.removesuffix("'s").removesuffix("s") if plural else key
        spelled = amap.get(base)
        if spelled:
            parts = spelled.split()
            if plural:
                parts.append("s")
            return parts
        raw = Aligner._token_core(tok)
        auto_alnum = Aligner._auto_alnum_parts(raw)
        if auto_alnum:
            return auto_alnum
        auto_oov = Aligner._auto_oov_segments(raw)
        if auto_oov:
            return auto_oov
        if "/" in tok:
            return tok.replace("/", " forward slash ").split()
        return re.findall(r"[A-Za-z0-9']+", tok)

    @staticmethod
    def _collapse_groups(words, raw_tokens, expanded, group_sizes):
        def core(s):
            return "".join(c for c in s.lower() if c.isalnum() or c == "'")
        group_of = []
        for gi, n in enumerate(group_sizes):
            group_of.extend([gi] * n)
        buckets = [[] for _ in raw_tokens]
        ei = 0
        for w in words:
            wc = core(w["word"])
            for j in range(ei, len(expanded)):
                if core(expanded[j]) == wc or w["word"] == "<unk>":
                    buckets[group_of[j]].append(w)
                    ei = j + 1
                    break
        out = []
        for tok, sub in zip(raw_tokens, buckets):
            if not sub:
                continue
            out.append({"word": tok,
                        "start": sub[0]["start"],
                        "end": sub[-1]["end"]})
        return out

    @staticmethod
    def _restore_orthography(words, transcript):
        def core(s):
            return "".join(c for c in s.lower() if c.isalnum() or c == "'")
        raw_tokens = transcript.split()
        ti = 0
        for w in words:
            if w["word"] == "<unk>":
                if ti < len(raw_tokens):
                    w["word"] = raw_tokens[ti]
                    ti += 1
                continue
            target = core(w["word"])
            if not target:
                continue
            for j in range(ti, len(raw_tokens)):
                if core(raw_tokens[j]) == target:
                    w["word"] = raw_tokens[j]
                    ti = j + 1
                    break

    def _whisperx_align(self, audio_np, duration, transcript, lang: str = "en"):
        if lang not in self._align_models:
            print(f"Loading whisperx alignment model for '{lang}' ...")
            self._align_models[lang] = whisperx.load_align_model(
                language_code=lang, device=DEVICE)
        align_model, align_meta = self._align_models[lang]
        sentence_segments = [{"text": transcript, "start": 0.0, "end": duration}]
        result = whisperx.align(sentence_segments, align_model, align_meta,
                                audio_np, DEVICE, return_char_alignments=False)
        words = []
        for seg in result["segments"]:
            for w in seg.get("words", []):
                if "start" in w and "end" in w:
                    words.append({"word": w["word"], "start": w["start"], "end": w["end"]})
        return words

    def process(self, audio_path: str, transcript: str,
                acronyms: dict | None = None,
                lexeme_hints: dict | None = None,
                lang: str = "en") -> dict:
        audio_np = whisperx.load_audio(audio_path)
        sr = 16000
        duration = len(audio_np) / sr

        amap = dict(Aligner.SPELLED_ACRONYMS)
        for k, v in (acronyms or {}).items():
            amap[k.lower()] = v

        ja_features = {}
        if lang == "ja":
            morphemes = self._tokenize_ja(transcript)
            raw_tokens = [m["surface"] for m in morphemes]
            groups = [[t] for t in raw_tokens]
            for m in morphemes:
                key = Aligner._lex_key(m["surface"])
                if key and key not in ja_features:
                    ja_features[key] = m
        else:
            raw_tokens = transcript.split()
            groups = [self._normalize_token(t, amap) for t in raw_tokens]
        group_sizes = [len(g) for g in groups]
        expanded = [p for g in groups for p in g]
        mfa_transcript = " ".join(expanded)

        words = self._mfa_align(audio_path, mfa_transcript, lang)
        aligner_used = "mfa"
        if words:
            words = self._collapse_groups(
                words, raw_tokens, expanded, group_sizes)
        else:
            print("Falling back to whisperx alignment")
            words = self._whisperx_align(audio_np, duration, transcript, lang)
            aligner_used = "whisperx"
            self._restore_orthography(words, transcript)

        hints = lexeme_hints or {}

        def _hint_for_token(tok):
            key = Aligner._lex_key(tok)
            return hints.get(key, {}) if key else {}

        def _manual_ipa(hint):
            for field in ("ipa_citation", "ipa", "pronunciation"):
                val = hint.get(field)
                if isinstance(val, dict):
                    val = val.get("ipa")
                cleaned = clean_ipa(val) if val else None
                if cleaned:
                    return cleaned
            return None

        def _citation_phonemes(tok):
            if lang == "ja":
                jf = ja_features.get(Aligner._lex_key(tok)) or {}
                # Prefer 発音 (contextual pronunciation) over the citation reading.
                kana = jf.get("pron") or jf.get("reading")
                if kana:
                    conf = "pron" if jf.get("pron") else "reading"
                    return self._phonemize_ja(kana), {
                        "source": "unidic-kana", "confidence": conf}
                return "", {"source": "unidic-kana", "confidence": "no-reading"}
            num_words = _number_words(tok)
            if num_words:
                pieces = [self._phonemize_word(nw) for nw in num_words]
                return "".join(pieces), {
                    "source": "espeak-number",
                    "confidence": "number-words",
                }
            parts = self._normalize_token(tok, amap)
            if len(parts) != 1:
                return "".join(self._phonemize_word(p) for p in parts), {
                    "source": "espeak-expanded", "confidence": "expanded"
                }
            hint = _hint_for_token(tok)
            manual = _manual_ipa(hint)
            if manual:
                return manual, {"source": "manual", "confidence": "manual"}
            return self._phonemize_word(tok), {"source": "espeak", "confidence": "fallback"}

        word_phonemes_str = []
        word_citation_meta = []
        for w in words:
            ph, meta = _citation_phonemes(w["word"])
            word_phonemes_str.append(ph)
            word_citation_meta.append(meta)
        target_tokens = []
        target_stresses = []
        word_token_ranges = []
        for ph_str in word_phonemes_str:
            start = len(target_tokens)
            if ph_str:
                for tid, st in self._greedy_tokenize_stressed(ph_str):
                    target_tokens.append(tid)
                    target_stresses.append(st)
            word_token_ranges.append((start, len(target_tokens)))

        inputs = self.processor(audio_np, sampling_rate=sr, return_tensors="pt")
        with torch.no_grad():
            logits = self.model(inputs.input_values.to(DEVICE)).logits[0]
        log_probs = torch.log_softmax(logits, dim=-1).unsqueeze(0)
        probs = torch.softmax(logits, dim=-1)
        top_probs, pred_ids = probs.max(dim=-1)
        n_frames = log_probs.shape[1]
        frame_dur = duration / n_frames

        def greedy_in_range(f_start, f_end):
            out = []
            prev_id = -1
            for f in range(max(0, f_start), min(f_end, n_frames)):
                pid = int(pred_ids[f])
                if pid == prev_id or pid == self.pad_id:
                    prev_id = pid
                    continue
                if float(top_probs[f]) < GREEDY_CONF:
                    prev_id = pid
                    continue
                sym = self.id2tok.get(pid, "")
                if sym and not sym.startswith("<"):
                    out.append({"p": sym,
                                "start": round(f * frame_dur, 3),
                                "end": round((f + 1) * frame_dur, 3)})
                prev_id = pid
            for i in range(len(out) - 1):
                out[i]["end"] = out[i + 1]["start"]
            return out

        def canon_for_word(tokens, f_start, f_end):
            if not tokens or f_end - f_start < len(tokens):
                return []
            log_probs_slice = log_probs[:, f_start:f_end, :]
            targets = torch.tensor([tokens], dtype=torch.int32)
            try:
                aligned, _ = torchaudio.functional.forced_align(
                    log_probs_slice, targets, blank=self.pad_id)
            except Exception:
                return []
            aligned = aligned[0].tolist()
            out = []
            prev = -1
            tok_pos = -1
            for f_off, tid in enumerate(aligned):
                if tid == self.pad_id:
                    continue
                if tid != prev:
                    tok_pos += 1
                    abs_f = f_start + f_off
                    sym = self.id2tok.get(tid, "")
                    out.append({"p": sym,
                                "start": round(abs_f * frame_dur, 3),
                                "end": round((abs_f + 1) * frame_dur, 3)})
                prev = tid
            for i in range(len(out) - 1):
                out[i]["end"] = out[i + 1]["start"]
            if out:
                out[-1]["end"] = round(f_end * frame_dur, 3)
            return out

        for w_idx, w in enumerate(words):
            s, e = word_token_ranges[w_idx]
            f_start = max(0, int(round(w["start"] / frame_dur)))
            f_end = min(n_frames, int(round(w["end"] / frame_dur)))
            if f_end <= f_start:
                w.update({"ipa": "", "ipa_canonical": "",
                          "phonemes": [], "phonemes_canonical": []})
                continue
            phs_audio = greedy_in_range(f_start, f_end)
            if lang == "ja":
                # Citation phonemes split from the clean IPA, evenly timed —
                # bypasses the English-trained CTC aligner that drops ː and
                # collapses geminates.
                phs_canon = self._ja_even_phonemes(
                    word_phonemes_str[w_idx], w["start"], w["end"])
            else:
                phs_canon = canon_for_word(target_tokens[s:e], f_start, f_end)
                stresses = target_stresses[s:e]
                for ph, st in zip(phs_canon, stresses):
                    if st:
                        ph["stress"] = st
            w["ipa"] = "".join(p["p"] for p in phs_audio)
            w["ipa_canonical"] = word_phonemes_str[w_idx]
            w["ipa_citation_meta"] = word_citation_meta[w_idx]
            w["phonemes"] = phs_audio
            w["phonemes_canonical"] = phs_canon

        for w in words:
            np = len(w.get("phonemes_canonical") or [])
            dur = w["end"] - w["start"]
            acronymish = any(c.isupper() for c in w["word"][1:]) or \
                any(c.isdigit() for c in w["word"])
            if acronymish and np >= 3 and dur > 0 and dur / np < 0.04:
                print(f"WARN short window: {w['word']!r} {dur:.2f}s for "
                      f"{np} phonemes — likely a spelled acronym missing "
                      f"from SPELLED_ACRONYMS")

        pauses = self._extract_prosody(audio_path, words)

        return self._to_v2(words, pauses, duration, aligner_used, lang, ja_features)

    @staticmethod
    def _lex_key(raw):
        return raw.lower().strip(".,;:!?\"')([]{}…—–-")

    @staticmethod
    def _to_v2(words, pauses, duration, aligner_used, lang="en", ja_features=None):
        ja_features = ja_features or {}
        lexicon = {}
        transcript = []
        for i, w in enumerate(words):
            key = Aligner._lex_key(w["word"]) or None
            transcript.append({
                "i": i,
                "raw": w["word"],
                "lex": key,
                "sent": None,
                "start": w["start"],
                "end": w["end"],
                "ipa": w.get("ipa") or "",
                "phonemes": w.get("phonemes") or [],
                "phonemes_citation": w.get("phonemes_canonical") or [],
                "f0_norm": w.get("f0_norm") or [],
                "stress": bool(w.get("stress")),
                "peak": bool(w.get("peak")),
                "is_filler": bool(w.get("is_filler")),
            })
            if key is None:
                continue
            ent = lexicon.get(key)
            if ent is None:
                ent = lexicon[key] = {
                    "key": key, "lemma": key, "surface_forms": [],
                    "ipa_citation": "", "ipa_citation_source": None,
                    "ipa_citation_confidence": None, "ipa_citation_url": None,
                    "ipa_citation_audio_ogg": None, "ipa_citation_audio_mp3": None,
                    "ipa_citation_alternatives": [],
                    "pos": None, "gloss": None,
                    "definition": None, "definition_gloss": None,
                    "note": None, "occurrences": [],
                }
                if lang == "ja":
                    import ja_dict
                    jf = ja_features.get(key) or {}
                    ent["reading"] = jf.get("reading")
                    ent["romaji"] = jf.get("romaji")
                    ent["mora"] = jf.get("mora")
                    ent["pitch_accent"] = (
                        Aligner._ja_pitch_accent(jf.get("mora"), jf.get("a_type"))
                        if jf.get("mora") else None)
                    # Learner-facing romaji + pitch, from 発音 (contextual).
                    ent["mora_pitch"] = Aligner._ja_mora_pitch(
                        jf.get("pron") or jf.get("reading"), jf.get("a_type"))
                    ent["furigana"] = [
                        {"text": t, "ruby": ru}
                        for t, ru in ja_dict.furigana_spans(w["word"], jf.get("reading"))
                    ]
                    if jf.get("lemma"):
                        ent["lemma"] = jf["lemma"]
                    if not ent["gloss"]:
                        ent["gloss"] = ja_dict.lookup_gloss(jf.get("lemma") or key)
                    if jf.get("pos") and not ent["pos"]:
                        ent["pos"] = jf["pos"]
            if w["word"] not in ent["surface_forms"]:
                ent["surface_forms"].append(w["word"])
            if not ent["ipa_citation"] and w.get("ipa_canonical"):
                ent["ipa_citation"] = w["ipa_canonical"]
                meta = w.get("ipa_citation_meta") or {}
                ent["ipa_citation_source"] = meta.get("source")
                ent["ipa_citation_confidence"] = meta.get("confidence")
                ent["ipa_citation_url"] = meta.get("url")
                ent["ipa_citation_audio_ogg"] = meta.get("audio_ogg")
                ent["ipa_citation_audio_mp3"] = meta.get("audio_mp3")
                ent["ipa_citation_alternatives"] = meta.get("alternatives") or []
                if meta.get("pos") and not ent.get("pos"):
                    ent["pos"] = meta.get("pos")
            ent["occurrences"].append(i)

        sentences = []
        start_i = 0
        enders = (".", "!", "?")
        for i, t in enumerate(transcript):
            stripped = t["raw"].rstrip("\"')]}…")
            last = i == len(transcript) - 1
            if (stripped.endswith(enders) or last) and i >= start_i:
                span = [start_i, i]
                sentences.append({
                    "i": len(sentences),
                    "span": span,
                    "text": " ".join(transcript[j]["raw"]
                                      for j in range(start_i, i + 1)),
                    "gloss": None,
                    "note": None,
                })
                for j in range(start_i, i + 1):
                    transcript[j]["sent"] = len(sentences) - 1
                start_i = i + 1

        return {
            "schema_version": 2,
            "session": {
                "id": "", "title": "",
                "duration": duration,
                "lang_src": lang, "lang_gloss": "vi",
                "aligner": aligner_used,
            },
            "lexicon": lexicon,
            "transcript": transcript,
            "sentences": sentences,
            "pauses": pauses,
        }

    @staticmethod
    def _extract_prosody(audio_path, words):
        import re
        import numpy as np
        try:
            import parselmouth
        except ImportError:
            for w in words:
                w["f0_norm"] = None
                w["stress"] = False
                w["peak"] = False
                w["is_filler"] = False
            return []

        snd = parselmouth.Sound(audio_path)
        pitch = snd.to_pitch(time_step=0.01)
        try:
            intensity = snd.to_intensity(time_step=0.01)
        except Exception:
            intensity = None

        times = pitch.xs()
        f0 = pitch.selected_array["frequency"]
        voiced = f0[f0 > 0]
        have_pitch = len(voiced) >= 10
        if have_pitch:
            f0_log = np.log(voiced + 1e-6)
            f0_log_mean = float(f0_log.mean())
            f0_log_std = float(f0_log.std()) or 1.0
        else:
            f0_log_mean = 0.0
            f0_log_std = 1.0

        def intensity_at(t):
            if intensity is None:
                return 0.0
            try:
                v = intensity.get_value(t)
                return float(v) if v is not None and not np.isnan(v) else 0.0
            except Exception:
                return 0.0

        prom_raw = []
        for w in words:
            start = float(w["start"])
            end = float(w["end"])
            dur = end - start
            if dur <= 0 or not have_pitch:
                w["f0_norm"] = None
                prom_raw.append(0.0)
                continue
            edges = np.linspace(start, end, 7)
            bins = []
            for i in range(6):
                bs, be = edges[i], edges[i + 1]
                mask = (times >= bs) & (times < be)
                vals = f0[mask]
                voiced_vals = vals[vals > 0]
                if len(voiced_vals) == 0:
                    bins.append(None)
                    continue
                mean_f0 = float(voiced_vals.mean())
                z = (np.log(mean_f0 + 1e-6) - f0_log_mean) / f0_log_std
                bins.append(round(z, 3))
            voiced_count = sum(1 for x in bins if x is not None)
            w["f0_norm"] = bins if voiced_count >= 1 else None

            n_samples = max(3, int(dur * 100))
            db_vals = [intensity_at(start + i * dur / n_samples) for i in range(n_samples)]
            db_vals = [v for v in db_vals if v > 0]
            rms_db = float(np.mean(db_vals)) if db_vals else 0.0

            voiced_bins = [x for x in bins if x is not None]
            f0_range = (max(voiced_bins) - min(voiced_bins)) if len(voiced_bins) >= 2 else 0.0
            prom_raw.append(rms_db + 5.0 * f0_range)

        prom = np.array(prom_raw, dtype=float)
        if prom.std() > 1e-6:
            prom_z = (prom - prom.mean()) / prom.std()
        else:
            prom_z = np.zeros_like(prom)
        threshold = float(np.percentile(prom_z, 66.67)) if len(prom_z) else 0.0

        pauses = []
        for i in range(len(words) - 1):
            gap_ms = int((words[i + 1]["start"] - words[i]["end"]) * 1000)
            if gap_ms >= 120:
                pauses.append({"after": i, "gap_ms": gap_ms})

        phrase_breaks = sorted({p["after"] for p in pauses if p["gap_ms"] > 350})
        if not phrase_breaks or phrase_breaks[-1] != len(words) - 1:
            phrase_breaks.append(len(words) - 1)

        peak_flags = [False] * len(words)
        phrase_start = 0
        for end_idx in phrase_breaks:
            seg = prom_z[phrase_start:end_idx + 1]
            if len(seg):
                peak_flags[phrase_start + int(np.argmax(seg))] = True
            phrase_start = end_idx + 1

        filler_re = re.compile(r"^(uh|um|er|ah|hmm|huh|mm)$", re.IGNORECASE)
        for i, w in enumerate(words):
            w["stress"] = bool(prom_z[i] >= threshold)
            w["peak"] = bool(peak_flags[i])
            w["is_filler"] = bool(filler_re.match(w["word"].strip(",.!?;:\"'")))

        return pauses


def to_mp3(src_path: str, dst_path: str):
    subprocess.run(["ffmpeg", "-y", "-i", src_path, "-codec:a", "libmp3lame",
                    "-q:a", "2", dst_path],
                   check=True, capture_output=True)
