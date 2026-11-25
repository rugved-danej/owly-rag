import importlib
import sys
import tempfile
from pathlib import Path

from backend.app import config as app_config
from backend.app.database import MetadataDB
from backend.app.hardware_advisor import TIER_MATRIX, inspect_hardware
from backend.app.ingestion import parse_and_chunk_document
from backend.app.models import ChatRequest
from fastapi.testclient import TestClient


def test_hardware_profiler_returns_valid_tier():
    profile = inspect_hardware()
    assert profile.cpu_cores_logical >= 1
    assert profile.total_ram_gb > 0
    assert profile.disk_free_gb >= 0
    assert len(profile.smart_notes) >= 1
    assert profile.recommended_tier in TIER_MATRIX


def test_markdown_parent_child_chunking_preserves_headers_and_tables():
    sample = (
        "# Financial Summary\n\n"
        "Revenue grew steadily across all regions.\n\n"
        "| Quarter | Revenue | Margin |\n"
        "| --- | --- | --- |\n"
        "| Q1 | $1.2M | 42% |\n"
        "| Q2 | $1.5M | 45% |\n\n"
        "## Outlook\n\n"
        "Operating leverage continues improving in Q3."
    )
    with tempfile.TemporaryDirectory() as tmp:
        md_path = Path(tmp) / "report.md"
        md_path.write_text(sample, encoding="utf-8")
        parents, children = parse_and_chunk_document(
            file_path=md_path,
            doc_id="doc-1",
            filename="report.md",
            parent_size=1400,
            child_size=120,
            child_overlap=20,
        )
        assert len(parents) >= 2
        assert len(children) >= len(parents)
        assert any("| Quarter | Revenue | Margin |" in p["text"] for p in parents)
        assert any(p["section_header"] == "Outlook" for p in parents)
        assert all("[Document: report.md" in c["embed_text"] for c in children)


def test_txt_encoding_detection_handles_cp1252_and_utf8_bom():
    with tempfile.TemporaryDirectory() as tmp:
        cp1252_path = Path(tmp) / "notes_win.txt"
        cp1252_text = "Quarterly Notes \u2014 \u201cStrong Growth\u201d \u2022 Item 1"
        cp1252_path.write_bytes(cp1252_text.encode("cp1252"))

        parents, _ = parse_and_chunk_document(
            file_path=cp1252_path,
            doc_id="doc-win",
            filename="notes_win.txt",
            parent_size=1000,
            child_size=200,
            child_overlap=20,
        )
        assert len(parents) == 1
        assert "\ufffd" not in parents[0]["text"]
        assert "Strong Growth" in parents[0]["text"]

        bom_path = Path(tmp) / "notes_bom.txt"
        bom_path.write_bytes("\ufeffHello UTF-8 BOM".encode("utf-8"))
        parents_bom, _ = parse_and_chunk_document(
            file_path=bom_path,
            doc_id="doc-bom",
            filename="notes_bom.txt",
            parent_size=1000,
            child_size=200,
            child_overlap=20,
        )
        assert parents_bom[0]["text"].startswith("Hello UTF-8 BOM")


def test_html_json_and_code_ingestion():
    with tempfile.TemporaryDirectory() as tmp:
        html_path = Path(tmp) / "page.html"
        html_path.write_text(
            "<html><head><title>Spec</title></head><body><h1>Architecture</h1><p>Hybrid RAG pipeline.</p></body></html>",
            encoding="utf-8",
        )
        p_html, _ = parse_and_chunk_document(html_path, "h1", "page.html", 1200, 300, 30)
        assert any("Hybrid RAG pipeline." in p["text"] for p in p_html)

        json_path = Path(tmp) / "data.json"
        json_path.write_text('{"service": "rag-api", "version": 2}', encoding="utf-8")
        p_json, _ = parse_and_chunk_document(json_path, "j1", "data.json", 1200, 300, 30)
        assert any("rag-api" in p["text"] for p in p_json)

        py_path = Path(tmp) / "helper.py"
        py_path.write_text("def compute_score(x: int) -> int:\n    return x * 2\n", encoding="utf-8")
        p_py, _ = parse_and_chunk_document(py_path, "py1", "helper.py", 1200, 300, 30)
        assert p_py[0]["section_header"] == "compute_score"


