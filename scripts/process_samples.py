import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import jsonschema

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sample_cache import (
    ALIGNER_VERSION,
    SAMPLES,
    apply_enrichment,
    effective_acronyms,
    find_sample_audio,
    is_stale,
    manifest_path,
    sample_fingerprint,
    sample_lang,
    words_path,
)

SCHEMA = json.loads((ROOT / "schemas/transcript.schema.json").read_text())


def to_mp3(src: Path, dst: Path):
    if src.suffix.lower() == ".mp3":
        if src != dst:
            shutil.copy(src, dst)
        return
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-codec:a", "libmp3lame", "-q:a", "2", str(dst)],
        check=True,
    )


def sample_dirs(names: list[str]) -> list[Path]:
    if names:
        return [SAMPLES / name for name in names]
    return [d for d in sorted(SAMPLES.iterdir()) if d.is_dir()]


def adopt_external(audio_src: Path, transcript_src: Path, slug: str) -> Path:
    """Create samples/<slug>/ from external audio + transcript files."""
    sample_dir = SAMPLES / slug
    sample_dir.mkdir(parents=True, exist_ok=True)
    audio_dst = sample_dir / f"audio{audio_src.suffix.lower()}"
    if audio_src.suffix.lower() == ".mp3":
        shutil.copy(audio_src, audio_dst)
    else:
        # Convert to mp3 so find_sample_audio picks it up consistently.
        to_mp3(audio_src, sample_dir / "audio.mp3")
    transcript_dst = sample_dir / "transcript.txt"
    shutil.copy(transcript_src, transcript_dst)
    return sample_dir


def process_sample(aligner: Any, sample_dir: Path, force: bool) -> str:
    if not sample_dir.is_dir():
        raise FileNotFoundError(f"sample not found: {sample_dir.name}")
    transcript_path = sample_dir / "transcript.txt"
    audio = find_sample_audio(sample_dir)
    if not audio or not transcript_path.exists():
        raise FileNotFoundError(f"sample missing audio or transcript: {sample_dir.name}")

    wp = words_path(sample_dir)
    if wp.exists() and not force and not is_stale(sample_dir):
        return f"{sample_dir.name:24}  cached"

    fp = sample_fingerprint(sample_dir)
    transcript = transcript_path.read_text().strip()
    acr = effective_acronyms(sample_dir)
    enrichment_path = sample_dir / "enrichment.json"
    lexeme_hints = {}
    if enrichment_path.exists():
        try:
            lexeme_hints = json.loads(enrichment_path.read_text()).get("lexemes", {})
        except (OSError, ValueError) as e:
            print(f"enrichment hints not loaded ({enrichment_path}): {e}")
    result = aligner.process(str(audio), transcript, acronyms=acr,
                             lexeme_hints=lexeme_hints,
                             lang=sample_lang(sample_dir))
    result["session"]["id"] = sample_dir.name
    result["session"]["title"] = sample_dir.name
    apply_enrichment(result, sample_dir)
    jsonschema.validate(result, SCHEMA)
    wp.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    manifest_path(sample_dir).write_text(json.dumps({
        "fingerprint": fp,
        "aligner_version": ALIGNER_VERSION,
    }, indent=2))

    lex = len(result.get("lexicon", {}))
    tok = len(result.get("transcript", []))
    sent = len(result.get("sentences", []))
    return f"{sample_dir.name:24}  fp={fp} lex={lex} tok={tok} sent={sent}"


def main():
    parser = argparse.ArgumentParser(
        description="Preprocess sample audio into samples/<slug>/words.json.")
    parser.add_argument("samples", nargs="*", help="sample slugs; defaults to all samples")
    parser.add_argument("--force", action="store_true", help="overwrite existing words.json even if fresh")
    parser.add_argument("--from", dest="audio_src", help="external audio file to adopt as a new sample")
    parser.add_argument("--transcript", help="external transcript.txt to pair with --from")
    parser.add_argument("--as", dest="slug", help="slug to assign the adopted sample (becomes samples/<slug>/)")
    args = parser.parse_args()

    if args.audio_src or args.transcript or args.slug:
        if not (args.audio_src and args.transcript and args.slug):
            parser.error("--from, --transcript, and --as must all be provided together")
        sample_dir = adopt_external(Path(args.audio_src), Path(args.transcript), args.slug)
        targets = [sample_dir]
    else:
        targets = sample_dirs(args.samples)

    from aligner import Aligner

    aligner = Aligner()
    for sample_dir in targets:
        try:
            print(process_sample(aligner, sample_dir, args.force))
        except Exception as e:
            print(f"{sample_dir.name:24} ERROR {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
