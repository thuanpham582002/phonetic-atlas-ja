#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "samples"


def load_words(sample_dir: Path) -> dict[str, Any] | None:
    p = sample_dir / "words.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def summarize(sample_names: list[str] | None = None) -> dict[str, Any]:
    sample_dirs = [SAMPLES / n for n in sample_names] if sample_names else [d for d in sorted(SAMPLES.iterdir()) if d.is_dir()]
    total_lexemes = 0
    by_source: Counter[str] = Counter()
    by_confidence: Counter[str] = Counter()
    issues: dict[str, list[dict[str, Any]]] = defaultdict(list)
    samples: dict[str, dict[str, Any]] = {}

    for d in sample_dirs:
        data = load_words(d)
        if not data:
            continue
        sample_sources: Counter[str] = Counter()
        sample_conf: Counter[str] = Counter()
        lexicon = data.get("lexicon", {})
        total_lexemes += len(lexicon)
        for key, ent in lexicon.items():
            source = ent.get("ipa_citation_source") or "unknown"
            confidence = ent.get("ipa_citation_confidence") or "unknown"
            by_source[source] += 1
            by_confidence[confidence] += 1
            sample_sources[source] += 1
            sample_conf[confidence] += 1
            item = {
                "sample": d.name,
                "key": key,
                "ipa": ent.get("ipa_citation"),
                "pos": ent.get("pos"),
                "source": source,
                "confidence": confidence,
                "url": ent.get("ipa_citation_url"),
                "alternatives": ent.get("ipa_citation_alternatives") or [],
            }
            if not ent.get("ipa_citation"):
                issues["missing_ipa"].append(item)
            if source in {"espeak", "unknown"}:
                issues["fallback_espeak_or_unknown"].append(item)
            if confidence == "ambiguous-default":
                issues["ambiguous_default"].append(item)
        samples[d.name] = {
            "lexemes": len(lexicon),
            "sources": dict(sample_sources),
            "confidences": dict(sample_conf),
        }

    return {
        "total_lexemes": total_lexemes,
        "sources": dict(by_source),
        "confidences": dict(by_confidence),
        "issues": dict(issues),
        "samples": samples,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Report IPA citation sources/fallbacks for processed samples.")
    ap.add_argument("samples", nargs="*", help="sample slugs; defaults to all samples")
    ap.add_argument("--json", action="store_true", help="print full JSON report")
    args = ap.parse_args()

    report = summarize(args.samples or None)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    print(f"lexemes: {report['total_lexemes']}")
    print("sources:")
    for k, v in sorted(report["sources"].items(), key=lambda x: (-x[1], x[0])):
        print(f"  {k:24} {v}")
    print("confidences:")
    for k, v in sorted(report["confidences"].items(), key=lambda x: (-x[1], x[0])):
        print(f"  {k:24} {v}")
    for name in ["ambiguous_default", "fallback_espeak_or_unknown", "missing_ipa"]:
        rows = report["issues"].get(name, [])
        print(f"{name}: {len(rows)}")
        for row in rows[:50]:
            alts = row.get("alternatives") or []
            alt = f" alternatives={[(a.get('pos'), a.get('ipa')) for a in alts]}" if alts else ""
            print(f"  {row['sample']}: {row['key']} /{row.get('ipa') or ''}/ pos={row.get('pos')} source={row['source']} confidence={row['confidence']}{alt}")


if __name__ == "__main__":
    main()
