import argparse
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import sample_cache
from sample_cache import find_sample_audio, is_stale, words_path

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=str, default=None)
parser.add_argument("--port", type=int, default=7842)
_args, _unknown = parser.parse_known_args()

if _args.root:
    sample_cache.ROOT = Path(_args.root)
    sample_cache.SAMPLES = sample_cache.ROOT / "samples"

ROOT = sample_cache.ROOT
SAMPLES = sample_cache.SAMPLES
app = FastAPI(title="phonetic-atlas")


@app.get("/api/samples")
def list_samples():
    out = []
    if SAMPLES.exists():
        for d in sorted(SAMPLES.iterdir()):
            if not d.is_dir():
                continue
            meta_path = d / "meta.json"
            transcript_path = d / "transcript.txt"
            audio = find_sample_audio(d)
            if not audio or not transcript_path.exists():
                continue
            meta = {}
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text())
                except Exception:
                    meta = {}
            out.append({
                "id": d.name,
                "title": meta.get("title", d.name.replace("-", " ").title()),
                "description": meta.get("description", ""),
                "level": meta.get("level", ""),
                "duration": meta.get("duration"),
                "transcript": transcript_path.read_text().strip(),
                "audio_url": f"/api/sample-audio/{d.name}",
            })
    return out


@app.get("/api/sample-audio/{sample_id}")
def get_sample_audio(sample_id: str):
    sample_dir = SAMPLES / sample_id
    if not sample_dir.is_dir():
        raise HTTPException(404, "sample not found")
    audio = find_sample_audio(sample_dir)
    if not audio:
        raise HTTPException(404, "sample audio missing")
    media_type = {"mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4", "ogg": "audio/ogg"}[audio.suffix[1:]]
    return FileResponse(audio, media_type=media_type)


@app.get("/api/sample-session/{sample_id}")
def get_sample_session(sample_id: str):
    sample_dir = SAMPLES / sample_id
    if not sample_dir.is_dir():
        raise HTTPException(404, "sample not found")
    transcript_path = sample_dir / "transcript.txt"
    audio = find_sample_audio(sample_dir)
    if not audio or not transcript_path.exists():
        raise HTTPException(404, "sample missing audio or transcript")
    if not words_path(sample_dir).exists():
        raise HTTPException(404, "sample has not been preprocessed")

    return {
        "session_id": sample_id,
        "words_url": f"/api/words/{sample_id}",
        "audio_url": f"/api/sample-audio/{sample_id}",
        "stale": is_stale(sample_dir),
    }


@app.get("/api/words/{sample_id}")
def get_words(sample_id: str):
    sample_dir = SAMPLES / sample_id
    p = words_path(sample_dir)
    if not p.exists():
        raise HTTPException(404)
    return JSONResponse(json.loads(p.read_text()))


DIST = ROOT / "dist"


@app.get("/")
def index():
    dist_index = DIST / "index.html"
    if not dist_index.exists():
        raise HTTPException(503, "frontend not built — run `npm run build`")
    return FileResponse(dist_index)


(DIST / "assets").mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")
app.mount("/static", StaticFiles(directory=str(ROOT)), name="static")


DEFAULT_PORT = 7842

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=_args.port, reload=False)
