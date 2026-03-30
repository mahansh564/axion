# Axion Python worker

FastAPI service for transcription and structured extraction.

**pip** (from repo root or this directory):

```bash
cd apps/python-worker
python3 -m pip install -e ".[dev]"
```

**uv**:

```bash
cd apps/python-worker
uv sync --extra dev
```

Optional local transcription model: add `--extra whisper` / `pip install -e ".[dev,whisper]"`.

Run:

```bash
cd apps/python-worker
python3 -m uvicorn axion_worker.main:app --host 127.0.0.1 --port 8000 --app-dir src
```

Environment: see repo root `.env.example` (`WORKER_PORT`, `AXION_TRANSCRIBE_STUB`, `OLLAMA_*`).
