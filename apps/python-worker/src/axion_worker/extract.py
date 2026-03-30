import json
import re
from typing import Any, cast

import httpx

from axion_worker.settings import settings


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
    }


async def extract_structured(*, document_id: str, text: str) -> dict[str, Any]:
    base = settings.ollama_base_url.rstrip("/")
    url = f"{base}/api/chat"
    payload = {
        "model": settings.ollama_model,
        "stream": False,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Extract JSON only with keys model_id, entities[], relations[], "
                    "emotion, uncertainty. "
                    "entities items: label, kind, span_start, span_end. "
                    "relations items: subject, predicate, object, confidence. "
                    "emotion: {label, intensity} or null. "
                    "uncertainty: {phrases: string[]} or null. "
                    "Use model_id literal axion-extract."
                ),
            },
            {
                "role": "user",
                "content": f"document_id={document_id}\n\n{text[:8000]}",
            },
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(url, json=payload)
            r.raise_for_status()
            data = r.json()
            msg = data.get("message", {}).get("content", "")
            parsed = _parse_json_block(msg)
            if parsed:
                parsed.setdefault("model_id", settings.ollama_model)
                return _normalize_extract(parsed)
    except (httpx.HTTPError, json.JSONDecodeError, KeyError):
        pass
    return _normalize_extract(_stub_extraction(text))


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
    }
