import json
import pathlib
import sys
from difflib import SequenceMatcher

import jsonschema

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import sample_cache

SAMPLES = pathlib.Path("samples")
SCHEMA = json.load(open("schemas/transcript.schema.json"))


def sim(a, b):
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def main():
    failures = []
    for d in sorted(SAMPLES.iterdir()):
        tp = d / "transcript.txt"
        au = sample_cache.find_sample_audio(d)
        if not tp.exists() or not au:
            continue
        wp = sample_cache.words_path(d)
        if not wp.exists():
            failures.append(f"{d.name}: missing words.json")
            continue
        if sample_cache.is_stale(d):
            failures.append(f"{d.name}: stale words.json")
            continue
        data = json.loads(wp.read_text())
        try:
            jsonschema.validate(data, SCHEMA)
        except jsonschema.ValidationError as e:
            failures.append(f"{d.name}: schema fail: {e.message}")
            continue
        lex = data.get("lexicon", {})
        scored = []
        missing_citation = 0
        for t in data.get("transcript", []):
            ent = lex.get(t.get("lex")) if t.get("lex") else None
            cit = ent.get("ipa_citation") if ent else ""
            if not cit:
                missing_citation += 1
                continue
            scored.append((t["raw"], sim(t.get("ipa", ""), cit)))
        avg = sum(s for _, s in scored) / len(scored) if scored else 0
        bad = [(w, round(s, 2)) for w, s in scored if s < 0.34]
        flag = "  <-- LOW" if avg < 0.55 else ""
        print(f"{d.name:24} avg_sim={avg:.2f} bad={len(bad)}/{len(scored)} "
              f"missing_citation={missing_citation}{flag}")
        if bad:
            print("   worst:", bad[:12])
    if failures:
        print("\nFAILURES:")
        for f in failures:
            print("  " + f)
        raise SystemExit(1)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
