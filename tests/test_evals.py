from __future__ import annotations

import importlib
import sys
import tempfile
import zipfile
from pathlib import Path

import pytest
from backend.app import config as app_config
from backend.app.database import MetadataDB
from backend.app.evals import evaluate_retrieval_metrics
from backend.app.ingestion import _validate_zip_archive, sanitize_filename
from fastapi.testclient import TestClient


def test_retrieval_eval_metrics_computes_recall_mrr_and_keywords():
    cases = [
        {
            "query": "hybrid search architecture",
            "expected_doc_ids": ["doc-1"],
            "expected_keywords": ["qdrant", "bm25s"],
        },
        {
            "query": "budget report",
            "expected_doc_ids": ["doc-2"],
            "expected_keywords": ["revenue"],
        },
    ]

    def fake_search(q: str, top_k: int):
        if "hybrid" in q:
            return [
                {"doc_id": "doc-x", "text": "unrelated"},
                {"doc_id": "doc-1", "text": "Qdrant dense vectors + bm25s sparse search"},
            ]
        return [{"doc_id": "doc-2", "text": "Quarterly revenue summary"}]

    report = evaluate_retrieval_metrics(cases, fake_search, top_k=5)
    assert report["count"] == 2
    assert report["mean_recall_at_k"] == 1.0
    assert report["mrr"] == 0.75  # (0.5 + 1.0) / 2
    assert report["mean_keyword_hit_rate"] == 1.0


def test_filename_sanitization_and_zip_bomb_guard():
    assert sanitize_filename("../../etc/passwd\x00.txt") == "passwd_.txt"
    assert sanitize_filename("") == "untitled.txt"

    with tempfile.TemporaryDirectory() as tmp:
        zpath = Path(tmp) / "test.docx"
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("word/document.xml", "hello world")
        _validate_zip_archive(zpath, max_uncompressed_bytes=1024)

        with pytest.raises(ValueError, match="exceeds"):
            _validate_zip_archive(zpath, max_uncompressed_bytes=4)


def test_sqlite_wal_sessions_and_job_persistence():
    with tempfile.TemporaryDirectory() as tmp:
        db = MetadataDB(Path(tmp) / "wal.db")
        s1 = db.upsert_chat_session("s-1", "Architecture Notes")
        assert s1["id"] == "s-1"
        assert s1["title"] == "Architecture Notes"

        db.add_chat_message("s-1", "user", "Explain hybrid search")
        sessions = db.list_chat_sessions()
        assert len(sessions) == 1
        assert sessions[0]["messageCount"] == 1

        db.upsert_chat_job("job-1", "s-1", "running", content="Partial")
        persisted = db.get_latest_chat_job("s-1")
        assert persisted is not None
        assert persisted["status"] == "stopped"
        assert persisted["content"] == "Partial"

        db.delete_chat_session("s-1")
        assert db.list_chat_sessions() == []


def test_sessions_llm_select_upload_limit_and_backup_validation(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        monkeypatch.setattr(app_config.settings, "data_dir", tmp_path)
        monkeypatch.setattr(app_config.settings, "max_upload_bytes", 128)
        sys.modules.pop("backend.app.main", None)
        app_main = importlib.import_module("backend.app.main")

        monkeypatch.setattr(app_main.rag_engine, "warmup_sync", lambda: None)

        try:
            with TestClient(app_main.app) as client:
                created = client.post("/api/sessions", json={"session_id": "s-api", "title": "My Session"})
                assert created.status_code == 200
                assert created.json()["title"] == "My Session"

                listed = client.get("/api/sessions")
                assert listed.status_code == 200
                assert any(s["id"] == "s-api" for s in listed.json())

                sel = client.post("/api/hardware/select-llm", json={"model_id": "qwen3:8b"})
                assert sel.status_code == 200
                assert sel.json()["selected_llm"] == "qwen3:8b"

                too_big = client.post(
                    "/api/documents/upload",
                    files=[("files", ("big.txt", b"x" * 256, "text/plain"))],
                )
                assert too_big.status_code == 413

                bad_backup = client.post("/api/backup/restore", json={"documents": "invalid"})
                assert bad_backup.status_code == 422

                deleted = client.delete("/api/sessions/s-api")
                assert deleted.status_code == 200
        finally:
            app_main.rag_engine.qdrant.close()
