# Axion

Personal research and experience memory system. This repository is a **Turborepo + pnpm** monorepo with a **Node** HTTP API (`apps/api`) and a **Python** worker (`apps/python-worker`) for transcription and extraction.

## Prerequisites

- Node 20+ and [pnpm](https://pnpm.io/) 9+
- Python 3.11+ (for the worker)

## Install

```bash
pnpm install
```

The Python worker uses a local `.venv` under `apps/python-worker` (created automatically when you run `pnpm --filter @axion/python-worker test` or `lint`, or run `bash apps/python-worker/scripts/ensure-venv.sh`).

## Configuration

Copy `.env.example` to `.env` in the repo root (or set variables in your shell). Important variables:

| Variable | Purpose |
|----------|---------|
| `DATA_DIR` | SQLite database and audio blobs (default `./data`) |
| `API_PORT` | API listen port (default `3000`) |
| `PYTHON_WORKER_URL` | Base URL for the Python worker (default `http://127.0.0.1:8000`) |
| `API_KEY` | If set, protects all routes except `GET /health` and `GET /ready` (`Authorization: Bearer <key>`) |
| `MAX_UPLOAD_BYTES` | Multipart upload cap |
| `AXION_TRANSCRIBE_STUB` | Set to `1` on the worker to skip faster-whisper (tests / CI) |

## Run locally (startup order)

1. **Python worker** — from `apps/python-worker`:

   ```bash
   pnpm dev
   ```

   Or: `bash scripts/ensure-venv.sh && .venv/bin/python -m uvicorn axion_worker.main:app --host 127.0.0.1 --port 8000`

2. **API** — from repo root:

   ```bash
   pnpm --filter @axion/api dev
   ```

   The API runs migrations on startup and serves:

   - `GET /health` — process OK
   - `GET /ready` — SQLite OK + worker `/health` reachable
   - `POST /experiences/voice` — multipart audio → transcript → graph + episodic events
   - `GET /experiences/:id`, `GET /documents/:id`
   - `POST /qa` — keyword retrieval + optional 1-hop graph; citations and confidence in JSON body

Structured logs use `pino`; each response includes `x-trace-id`, propagated to the worker as `x-trace-id`.

## Repo layout

| Path | Role |
|------|------|
| `apps/api` | Fastify + Drizzle + SQLite |
| `apps/python-worker` | FastAPI: `/transcribe`, `/extract` |
| `packages/contracts` | JSON Schemas for request/response shapes |

## CI / verification

```bash
pnpm turbo run lint typecheck test build
```

See [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Demo script

After both services are up:

```bash
./scripts/demo.sh
```

Requires `curl` and a small fake audio file is generated for upload.
