from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    transcribe_stub: bool = Field(
        default=False,
        validation_alias=AliasChoices("AXION_TRANSCRIBE_STUB", "transcribe_stub"),
    )
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "llama3.2"


settings = Settings()
