from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ChatRequest(BaseModel):
    session_id: str = Field(default="default", min_length=1, max_length=128)
    query: str = Field(min_length=1, max_length=8000)
    doc_ids: list[str] | None = None
    temperature: float = Field(default=0.1, ge=0.0, le=1.5)
    top_k: int | None = Field(default=None, ge=1, le=20)
    system_persona: str = Field(default="default")
    query_mode: str = Field(default="qa")
    llm_model: str | None = Field(default=None, max_length=200)


class SessionUpsertRequest(BaseModel):
    session_id: str | None = Field(default=None, min_length=1, max_length=128)
    title: str = Field(default="New Conversation", min_length=1, max_length=160)


class TierSelectRequest(BaseModel):
    tier_id: str


class InstallModelRequest(BaseModel):
    model_id: str
    kind: str = "llm"  # "llm" | "embedding" | "reranker"


class UninstallModelRequest(BaseModel):
    model_id: str
    kind: str = "llm"  # "llm" | "embedding" | "reranker"


class BackupDocumentItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    doc_id: str
    filename: str
    file_type: str
    size_bytes: int = Field(ge=0)
    status: str = "ready"
    progress: int = 100
    error_message: str | None = None
    parent_count: int = 0
    child_count: int = 0
    collection_name: str = "General"
    file_hash: str = ""
    created_at: str | None = None


class BackupParentItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    parent_id: str
    doc_id: str
    filename: str
    page_number: int = 1
    section_header: str = ""
    text: str
    created_at: str | None = None


class BackupChildItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    child_id: str
    parent_id: str
    doc_id: str
    filename: str
    page_number: int = 1
    section_header: str = ""
    text: str


class BackupChatMessageItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str
    role: str
    content: str
    citations_json: str = "[]"
    trace_json: str = "[]"
    created_at: str | None = None


class BackupChatSessionItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str
    title: str
    created_at: str | None = None
    updated_at: str | None = None


class BackupRestoreRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    version: int = 1
    exported_at: str | None = None
    documents: list[BackupDocumentItem] = Field(default_factory=list)
    parent_chunks: list[BackupParentItem] = Field(default_factory=list)
    child_chunks: list[BackupChildItem] = Field(default_factory=list)
    chat_messages: list[BackupChatMessageItem] = Field(default_factory=list)
    chat_sessions: list[BackupChatSessionItem] = Field(default_factory=list)


class RetrievalEvalItem(BaseModel):
    query: str = Field(min_length=1)
    expected_doc_ids: list[str] = Field(default_factory=list)
    expected_keywords: list[str] = Field(default_factory=list)


class RetrievalEvalRequest(BaseModel):
    items: list[RetrievalEvalItem] = Field(min_length=1, max_length=50)
    top_k: int = Field(default=5, ge=1, le=20)


# Re-export Any for compatibility if needed
_ = Any, dict
