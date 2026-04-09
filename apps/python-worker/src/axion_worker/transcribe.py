import base64
import os
import tempfile
from pathlib import Path
from typing import Protocol

from axion_worker.settings import settings


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").lower() in ("1", "true", "yes")


class ProviderConfigError(Exception):
    pass


class TranscriptionProvider(Protocol):
    def transcribe(self, *, raw: bytes, mime_type: str) -> tuple[str, str, str | None]: ...


class StubTranscriptionProvider:
    def transcribe(self, *, raw: bytes, mime_type: str) -> tuple[str, str, str | None]:
        del raw, mime_type
        return (
            "[stub transcription] audio received",
            "stub",
            None,
        )


class FasterWhisperTranscriptionProvider:
    def transcribe(self, *, raw: bytes, mime_type: str) -> tuple[str, str, str | None]:
        try:
            from faster_whisper import WhisperModel  # type: ignore[import-not-found]
        except ImportError:
            msg = (
                "faster-whisper provider unavailable: install faster-whisper "
                "or set AXION_TRANSCRIBE_PROVIDER=stub"
            )
            raise ProviderConfigError(msg) from None

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


def _resolve_transcription_provider() -> TranscriptionProvider:
    if settings.transcribe_stub or _env_truthy("AXION_TRANSCRIBE_STUB"):
        return StubTranscriptionProvider()

    provider = settings.transcribe_provider
    if provider == "faster-whisper":
        return FasterWhisperTranscriptionProvider()
    if provider == "stub":
        return StubTranscriptionProvider()
    raise ValueError(f"unsupported transcription provider: {settings.transcribe_provider}")


def transcribe_audio(*, audio_base64: str, mime_type: str) -> tuple[str, str, str | None]:
    raw = base64.b64decode(audio_base64, validate=True)
    provider = _resolve_transcription_provider()
    return provider.transcribe(raw=raw, mime_type=mime_type)
