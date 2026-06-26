import json
from phonemizer import phonemize

with open("words.json") as f:
    data = json.load(f)
words = data["words"]

def ref_ipa(w):
    clean = "".join(c for c in w if c.isalpha() or c == "'")
    if not clean: return ""
    try:
        return phonemize(clean, language="en-us", backend="espeak", strip=True,
                         preserve_punctuation=False, with_stress=False).strip()
    except Exception:
        return ""

print(f"{'#':>3}  {'word':20s}  {'audio IPA':25s}  {'ref IPA':25s}  match")
print("-" * 95)
mismatches = 0
for i, w in enumerate(words):
    audio_ipa = w.get("ipa", "")
    ref = ref_ipa(w["word"])
    match = "✓" if audio_ipa == ref else ("~" if set(audio_ipa) & set(ref) else "✗")
    if audio_ipa != ref: mismatches += 1
    print(f"{i:>3}  {w['word']:20s}  /{audio_ipa:23s}/  /{ref:23s}/  {match}")

print(f"\n{mismatches}/{len(words)} differ from dictionary reference (some are real audio variants).")

print("\nPhoneme duration sanity (should mostly be 30–250ms):")
all_durs = []
for w in words:
    for ph in w.get("phonemes", []):
        d = ph["end"] - ph["start"]
        all_durs.append((d, ph["p"], w["word"]))
all_durs.sort()
print(f"  shortest 5: {all_durs[:5]}")
print(f"  longest  5: {all_durs[-5:]}")
print(f"  median   : {all_durs[len(all_durs)//2][0]*1000:.0f} ms")

print("\nMonotonic timing check (phoneme starts must be non-decreasing):")
prev = -1
bad = 0
for w in words:
    for ph in w.get("phonemes", []):
        if ph["start"] < prev: bad += 1
        prev = ph["start"]
print(f"  out-of-order phonemes: {bad}")
