from typing import Literal

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    transcribe_stub: bool = Field(
        default=False,
        validation_alias=AliasChoices("AXION_TRANSCRIBE_STUB", "transcribe_stub"),
    )
    transcribe_provider: Literal["faster-whisper", "stub"] = Field(
        default="faster-whisper",
        validation_alias=AliasChoices("AXION_TRANSCRIBE_PROVIDER", "transcribe_provider"),
    )
    llm_provider: Literal["ollama", "openai", "stub"] = Field(
        default="ollama",
        validation_alias=AliasChoices("AXION_LLM_PROVIDER", "llm_provider"),
    )
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "llama3.2"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o-mini"
    openai_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("OPENAI_API_KEY", "openai_api_key"),
    )

    @field_validator("transcribe_provider", "llm_provider", mode="before")
    @classmethod
    def normalize_provider_names(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower()
        return value


settings = Settings()
