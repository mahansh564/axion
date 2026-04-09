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

Environment: see repo root `.env.example`.

- `AXION_TRANSCRIBE_PROVIDER`: `faster-whisper` (default) or `stub`.
- `AXION_TRANSCRIBE_STUB=1`: hard override to force stub transcription (CI/tests).
- `AXION_LLM_PROVIDER`: `ollama` (default), `openai`, or `stub`.
- `OLLAMA_*`: local extraction model settings.
- `OPENAI_*`: optional cloud extraction settings used when `AXION_LLM_PROVIDER=openai` (`OPENAI_API_KEY` required).
