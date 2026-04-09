import base64
import logging
import uuid
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from axion_worker.extract import ProviderConfigError, ProviderRuntimeError, extract_structured
from axion_worker.transcribe import ProviderConfigError as TranscribeProviderConfigError
from axion_worker.transcribe import transcribe_audio

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("axion.worker")

app = FastAPI(title="Axion Python Worker", version="0.1.0")


class TranscribeBody(BaseModel):
    audio_base64: str
    mime_type: str
    trace_id: str | None = None


class TranscribeOut(BaseModel):
    text: str
    model_id: str
    language: str | None = None


class ExtractBody(BaseModel):
    document_id: str
    text: str
    trace_id: str | None = None


class ExtractOut(BaseModel):
    model_id: str
    entities: list[dict[str, Any]] = Field(default_factory=list)
    relations: list[dict[str, Any]] = Field(default_factory=list)
    emotion: dict[str, Any] | None = None
    uncertainty: dict[str, Any] | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/transcribe", response_model=TranscribeOut)
def transcribe(
    body: TranscribeBody, x_trace_id: str | None = Header(default=None)
) -> TranscribeOut:
    trace = body.trace_id or x_trace_id or str(uuid.uuid4())
    log.info('{"event":"transcribe_start","trace_id":"%s"}', trace)
    try:
        base64.b64decode(body.audio_base64, validate=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid base64: {e}") from e
    try:
        text, model_id, language = transcribe_audio(
            audio_base64=body.audio_base64, mime_type=body.mime_type
        )
    except TranscribeProviderConfigError as e:
        log.error(
            '{"event":"transcribe_provider_config_error","trace_id":"%s","error":"%s"}',
            trace,
            str(e),
        )
        raise HTTPException(status_code=500, detail=str(e)) from e
    log.info('{"event":"transcribe_done","trace_id":"%s","model_id":"%s"}', trace, model_id)
    return TranscribeOut(text=text, model_id=model_id, language=language)


@app.post("/extract", response_model=ExtractOut)
async def extract(body: ExtractBody, x_trace_id: str | None = Header(default=None)) -> ExtractOut:
    trace = body.trace_id or x_trace_id or str(uuid.uuid4())
    log.info(
        '{"event":"extract_start","trace_id":"%s","document_id":"%s"}', trace, body.document_id
    )
    try:
        data = await extract_structured(document_id=body.document_id, text=body.text)
    except ProviderConfigError as e:
        log.error(
            '{"event":"extract_provider_config_error","trace_id":"%s","error":"%s"}',
            trace,
            str(e),
        )
        raise HTTPException(status_code=500, detail=str(e)) from e
    except ProviderRuntimeError as e:
        log.error(
            '{"event":"extract_provider_runtime_error","trace_id":"%s","error":"%s"}',
            trace,
            str(e),
        )
        raise HTTPException(status_code=503, detail=str(e)) from e
    log.info('{"event":"extract_done","trace_id":"%s"}', trace)
    return ExtractOut(**data)
