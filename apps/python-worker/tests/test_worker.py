import base64
import os

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from pytest import MonkeyPatch

os.environ["AXION_TRANSCRIBE_STUB"] = "1"
os.environ["AXION_LLM_PROVIDER"] = "stub"

from axion_worker.main import app  # noqa: E402
from axion_worker.settings import Settings, settings  # noqa: E402
from axion_worker.transcribe import (  # noqa: E402
    FasterWhisperTranscriptionProvider,
    ProviderConfigError,
)

client = TestClient(app)


def test_health() -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_transcribe_stub() -> None:
    audio_b64 = base64.b64encode(b"\x00\x01").decode()
    r = client.post("/transcribe", json={"audio_base64": audio_b64, "mime_type": "audio/wav"})
    assert r.status_code == 200
    body = r.json()
    assert "text" in body
    assert body["model_id"] == "stub"


def test_transcribe_provider_config_error_returns_500(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("AXION_TRANSCRIBE_STUB", "0")
    monkeypatch.setattr(settings, "transcribe_stub", False)
    monkeypatch.setattr(settings, "transcribe_provider", "faster-whisper")

    def raise_provider_config_error(
        self: object, *, raw: bytes, mime_type: str
    ) -> tuple[str, str, str | None]:
        del self, raw, mime_type
        raise ProviderConfigError("faster-whisper provider unavailable")

    monkeypatch.setattr(
        FasterWhisperTranscriptionProvider,
        "transcribe",
        raise_provider_config_error,
    )

    audio_b64 = base64.b64encode(b"\x00\x01").decode()
    r = client.post("/transcribe", json={"audio_base64": audio_b64, "mime_type": "audio/wav"})
    assert r.status_code == 500
    body = r.json()
    assert "faster-whisper provider unavailable" in body["detail"]


def test_extract_stub_fallback() -> None:
    r = client.post(
        "/extract",
        json={"document_id": "doc-1", "text": "Maybe Berlin is interesting and Paris too."},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["model_id"]
    assert isinstance(body["entities"], list)


def test_extract_openai_provider_without_key_returns_config_error(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "llm_provider", "openai")
    monkeypatch.setattr(settings, "openai_api_key", None)
    r = client.post(
        "/extract",
        json={"document_id": "doc-2", "text": "Perhaps this needs cloud extraction."},
    )
    assert r.status_code == 500
    body = r.json()
    assert "OPENAI_API_KEY" in body["detail"]


def test_settings_reject_unknown_providers() -> None:
    with pytest.raises(ValidationError):
        Settings(transcribe_provider="bogus")
    with pytest.raises(ValidationError):
        Settings(llm_provider="bogus")
