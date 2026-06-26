# syntax=docker/dockerfile:1

# ---- Stage 1: build the Vite + TypeScript frontend ----
FROM node:20-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---- Stage 2: Python runtime with MFA (conda) ----
FROM mambaorg/micromamba:1.5.8-bookworm-slim AS runtime

ARG MAMBA_DOCKERFILE_ACTIVATE=1
WORKDIR /app

# Base env: python + native deps (ffmpeg for transcoding, espeak-ng for phonemizer)
RUN micromamba install -y -n base -c conda-forge \
        python=3.11 ffmpeg espeak-ng && \
    micromamba clean -ay

# CPU-only torch first so the unpinned torch in requirements is satisfied
# without pulling CUDA wheels, then the remaining Python deps.
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir \
        torch torchaudio --index-url https://download.pytorch.org/whl/cpu && \
    python -m pip install --no-cache-dir -r requirements.txt

# Montreal Forced Aligner in an isolated env (its pins conflict with torch),
# with acoustic model + dictionary baked in for offline runtime.
RUN micromamba create -y -n mfa -c conda-forge montreal-forced-aligner && \
    micromamba clean -ay && \
    micromamba run -n mfa mfa model download acoustic english_mfa && \
    micromamba run -n mfa mfa model download dictionary english_us_mfa

# espeak-ng / MFA wiring — aligner.py reads these from the environment
ENV PHONEMIZER_ESPEAK_LIBRARY=/opt/conda/lib/libespeak-ng.so \
    MFA_BIN=/opt/conda/envs/mfa/bin/mfa \
    MFA_DICT=english_us_mfa \
    MFA_ACOUSTIC=english_mfa \
    HF_HOME=/app/data/.hf_cache

COPY aligner.py server.py ./
COPY scripts ./scripts
COPY samples ./samples
COPY --from=frontend /app/dist ./dist

EXPOSE 7842

# server.py's __main__ binds 127.0.0.1; run uvicorn directly so the
# service is reachable from outside the container.
CMD ["micromamba", "run", "-n", "base", \
     "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7842"]
