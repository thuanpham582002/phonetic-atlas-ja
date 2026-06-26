"""Standalone uvicorn launcher for the bundled .app.

For `cargo tauri dev`, lib.rs spawns `.venv/bin/python -m uvicorn server:app`
directly from the repo. For a packaged macOS .app this file would be the entry
point built by pyinstaller into Tauri's `bundle.externalBin`. Bundling is out
of scope for v0.1; this file documents the contract so phase 3 can pick it up.

Contract: prints `LISTENING_PORT=<port>` on stdout once uvicorn is ready, then
runs until killed. Tauri parses that line and points the WebView at it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent.parent
    os.chdir(repo_root)
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    import uvicorn  # type: ignore

    port = int(os.environ.get("PHONETIC_ATLAS_PORT", "7842"))
    print(f"LISTENING_PORT={port}", flush=True)
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=False)


if __name__ == "__main__":
    main()