def test_sqlite_document_dedup_and_backup():
    with tempfile.TemporaryDirectory() as tmp:
        db = MetadataDB(Path(tmp) / "test.db")
        doc = db.create_document("d1", "spec.txt", "txt", 128, file_hash="abc123")
        assert doc["status"] == "processing"
        assert db.find_document_by_hash("abc123")["doc_id"] == "d1"

        db.insert_chunks(
            parents=[
                {
                    "parent_id": "p1",
                    "doc_id": "d1",
                    "filename": "spec.txt",
                    "page_number": 1,
                    "section_header": "Intro",
                    "text": "Parent window text.",
                    "created_at": "2026-01-01T00:00:00Z",
                }
            ],
            children=[
                {
                    "child_id": "c1",
                    "parent_id": "p1",
                    "doc_id": "d1",
                    "filename": "spec.txt",
                    "page_number": 1,
                    "section_header": "Intro",
                    "text": "Parent window",
                }
            ],
        )
        backup = db.export_all_data()
        assert len(backup["documents"]) == 1

        assert db.delete_document("d1") is True
        assert db.get_all_child_chunks() == []

        counts = db.import_backup_data(backup)
        assert counts["documents"] == 1
        assert len(db.get_all_child_chunks()) == 1
        assert len(db.get_representative_parents(["d1"], limit=2)) == 1


def test_multi_session_chat_history_isolation():
    with tempfile.TemporaryDirectory() as tmp:
        db = MetadataDB(Path(tmp) / "chat.db")
        db.add_chat_message("session-a", "user", "Question A")
        db.add_chat_message("session-a", "assistant", "Answer A")
        db.add_chat_message("session-b", "user", "Question B")

        hist_a = db.get_chat_history("session-a")
        hist_b = db.get_chat_history("session-b")
        assert len(hist_a) == 2
        assert len(hist_b) == 1
        assert hist_a[0]["content"] == "Question A"
        assert hist_b[0]["content"] == "Question B"

        db.clear_chat_history("session-a")
        assert db.get_chat_history("session-a") == []
        assert len(db.get_chat_history("session-b")) == 1


def test_chat_request_supports_optional_params():
    req_all = ChatRequest(session_id="s1", query="hello")
    assert req_all.doc_ids is None
    assert req_all.system_persona == "default"
    assert req_all.query_mode == "qa"

    req_scoped = ChatRequest(
        session_id="s1",
        query="hello",
        doc_ids=["d1", "d2"],
        temperature=0.4,
        system_persona="analyst",
        query_mode="compare",
    )
    assert req_scoped.doc_ids == ["d1", "d2"]


