import json
import whisperx

AUDIO = "Generated Audio May 10, 2026 - 11_02PM.wav"
DEVICE = "cpu"
LANG = "en"

TRANSCRIPT = (
    "Last weekend, I finally visited my grandparents after months of being busy with work. "
    "They were really pleased to see me and said they had missed our long conversations. "
    "We talked about everything, from family news to old memories that we had almost forgotten. "
    "In the afternoon, we walked around the neighborhood and picked some fruit from the garden. "
    "By the end of the day, I felt completely relaxed and truly enjoyed the simple moments with them."
)

audio = whisperx.load_audio(AUDIO)
duration = len(audio) / 16000

segments = [{"text": TRANSCRIPT, "start": 0.0, "end": duration}]

model_a, metadata = whisperx.load_align_model(language_code=LANG, device=DEVICE)
result = whisperx.align(segments, model_a, metadata, audio, DEVICE, return_char_alignments=False)

words = []
for seg in result["segments"]:
    for w in seg.get("words", []):
        if "start" in w and "end" in w:
            words.append({"word": w["word"], "start": w["start"], "end": w["end"]})

with open("words.json", "w") as f:
    json.dump({"audio": AUDIO, "words": words}, f, indent=2)

with open("subtitles.srt", "w") as f:
    for i, w in enumerate(words, 1):
        def t(s):
            h = int(s // 3600); m = int(s % 3600 // 60); sec = s % 60
            return f"{h:02d}:{m:02d}:{sec:06.3f}".replace(".", ",")
        f.write(f"{i}\n{t(w['start'])} --> {t(w['end'])}\n{w['word']}\n\n")

print(f"Aligned {len(words)} words. Wrote words.json and subtitles.srt")
