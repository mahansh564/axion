# Axion

Personal research and experience memory system. This repository is a **Turborepo + pnpm** monorepo with a **Node** HTTP API (`apps/api`), a **React + Vite** web UI (`apps/web`), and a **Python** worker (`apps/python-worker`) for transcription and extraction.

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
| `WEB_APP_URL` | URL used by API compatibility redirects for visualization paths (`http://127.0.0.1:5173` default) |
| `MAX_UPLOAD_BYTES` | Multipart upload cap |
| `VITE_API_BASE_URL` | API base URL for `apps/web` (default `http://127.0.0.1:3000`) |
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
   - `POST /experiences/conversation` — JSON body (`text`, optional `channel`: `conversation` \| `manual_log`, optional `title`) → stored log → same extraction + graph path as voice (no audio)
   - `POST /experiences/highlights` — JSON body (`highlight`, optional `annotation`, optional `source_kind`, optional `source_ref`, optional `mattered_score`) → highlight/annotation ingestion with mattered weighting metadata
   - `POST /experiences/social` — JSON body (`text`, `person`, optional `relationship`, optional `credibility`) → trusted social log + credibility-linked person edges
   - `GET /reflections/prompts` — Stage 6 daily reflection prompts for structured capture
   - `POST /experiences/reflections` — JSON body (`prompt`, `response`, optional `mood`, optional `mattered_score`) → structured reflection ingestion
   - `POST /research/runs` — create a queued research task/run for manual execution triggers
   - `POST /research/runs/:id/execute` — execute a queued research run through plan/search/fetch steps
   - `GET /runs/:id/replay` — inspect stored run/task/step/artifact/event state for a research run
   - `GET /runs/:id/observations` — inspect observer-generated candidate notes for a research run
   - `POST /promotion/:id/approve` — store approval or rejection decisions for observer notes
   - `POST /synthesis/runs` — promote approved `candidate_belief` observer notes into append-only canonical beliefs
   - `GET /beliefs/timeline` — belief history (optionally filter by `topic`)
   - `GET /beliefs/subgraph` — graph explorer subgraph (filters: `topic`, `time_from`, `time_to`, `confidence_min`)
   - `GET /beliefs/:id/evidence` — evidence supporting a belief (observer note/artifact/document links)
   - `GET /beliefs/uncertainty` — unresolved open questions + low-confidence active beliefs
   - `GET /contradiction-candidates` — Stage 5 contradiction candidates from active belief conflicts + observer contradiction flags
   - `POST /contradictions/resolve` — resolve a contradiction candidate with belief invalidation, superseding belief creation, or keep-both audit-only decisions
   - `GET /contradictions/resolutions` — audit trail of contradiction resolutions (filterable by `candidate_id`)
   - `GET /curiosity/suggestions` — ranked Stage 5 curiosity suggestions (research tasks + reflection prompts) from dormant open questions, recurring uncertainty signals, and repeated confusion phrases
   - `GET /timeline/events` — merged belief + major ingest/research timeline markers for visualization
   - `POST /beliefs/aggregate-stances` — derive low-confidence stance beliefs from transcript language
   - `POST /open-questions` / `GET /open-questions` / `PATCH /open-questions/:id` — open-question lifecycle + optional research-task linkage
   - `GET /experiences/:id`, `GET /documents/:id`
   - `POST /qa` — blended experience + research retrieval with source-labeled citations, confidence, and gaps

Structured logs use `pino`; each response includes `x-trace-id`, propagated to the worker as `x-trace-id`.

3. **Web UI** — from repo root:

   ```bash
   pnpm --filter @axion/web dev
   ```

   The web UI serves Stage 4 visualization routes:

   - `/beliefs/graph`
   - `/beliefs/timeline`
   - `/runs/:runId/replay`

   Compatibility note:
   - Hitting `http://127.0.0.1:3000/beliefs/graph` (and related legacy view URLs) now redirects to `WEB_APP_URL`.

## Repo layout

| Path | Role |
|------|------|
| `apps/api` | Fastify + Drizzle + SQLite |
| `apps/web` | React + Vite + Tailwind + shadcn-style visualization UI |
| `apps/python-worker` | FastAPI: `/transcribe`, `/extract` |
| `packages/contracts` | JSON Schemas for request/response shapes |

## CI / verification

```bash
pnpm turbo run lint typecheck test build
```

See [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Golden Eval Dataset (Stage 6)

Stage 6 includes a deterministic golden Q&A dataset (50 cases) and an automated eval runner for regression tracking.

From `apps/api`:

```bash
pnpm eval:seed   # sync dataset into evaluation_golden_cases
pnpm eval:run    # seed deterministic eval fixtures, run /qa cases, persist evaluation_runs + report JSON
pnpm eval:trend  # write latest trend snapshot from evaluation_runs
```

Reports are written under `DATA_DIR/eval/`:
- `latest-report.json`
- `trend.json`

CI runs `pnpm --filter @axion/api eval:run` on pull requests and nightly schedule, then uploads reports as workflow artifacts.

## Demo script

After both services are up:

```bash
./scripts/demo.sh
```

Requires `curl` and a small fake audio file is generated for upload.
