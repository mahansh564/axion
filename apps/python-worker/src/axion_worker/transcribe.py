import base64
import os
import tempfile
from pathlib import Path

from axion_worker.settings import settings


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").lower() in ("1", "true", "yes")


def transcribe_audio(*, audio_base64: str, mime_type: str) -> tuple[str, str, str | None]:
    raw = base64.b64decode(audio_base64, validate=True)
    stub = settings.transcribe_stub or _env_truthy("AXION_TRANSCRIBE_STUB")
    if stub:
        return (
            "[stub transcription] audio received",
            "stub",
            None,
        )

    try:
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]
    except ImportError:
        msg = "[no whisper] pip install faster-whisper or set AXION_TRANSCRIBE_STUB=1"
        return (msg, "none", None)

    suffix = ".webm"
    if "wav" in mime_type:
        suffix = ".wav"
    elif "mp4" in mime_type or "mpeg" in mime_type:
        suffix = ".mp4"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(raw)
        path = Path(f.name)
    try:
        model = WhisperModel("base", device="cpu", compute_type="int8")
        segments, info = model.transcribe(str(path))
        text = " ".join(s.text for s in segments).strip()
        lang = info.language
        model_id = f"faster-whisper:{lang or 'unknown'}"
        return text or "(empty transcript)", model_id, lang
    finally:
        path.unlink(missing_ok=True)
