from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    data_dir: Path = Path("./data")
    qdrant_url: str = ""
    ollama_base_url: str = "http://localhost:11434"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Optional OpenAI-compatible external LLM fallback/provider
    openai_base_url: str = ""
    openai_api_key: str = ""
    openai_model: str = ""

    # Optional Model Overrides (leave blank to let Hardware Advisor auto-select)
    override_tier: str = ""
    override_embedding_model: str = ""
    override_reranker_model: str = ""
    override_llm_model: str = ""

    # Ingestion & RAG Tuning
    max_upload_bytes: int = 50 * 1024 * 1024
    max_archive_uncompressed_bytes: int = 200 * 1024 * 1024
    parent_chunk_size: int = 1400
    child_chunk_size: int = 350
    child_chunk_overlap: int = 60
    hybrid_top_k: int = 25
    rerank_top_k: int = 5
    max_crag_retries: int = 1
    hf_hub_offline: int = 0

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def upload_dir(self) -> Path:
        path = self.data_dir / "uploads"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def qdrant_local_path(self) -> Path:
        path = self.data_dir / "qdrant"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def bm25_index_dir(self) -> Path:
        path = self.data_dir / "bm25s"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def sqlite_path(self) -> Path:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.data_dir / "localrag.db"


settings = Settings()
