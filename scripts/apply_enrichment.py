import json
import sys
from pathlib import Path

import jsonschema

SCHEMA = json.load(open("schemas/transcript.schema.json"))
LEX_FIELDS = ("lemma", "pos", "ipa_citation", "ipa_citation_source",
              "ipa_citation_confidence", "ipa_citation_url",
              "ipa_citation_audio_ogg", "ipa_citation_audio_mp3",
              "ipa_citation_alternatives", "gloss", "definition",
              "definition_gloss", "note")


def main():
    slug, enrich_path = sys.argv[1], sys.argv[2]
    wp = Path("samples") / slug / "words.json"
    d = json.loads(wp.read_text())
    enr = json.loads(Path(enrich_path).read_text())

    lex_in = enr.get("lexemes", {})
    miss = [k for k in lex_in if k not in d["lexicon"]]
    if miss:
        print(f"WARN unknown lexeme keys ignored: {miss[:10]}")
    for key, ent in d["lexicon"].items():
        e = lex_in.get(key)
        if not e:
            continue
        for f in LEX_FIELDS:
            if e.get(f) is not None:
                ent[f] = e[f]
        if e.get("ipa_citation") and not e.get("ipa_citation_source"):
            ent["ipa_citation_source"] = "manual"
            ent["ipa_citation_confidence"] = ent.get("ipa_citation_confidence") or "manual"

    sent_in = enr.get("sentences", {})
    for s in d["sentences"]:
        e = sent_in.get(str(s["i"]))
        if not e:
            continue
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

    jsonschema.validate(d, SCHEMA)
    wp.write_text(json.dumps(d, ensure_ascii=False, indent=2))
    enriched = sum(1 for v in d["lexicon"].values() if v["gloss"])
    glossed = sum(1 for s in d["sentences"] if s["gloss"])
    print(f"{slug}: {enriched}/{len(d['lexicon'])} lexemes, "
          f"{glossed}/{len(d['sentences'])} sentences enriched; schema OK")


if __name__ == "__main__":
    main()
