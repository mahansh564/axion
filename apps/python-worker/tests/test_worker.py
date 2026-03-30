import base64
import os

from fastapi.testclient import TestClient

os.environ["AXION_TRANSCRIBE_STUB"] = "1"

from axion_worker.main import app  # noqa: E402

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


def test_extract_stub_fallback() -> None:
    r = client.post(
        "/extract",
        json={"document_id": "doc-1", "text": "Maybe Berlin is interesting and Paris too."},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["model_id"]
    assert isinstance(body["entities"], list)
