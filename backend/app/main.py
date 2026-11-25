"""FastAPI application entrypoint for Owly RAG: document ingestion, hybrid CRAG chat, and model management."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .config import settings
from .database import MetadataDB
from .hardware_advisor import HardwareAdvisor
from .ingestion import SUPPORTED_EXTENSIONS, parse_and_chunk_document, sanitize_filename
from .logging_config import configure_logging, get_logger
from .models import (
    BackupRestoreRequest,
    ChatRequest,
    InstallModelRequest,
    SessionUpsertRequest,
    TierSelectRequest,
    UninstallModelRequest,
)
from .rag_engine import RAGEngine

configure_logging(settings.app_env)
logger = get_logger("owly_rag.api")

if settings.hf_hub_offline:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
else:
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")

db = MetadataDB(settings.sqlite_path)
advisor = HardwareAdvisor(settings.ollama_base_url, override_tier=settings.override_tier)
rag_engine = RAGEngine(settings, db, advisor)

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


@dataclass
class ChatJob:
    job_id: str
    session_id: str
    status: str = "running"  # "running" | "done" | "stopped" | "error"
    events: list[dict[str, Any]] = field(default_factory=list)
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    task: asyncio.Task | None = None
    content: str = ""
    trace: list[dict[str, Any]] = field(default_factory=list)
    citations: list[dict[str, Any]] = field(default_factory=list)
    followups: list[str] = field(default_factory=list)
    live_stage: dict[str, Any] | None = None
    error: str | None = None


ACTIVE_CHAT_JOBS: dict[str, ChatJob] = {}


def _persist_job(job: ChatJob) -> None:
    try:
        db.upsert_chat_job(
            job_id=job.job_id,
            session_id=job.session_id,
            status=job.status,
            content=job.content,
            citations=job.citations,
            trace=job.trace,
            followups=job.followups,
            error=job.error,
        )
    except Exception:
        pass


def _broadcast_job_event(job: ChatJob, evt: dict[str, Any] | None) -> None:
    if evt is not None:
        job.events.append(evt)
        etype = evt.get("type")
        data = evt.get("data")
        if etype == "token" and isinstance(data, str):
            job.content += data
        elif etype == "stage" and isinstance(data, dict):
            job.live_stage = data
        elif etype == "trace" and isinstance(data, dict):
            job.trace.append(data)
        elif etype == "sources" and isinstance(data, list):
            job.citations = data
        elif etype == "followups" and isinstance(data, list):
            job.followups = data
        elif etype == "error" and isinstance(data, str):
            job.error = data
            job.live_stage = None
            job.status = "error"
            _persist_job(job)
        elif etype == "done":
            job.live_stage = None
            job.status = "done"
            _persist_job(job)

    for q in list(job.subscribers):
        try:
            q.put_nowait(evt)
        except Exception:
            pass


async def _run_persistent_chat_job(job: ChatJob, payload: ChatRequest) -> None:
    try:
        async for raw_chunk in rag_engine.stream_chat(
            payload.session_id,
            payload.query,
            doc_ids=payload.doc_ids,
            temperature=payload.temperature,
            top_k=payload.top_k,
            system_persona=payload.system_persona,
            query_mode=payload.query_mode,
            llm_model=payload.llm_model,
        ):
            for line in raw_chunk.splitlines():
                stripped = line.strip()
                if not stripped.startswith("data:"):
                    continue
                try:
                    evt = json.loads(stripped[5:].strip())
                    _broadcast_job_event(job, evt)
                except json.JSONDecodeError:
                    continue
        if job.status == "running":
            job.status = "done"
            _broadcast_job_event(job, {"type": "done", "data": {"citations": job.citations, "trace": job.trace}})
    except asyncio.CancelledError:
        job.status = "stopped"
        if job.content.strip():
            db.add_chat_message(
                session_id=job.session_id,
                role="assistant",
                content=job.content,
                citations=job.citations,
                trace=job.trace,
            )
        _persist_job(job)
        _broadcast_job_event(job, {"type": "done", "data": {"stopped": True}})
        raise
    except Exception as exc:
        job.status = "error"
        _broadcast_job_event(job, {"type": "error", "data": str(exc)})
    finally:
        _persist_job(job)
        _broadcast_job_event(job, None)


@asynccontextmanager
async def lifespan(_: FastAPI):
    advisor.refresh()
    asyncio.create_task(asyncio.to_thread(rag_engine.warmup_sync))
    yield
    for job in ACTIVE_CHAT_JOBS.values():
        if job.task and not job.task.done():
            job.task.cancel()


app = FastAPI(title="Owly RAG API", version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):
    req_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(request_id=req_id, method=request.method, path=request.url.path)
    t0 = time.perf_counter()
    response = await call_next(request)
    duration_ms = int((time.perf_counter() - t0) * 1000)
    response.headers["X-Request-ID"] = req_id
    if not request.url.path.endswith("/stream"):
        logger.info("http_request", status=response.status_code, duration_ms=duration_ms)
    return response


def _process_document_sync(doc_id: str, file_path: Path, filename: str) -> None:
    try:
        db.update_document_status(doc_id, "processing", 15)
        parents, children = parse_and_chunk_document(
            file_path=file_path,
            doc_id=doc_id,
            filename=filename,
            parent_size=settings.parent_chunk_size,
            child_size=settings.child_chunk_size,
            child_overlap=settings.child_chunk_overlap,
        )
        db.update_document_status(doc_id, "processing", 35)
        db.insert_chunks(parents, children)
        rag_engine.index_children_sync(
            children, progress_cb=lambda pct: db.update_document_status(doc_id, "processing", pct)
        )
        db.update_document_status(
            doc_id,
            "ready",
            100,
            parent_count=len(parents),
            child_count=len(children),
        )
        logger.info("document_indexed", doc_id=doc_id, filename=filename, parents=len(parents), children=len(children))
    except Exception as exc:
        logger.warning("document_ingest_failed", doc_id=doc_id, filename=filename, error=str(exc))
        db.update_document_status(doc_id, "error", 0, error_message=str(exc))
    finally:
        if file_path.exists():
            try:
                file_path.unlink()
            except OSError:
                pass


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "tier": advisor.active_tier_id,
        "selected_llm": advisor.active_llm_override or advisor.get_active_recommendation().llm_model,
        "documents_ready": len([d for d in db.list_documents() if d["status"] == "ready"]),
        "supported_extensions": sorted(SUPPORTED_EXTENSIONS),
    }


@app.get("/api/hardware")
async def get_hardware() -> dict[str, Any]:
    advisor.refresh()
    return await advisor.get_full_report()


async def _apply_tier_selection(tier_id: str) -> dict[str, Any]:
    prev_dim = advisor.get_active_recommendation().embedding_dim
    try:
        rec = advisor.select_tier(tier_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    reindexed = 0
    if rec.embedding_dim != prev_dim and db.get_all_child_chunks():
        reindexed = await asyncio.to_thread(rag_engine.reindex_all_sync)

    report = await advisor.get_full_report()
    report["reindexed_chunks"] = reindexed
    return report


@app.post("/api/hardware/select-tier")
async def select_tier(payload: TierSelectRequest) -> dict[str, Any]:
    return await _apply_tier_selection(payload.tier_id)


@app.post("/api/hardware/select-llm")
async def select_llm(payload: dict[str, str]) -> dict[str, Any]:
    model_id = str(payload.get("model_id") or "")
    advisor.select_llm(model_id)
    return await advisor.get_full_report()


@app.post("/api/hardware/smart-detect")
async def smart_detect_hardware() -> dict[str, Any]:
    profile = advisor.refresh()
    return await _apply_tier_selection(profile.recommended_tier)


@app.post("/api/hardware/install")
async def install_model(payload: InstallModelRequest) -> StreamingResponse:
    return StreamingResponse(
        advisor.install_model_stream(payload.model_id, payload.kind),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@app.post("/api/hardware/uninstall")
async def uninstall_model(payload: UninstallModelRequest) -> dict[str, Any]:
    if payload.kind in {"embedding", "reranker"}:
        rag_engine.release_model_sync(payload.model_id, payload.kind)
    try:
        await advisor.uninstall_model(payload.model_id, payload.kind)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await advisor.get_full_report()


@app.get("/api/documents")
async def list_documents() -> list[dict[str, Any]]:
    return db.list_documents()


@app.post("/api/documents/upload")
async def upload_documents(
    background_tasks: BackgroundTasks,
    files: Annotated[list[UploadFile], File(...)],
    allow_duplicate: Annotated[bool, Form()] = False,
) -> list[dict[str, Any]]:
    created = []
    for file in files:
        filename = sanitize_filename(file.filename or "untitled.txt")
        ext = Path(filename).suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file '{filename}'. Supported: {sorted(SUPPORTED_EXTENSIONS)}",
            )
        content = await file.read()
        if len(content) > settings.max_upload_bytes:
            max_mb = settings.max_upload_bytes // (1024 * 1024)
            raise HTTPException(
                status_code=413,
                detail=f"File '{filename}' exceeds the {max_mb} MB upload size limit.",
            )
        file_hash = hashlib.sha256(content).hexdigest()
        if not allow_duplicate:
            existing = db.find_document_by_hash(file_hash)
            if existing:
                raise HTTPException(
                    status_code=409,
                    detail=f"Duplicate file detected: '{filename}' matches already uploaded '{existing['filename']}'.",
                )

        doc_id = str(uuid.uuid4())
        target = settings.upload_dir / f"{doc_id}{ext}"
        target.write_bytes(content)

        record = db.create_document(
            doc_id,
            filename,
            ext.lstrip("."),
            len(content),
            file_hash=file_hash,
        )
        created.append(record)
        background_tasks.add_task(_process_document_sync, doc_id, target, filename)
    return created


@app.get("/api/documents/{doc_id}/chunks")
async def inspect_chunks(doc_id: str) -> dict[str, Any]:
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found.")
    return {"document": doc, **db.get_document_chunks(doc_id)}


@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str) -> dict[str, Any]:
    if not db.get_document(doc_id):
        raise HTTPException(status_code=404, detail="Document not found.")
    db.delete_document(doc_id)
    await asyncio.to_thread(rag_engine.delete_document_vectors, doc_id)
    return {"deleted": True, "doc_id": doc_id}


# ── Server-Synced Chat Sessions ──────────────────────────────────────────────

@app.get("/api/sessions")
async def list_sessions() -> list[dict[str, Any]]:
    return db.list_chat_sessions()


@app.post("/api/sessions")
async def upsert_session(payload: SessionUpsertRequest) -> dict[str, Any]:
    sid = payload.session_id or f"chat-{uuid.uuid4().hex[:10]}"
    return db.upsert_chat_session(sid, payload.title)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool]:
    prev = ACTIVE_CHAT_JOBS.get(session_id)
    if prev and prev.task and not prev.task.done():
        prev.task.cancel()
    ACTIVE_CHAT_JOBS.pop(session_id, None)
    db.delete_chat_session(session_id)
    return {"deleted": True}


@app.get("/api/chat/{session_id}/history")
async def get_history(session_id: str) -> list[dict[str, Any]]:
    return db.get_chat_history(session_id, limit=50)


@app.delete("/api/chat/{session_id}/history")
async def clear_history(session_id: str) -> dict[str, bool]:
    prev = ACTIVE_CHAT_JOBS.get(session_id)
    if prev and prev.task and not prev.task.done():
        prev.task.cancel()
    ACTIVE_CHAT_JOBS.pop(session_id, None)
    db.clear_chat_history(session_id)
    return {"cleared": True}


@app.post("/api/chat/jobs")
async def start_chat_job(payload: ChatRequest) -> dict[str, Any]:
    """Start a persistent background generation job decoupled from client socket lifetime."""
    prev = ACTIVE_CHAT_JOBS.get(payload.session_id)
    if prev and prev.task and not prev.task.done():
        prev.task.cancel()

    job = ChatJob(job_id=str(uuid.uuid4()), session_id=payload.session_id)
    ACTIVE_CHAT_JOBS[payload.session_id] = job
    _persist_job(job)
    job.task = asyncio.create_task(_run_persistent_chat_job(job, payload))
    return {"job_id": job.job_id, "session_id": job.session_id, "status": job.status}


@app.get("/api/chat/jobs/{session_id}/status")
async def get_chat_job_status(session_id: str) -> dict[str, Any]:
    job = ACTIVE_CHAT_JOBS.get(session_id)
    if not job:
        persisted = db.get_latest_chat_job(session_id)
        if not persisted:
            return {"exists": False, "session_id": session_id}
        return {"exists": True, "live_stage": None, "event_count": 0, **persisted}
    return {
        "exists": True,
        "job_id": job.job_id,
        "session_id": job.session_id,
        "status": job.status,
        "content": job.content,
        "trace": job.trace,
        "citations": job.citations,
        "followups": job.followups,
        "live_stage": job.live_stage,
        "error": job.error,
        "event_count": len(job.events),
    }


@app.get("/api/chat/jobs/{session_id}/stream")
async def attach_chat_job_stream(
    session_id: str,
    after: int = Query(default=0, ge=0),
) -> StreamingResponse:
    job = ACTIVE_CHAT_JOBS.get(session_id)
    if not job:
        raise HTTPException(status_code=404, detail="No active or recent job for this session.")

    async def event_generator() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue = asyncio.Queue()
        job.subscribers.append(queue)
        try:
            snapshot = list(job.events[after:])
            for evt in snapshot:
                yield f"data: {json.dumps(evt)}\n\n"

            if job.status != "running":
                return

            while True:
                evt = await queue.get()
                if evt is None:
                    break
                yield f"data: {json.dumps(evt)}\n\n"
                if evt.get("type") in {"done", "error"}:
                    break
        finally:
            if queue in job.subscribers:
                job.subscribers.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@app.post("/api/chat/jobs/{session_id}/stop")
async def stop_chat_job(session_id: str) -> dict[str, Any]:
    job = ACTIVE_CHAT_JOBS.get(session_id)
    if not job:
        return {"stopped": False, "session_id": session_id}
    if job.task and not job.task.done():
        job.task.cancel()
        try:
            await job.task
        except asyncio.CancelledError:
            pass
    job.status = "stopped"
    _persist_job(job)
    return {"stopped": True, "session_id": session_id, "job_id": job.job_id}


@app.get("/api/backup/export")
async def export_backup() -> JSONResponse:
    data = db.export_all_data()
    return JSONResponse(
        content=data,
        headers={"Content-Disposition": "attachment; filename=owly-rag-backup.json"},
    )


@app.post("/api/backup/restore")
async def restore_backup(payload: BackupRestoreRequest) -> dict[str, Any]:
    counts = db.import_backup_data(payload.model_dump())
    reindexed = await asyncio.to_thread(rag_engine.reindex_all_sync)
    return {"restored": True, "counts": counts, "reindexed_chunks": reindexed}
