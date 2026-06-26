import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).parent
SAMPLES = ROOT / "samples"

ALIGNER_VERSION = "v22-ja-mfa-ctc-align"
ACRONYMS_FILE = Path(os.environ.get("ACRONYMS_FILE", str(ROOT / "acronyms.json")))
AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".ogg")


def find_sample_audio(sample_dir: Path) -> Path | None:
    return next((sample_dir / f"audio{ext}" for ext in AUDIO_EXTS
                 if (sample_dir / f"audio{ext}").exists()), None)


def sample_lang(sample_dir: Path) -> str:
    """Source language for a sample, from meta.json `lang` (default 'en')."""
    meta_path = sample_dir / "meta.json"
    if not meta_path.exists():
        return "en"
    try:
        return str(json.loads(meta_path.read_text()).get("lang") or "en").lower()
    except (OSError, ValueError):
        return "en"


def load_acronyms(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return {str(k).lower(): str(v)
                for k, v in json.loads(path.read_text()).items()}
    except (OSError, ValueError) as e:
        print(f"acronyms map not loaded ({path}): {e}")
        return {}


def effective_acronyms(sample_dir: Path) -> dict:
    merged = load_acronyms(ACRONYMS_FILE)
    merged.update(load_acronyms(sample_dir / "acronyms.json"))
    return merged


def sample_fingerprint(sample_dir: Path) -> str:
    """Hash of (audio bytes, transcript, aligner version, acronyms, enrichment).

    Stored inside `manifest.json` next to `words.json` so we can detect stale
    caches without using the hash as a directory name. Twelve hex chars.
    """
    transcript_path = sample_dir / "transcript.txt"
    audio = find_sample_audio(sample_dir)
    if not audio or not transcript_path.exists():
        raise FileNotFoundError("sample missing audio or transcript")

    h = hashlib.sha256()
    h.update(audio.read_bytes())
    h.update(b"\x00")
    h.update(transcript_path.read_text().strip().encode("utf-8"))
    h.update(b"\x00")
    h.update(ALIGNER_VERSION.encode("utf-8"))
    h.update(b"\x00")
    h.update(sample_lang(sample_dir).encode("utf-8"))
    h.update(b"\x00")
    h.update(json.dumps(effective_acronyms(sample_dir), sort_keys=True).encode("utf-8"))
    h.update(b"\x00")
    enrichment = sample_dir / "enrichment.json"
    if enrichment.exists():
        h.update(enrichment.read_text().strip().encode("utf-8"))
    return h.hexdigest()[:12]


def words_path(sample_dir: Path) -> Path:
    return sample_dir / "words.json"


def manifest_path(sample_dir: Path) -> Path:
    return sample_dir / "manifest.json"


def is_stale(sample_dir: Path) -> bool:
    """True if the cached words.json was built from different inputs than now."""
    mp = manifest_path(sample_dir)
    if not mp.exists():
        return True
    try:
        manifest = json.loads(mp.read_text())
    except (OSError, ValueError):
        return True
    return manifest.get("fingerprint") != sample_fingerprint(sample_dir)


def apply_enrichment(result: dict, sample_dir: Path) -> dict:
    p = sample_dir / "enrichment.json"
    if not p.exists():
        return result
    try:
        enr = json.loads(p.read_text())
    except (OSError, ValueError) as e:
        print(f"enrichment not loaded ({p}): {e}")
        return result
    fields = ("lemma", "pos", "ipa_citation", "ipa_citation_source",
              "ipa_citation_confidence", "ipa_citation_url",
              "ipa_citation_audio_ogg", "ipa_citation_audio_mp3",
              "ipa_citation_alternatives", "gloss", "definition",
              "definition_gloss", "note")
    for key, ent in result.get("lexicon", {}).items():
        e = enr.get("lexemes", {}).get(key)
        if e:
            for f in fields:
                if e.get(f) is not None:
                    ent[f] = e[f]
            if e.get("ipa_citation") and not e.get("ipa_citation_source"):
                ent["ipa_citation_source"] = "manual"
                ent["ipa_citation_confidence"] = ent.get("ipa_citation_confidence") or "manual"
    for s in result.get("sentences", []):
        e = enr.get("sentences", {}).get(str(s["i"]))
        if e:
            gloss = e.get("gloss")
            if isinstance(gloss, dict):
                gloss = gloss.get("gloss")
            if gloss is not None:
                s["gloss"] = gloss
            note = e.get("note")
            if isinstance(note, dict):
                note = note.get("note")
            if note is not None:
                s["note"] = note
    return result
