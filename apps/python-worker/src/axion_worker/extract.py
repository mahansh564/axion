import json
import re
from typing import Any, Protocol, cast

import httpx

from axion_worker.settings import settings

EXTRACTION_SYSTEM_PROMPT = (
    "Extract JSON only with keys model_id, entities[], relations[], emotion, uncertainty. "
    "entities items: label, kind, span_start, span_end. "
    "relations items: subject, predicate, object, confidence. "
    "emotion: {label, intensity} or null. "
    "uncertainty: {phrases: string[]} or null. "
    "Use model_id literal axion-extract."
)


class ProviderConfigError(Exception):
    pass


class ProviderRuntimeError(Exception):
    pass


class ExtractionProvider(Protocol):
    async def extract(self, *, document_id: str, text: str) -> dict[str, Any]: ...


def _build_messages(document_id: str, text: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
        {"role": "user", "content": f"document_id={document_id}\n\n{text[:8000]}"},
    ]


def _stub_extraction(text: str) -> dict[str, Any]:
    entities: list[dict[str, Any]] = []
    relations: list[dict[str, Any]] = []
    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", text)
    for w in words[:5]:
        entities.append({"label": w, "kind": "entity", "span_start": None, "span_end": None})
    if len(words) >= 2:
        relations.append(
            {
                "subject": words[0],
                "predicate": "mentioned_with",
                "object": words[1],
                "confidence": 0.4,
            }
        )
    uncertainty_phrases = re.findall(r"\b(maybe|perhaps|not sure|unsure)\b", text, flags=re.I)
    return {
        "model_id": "stub-rules",
        "entities": entities,
        "relations": relations,
        "emotion": None,
        "uncertainty": {"phrases": uncertainty_phrases} if uncertainty_phrases else None,
        "usage": {
            "provider": "stub",
            "model_id": "stub-rules",
            "prompt_tokens": None,
            "completion_tokens": None,
            "total_tokens": None,
        },
    }


class StubExtractionProvider:
    async def extract(self, *, document_id: str, text: str) -> dict[str, Any]:
        del document_id
        return _normalize_extract(_stub_extraction(text))


class OllamaExtractionProvider:
    async def extract(self, *, document_id: str, text: str) -> dict[str, Any]:
        base = settings.ollama_base_url.rstrip("/")
        url = f"{base}/api/chat"
        payload = {
            "model": settings.ollama_model,
            "stream": False,
            "messages": _build_messages(document_id, text),
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(url, json=payload)
            r.raise_for_status()
            data = r.json()
            msg = data.get("message", {}).get("content", "")
            parsed = _parse_json_block(msg)
            if not parsed:
                raise ValueError("ollama provider response missing parseable JSON payload")
            parsed.setdefault("model_id", settings.ollama_model)
            usage = {
                "provider": "ollama",
                "model_id": str(data.get("model", settings.ollama_model)),
                "prompt_tokens": data.get("prompt_eval_count"),
                "completion_tokens": data.get("eval_count"),
                "total_tokens": None,
            }
            prompt = usage["prompt_tokens"]
            completion = usage["completion_tokens"]
            if isinstance(prompt, int) and isinstance(completion, int):
                usage["total_tokens"] = prompt + completion
            parsed["usage"] = usage
            return _normalize_extract(parsed)


class OpenAIExtractionProvider:
    async def extract(self, *, document_id: str, text: str) -> dict[str, Any]:
        if not settings.openai_api_key:
            raise ProviderConfigError("openai provider requires OPENAI_API_KEY")
        base = settings.openai_base_url.rstrip("/")
        url = f"{base}/chat/completions"
        payload = {
            "model": settings.openai_model,
            "temperature": 0,
            "messages": _build_messages(document_id, text),
            "response_format": {"type": "json_object"},
        }
        headers = {"Authorization": f"Bearer {settings.openai_api_key}"}
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            msg = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            parsed = _parse_json_block(msg)
            if not parsed:
                raise ValueError("openai provider response missing parseable JSON payload")
            parsed.setdefault("model_id", settings.openai_model)
            usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
            parsed["usage"] = {
                "provider": "openai",
                "model_id": str(data.get("model", settings.openai_model)),
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens"),
            }
            return _normalize_extract(parsed)


def _resolve_extraction_provider() -> ExtractionProvider:
    provider = settings.llm_provider
    if provider == "ollama":
        return OllamaExtractionProvider()
    if provider == "openai":
        return OpenAIExtractionProvider()
    if provider == "stub":
        return StubExtractionProvider()
    raise ValueError(f"unsupported llm provider: {settings.llm_provider}")


async def extract_structured(*, document_id: str, text: str) -> dict[str, Any]:
    provider_name = settings.llm_provider
    provider = _resolve_extraction_provider()
    try:
        return await provider.extract(document_id=document_id, text=text)
    except ProviderConfigError:
        raise
    except (httpx.HTTPError, json.JSONDecodeError, KeyError, ValueError) as exc:
        if provider_name == "ollama":
            return _normalize_extract(_stub_extraction(text))
        raise ProviderRuntimeError(f"{provider_name} extraction provider failed") from exc


def _parse_json_block(content: str) -> dict[str, Any] | None:
    content = content.strip()
    try:
        return cast(dict[str, Any], json.loads(content))
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", content)
    if m:
        try:
            return cast(dict[str, Any], json.loads(m.group(0)))
        except json.JSONDecodeError:
            return None
    return None


def _normalize_extract(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "model_id": str(raw.get("model_id", "unknown")),
        "entities": list(raw.get("entities") or []),
        "relations": list(raw.get("relations") or []),
        "emotion": raw.get("emotion"),
        "uncertainty": raw.get("uncertainty"),
        "usage": _normalize_usage(raw.get("usage")),
    }


def _normalize_usage(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    def _normalize_count(value: Any) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value if value >= 0 else None
        if isinstance(value, float) and value.is_integer() and value >= 0:
            return int(value)
        return None

    provider = raw.get("provider")
    model_id = raw.get("model_id")
    prompt_tokens = _normalize_count(raw.get("prompt_tokens"))
    completion_tokens = _normalize_count(raw.get("completion_tokens"))
    total_tokens = _normalize_count(raw.get("total_tokens"))
    if total_tokens is None and (prompt_tokens is not None or completion_tokens is not None):
        total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)

    normalized = {
        "provider": provider if isinstance(provider, str) and provider else None,
        "model_id": model_id if isinstance(model_id, str) and model_id else None,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
    }

    if (
        normalized["provider"] is None
        and normalized["model_id"] is None
        and normalized["prompt_tokens"] is None
        and normalized["completion_tokens"] is None
        and normalized["total_tokens"] is None
    ):
        return None

    return normalized