def test_api_http_document_lifecycle_and_backup(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        monkeypatch.setattr(app_config.settings, "data_dir", tmp_path)
        sys.modules.pop("backend.app.main", None)
        app_main = importlib.import_module("backend.app.main")

        monkeypatch.setattr(app_main.rag_engine, "index_children_sync", lambda children, progress_cb=None: None)
        monkeypatch.setattr(app_main.rag_engine, "delete_document_vectors", lambda doc_id: None)
        monkeypatch.setattr(app_main.rag_engine, "warmup_sync", lambda: None)

        try:
            with TestClient(app_main.app) as client:
                health = client.get("/api/health")
                assert health.status_code == 200
                assert health.json()["status"] == "ok"
                assert ".pdf" in health.json()["supported_extensions"]

                hw = client.get("/api/hardware")
                assert hw.status_code == 200
                hw_json = hw.json()
                assert len(hw_json["models"]) >= 3
                assert any(m["required"] for m in hw_json["models"])
                assert all(m["required"] or m["installed"] for m in hw_json["models"])
                assert all(m.get("provider") in {"qwen", "ollama", "baai", "microsoft", "huggingface"} for m in hw_json["models"])

                smart = client.post("/api/hardware/smart-detect")
                assert smart.status_code == 200
                assert smart.json()["active_tier"]["tier_id"] == smart.json()["profile"]["recommended_tier"]

                async def fake_install(model_id: str, kind: str = "llm"):
                    yield 'data: {"status": "done", "percent": 100.0}\n\n'

                monkeypatch.setattr(app_main.advisor, "install_model_stream", fake_install)
                inst = client.post(
                    "/api/hardware/install",
                    json={"model_id": hw_json["active_tier"]["llm_model"], "kind": "llm"},
                )
                assert inst.status_code == 200
                assert '"done"' in inst.text

                async def fake_uninstall(model_id: str, kind: str = "llm"):
                    return {"uninstalled": True, "model_id": model_id, "kind": kind}

                monkeypatch.setattr(app_main.advisor, "uninstall_model", fake_uninstall)
                uninst = client.post(
                    "/api/hardware/uninstall",
                    json={"model_id": hw_json["active_tier"]["llm_model"], "kind": "llm"},
                )
                assert uninst.status_code == 200
                assert "active_tier" in uninst.json()

                # Verify obsolete pull endpoints are removed
                assert client.post("/api/hardware/pull-model", json={"model_name": "qwen2.5:1.5b"}).status_code in (404, 405)
                assert client.post("/api/hardware/pull-any", json={"model_id": "qwen2.5:1.5b", "kind": "llm"}).status_code in (404, 405)

                upload = client.post(
                    "/api/documents/upload",
                    files=[("files", ("arch.txt", b"Hybrid RAG uses dense + BM25 search.", "text/plain"))],
                )
                assert upload.status_code == 200
                doc_id = upload.json()[0]["doc_id"]

                dup = client.post(
                    "/api/documents/upload",
                    files=[("files", ("arch.txt", b"Hybrid RAG uses dense + BM25 search.", "text/plain"))],
                )
                assert dup.status_code == 409

                chunks = client.get(f"/api/documents/{doc_id}/chunks")
                assert chunks.status_code == 200
                assert len(chunks.json()["parents"]) >= 1

                backup = client.get("/api/backup/export")
                assert backup.status_code == 200
                assert len(backup.json()["documents"]) == 1

                deleted = client.delete(f"/api/documents/{doc_id}")
                assert deleted.status_code == 200
                assert deleted.json()["deleted"] is True

                missing = client.get(f"/api/documents/{doc_id}/chunks")
                assert missing.status_code == 404

                # Persistent chat job lifecycle (start -> status -> stop)
                async def fake_stream(*args, **kwargs):
                    yield 'data: {"type": "token", "data": "Hello "}\n\n'
                    yield 'data: {"type": "token", "data": "World"}\n\n'
                    yield 'data: {"type": "done", "data": {}}\n\n'

                monkeypatch.setattr(app_main.rag_engine, "stream_chat", fake_stream)
                started = client.post("/api/chat/jobs", json={"session_id": "job-test", "query": "hi"})
                assert started.status_code == 200
                assert started.json()["session_id"] == "job-test"

                status = client.get("/api/chat/jobs/job-test/status")
                assert status.status_code == 200
                assert status.json()["exists"] is True

                stopped = client.post("/api/chat/jobs/job-test/stop")
                assert stopped.status_code == 200
                assert stopped.json()["stopped"] is True

                # Verify removed evaluation, URL ingestion, and collection endpoints are gone
                assert client.post("/api/eval/retrieval", json={"items": []}).status_code in (404, 405)
                assert client.post("/api/documents/ingest-url", json={"url": "https://example.com"}).status_code in (404, 405)
                assert client.patch(f"/api/documents/{doc_id}/collection", json={"collection_name": "X"}).status_code in (404, 405)
        finally:
            app_main.rag_engine.qdrant.close()


def test_crag_off_topic_query_hides_unrelated_sources(monkeypatch):
    import asyncio
    import json as _json

    from backend.app.config import Settings
    from backend.app.hardware_advisor import HardwareAdvisor
    from backend.app.rag_engine import RAGEngine

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        s = Settings(data_dir=tmp_path)
        db = MetadataDB(s.sqlite_path)
        db.create_document("d1", "company_notes.txt", "txt", 100)
        db.update_document_status("d1", "ready", 100, parent_count=1, child_count=1)
        advisor = HardwareAdvisor(s.ollama_base_url)
        engine = RAGEngine(s, db, advisor)

        async def fake_ollama_status():
            active_llm = advisor.get_active_recommendation().llm_model
            return {"reachable": True, "installed_models": [active_llm]}

        monkeypatch.setattr(advisor, "get_ollama_status", fake_ollama_status)
        monkeypatch.setattr(
            engine,
            "_hybrid_search_with_stats_sync",
            lambda q, top_k, doc_ids=None: (
                [{"child_id": "c1", "parent_id": "p1", "doc_id": "d1", "filename": "company_notes.txt", "page_number": 1, "section_header": "Notes", "text": "Quarterly budget review.", "rrf_score": 0.01}],
                {"dense_hits": 1, "bm25_hits": 0, "fused_candidates": 1},
            ),
        )
        monkeypatch.setattr(
            engine,
            "_rerank_and_expand_parents_sync",
            lambda q, cands, top_k: [{"parent_id": "p1", "doc_id": "d1", "filename": "company_notes.txt", "page_number": 1, "section_header": "Notes", "text": "Quarterly budget review.", "matched_excerpt": "Quarterly budget review.", "rerank_score": -7.2, "rrf_score": 0.01}],
        )

        async def fake_rewrite(q, hist):
            return "NVIDIA CEO"

        monkeypatch.setattr(engine, "_rewrite_query", fake_rewrite)

        async def collect():
            events = []
            async for raw in engine.stream_chat("off-topic-sess", "Who is the CEO of NVIDIA?"):
                for line in raw.splitlines():
                    if line.startswith("data:"):
                        events.append(_json.loads(line[5:].strip()))
            return events

        try:
            events = asyncio.run(collect())
            stage_events = [e for e in events if e["type"] == "stage"]
            trace_events = [e for e in events if e["type"] == "trace"]
            assert any(e["data"]["stage"] == "search" for e in stage_events)
            assert any(e["data"]["stage"] == "rewrite" for e in stage_events)
            assert any(isinstance(e["data"].get("meta"), dict) and e["data"]["meta"].get("pass") == 1 for e in trace_events)
            sources_events = [e for e in events if e["type"] == "sources"]
            assert sources_events and sources_events[0]["data"] == []
            token_text = "".join(e["data"] for e in events if e["type"] == "token")
            assert "could not find any relevant information" in token_text.lower()

            # Simple conversational greeting responds as Owly without running failed CRAG passes
            greet_events = asyncio.run(_collect_stream(engine, "greet-sess", "hi"))
            greet_text = "".join(e["data"] for e in greet_events if e["type"] == "token")
            assert "owly" in greet_text.lower()
            assert "could not find" not in greet_text.lower()

            # Normal chat mode streams directly without forcing document retrieval failures
            class _FakeStreamResp:
                status_code = 200
                async def __aenter__(self): return self
                async def __aexit__(self, *args): return False
                async def aiter_lines(self):
                    yield _json.dumps({"message": {"content": "Hello! Happy to chat."}})
                    yield _json.dumps({"done": True})

            class _FakeClient:
                def stream(self, *args, **kwargs):
                    return _FakeStreamResp()

            monkeypatch.setattr(engine, "_get_http_client", lambda: _FakeClient())
            chat_events = asyncio.run(_collect_stream(engine, "chat-sess", "tell me a fun fact", query_mode="chat"))
            chat_text = "".join(e["data"] for e in chat_events if e["type"] == "token")
            assert "happy to chat" in chat_text.lower()
        finally:
            engine.qdrant.close()


async def _collect_stream(engine, session_id: str, query: str, query_mode: str = "qa"):
    import json as _json
    events = []
    async for raw in engine.stream_chat(session_id, query, query_mode=query_mode):
        for line in raw.splitlines():
            if line.startswith("data:"):
                events.append(_json.loads(line[5:].strip()))
    return events


def test_bm25s_sparse_search_and_doc_filtering():
    from backend.app.config import Settings
    from backend.app.hardware_advisor import HardwareAdvisor
    from backend.app.rag_engine import RAGEngine

    with tempfile.TemporaryDirectory() as tmp:
        s = Settings(data_dir=Path(tmp))
        db = MetadataDB(s.sqlite_path)
        db.create_document("d1", "alpha.txt", "txt", 100)
        db.create_document("d2", "beta.txt", "txt", 100)
        db.insert_chunks(
            parents=[
                {
                    "parent_id": "p1",
                    "doc_id": "d1",
                    "filename": "alpha.txt",
                    "page_number": 1,
                    "section_header": "Hybrid",
                    "text": "Hybrid RAG combines dense vectors with bm25s lexical scoring.",
                    "created_at": "2026-11-26T00:00:00Z",
                },
                {
                    "parent_id": "p2",
                    "doc_id": "d2",
                    "filename": "beta.txt",
                    "page_number": 1,
                    "section_header": "Finance",
                    "text": "Quarterly budget review and revenue forecast.",
                    "created_at": "2026-11-26T00:00:00Z",
                },
            ],
            children=[
                {
                    "child_id": "c1",
                    "parent_id": "p1",
                    "doc_id": "d1",
                    "filename": "alpha.txt",
                    "page_number": 1,
                    "section_header": "Hybrid",
                    "text": "Hybrid RAG combines dense vectors with bm25s lexical scoring.",
                },
                {
                    "child_id": "c2",
                    "parent_id": "p2",
                    "doc_id": "d2",
                    "filename": "beta.txt",
                    "page_number": 1,
                    "section_header": "Finance",
                    "text": "Quarterly budget review and revenue forecast.",
                },
            ],
        )
        advisor = HardwareAdvisor(s.ollama_base_url)
        engine = RAGEngine(s, db, advisor)
        try:
            hits = engine._sparse_bm25_search("bm25s lexical scoring", allowed_ids=None)
            assert len(hits) == 1
            assert hits[0]["doc_id"] == "d1"

            filtered_out = engine._sparse_bm25_search("bm25s lexical scoring", allowed_ids={"d2"})
            assert filtered_out == []

            miss = engine._sparse_bm25_search("nonexistent_token_xyz", allowed_ids=None)
            assert miss == []
        finally:
            engine.qdrant.close()
