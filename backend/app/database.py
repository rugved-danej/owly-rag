from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class MetadataDB:
    """SQLite (WAL) persistence for documents, parent/child chunks, sessions, jobs, and chat memory."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._init_schema()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL;")
            conn.execute("PRAGMA synchronous = NORMAL;")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    doc_id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    file_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    progress INTEGER DEFAULT 0,
                    error_message TEXT,
                    parent_count INTEGER DEFAULT 0,
                    child_count INTEGER DEFAULT 0,
                    collection_name TEXT DEFAULT 'General',
                    file_hash TEXT DEFAULT '',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS parent_chunks (
                    parent_id TEXT PRIMARY KEY,
                    doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
                    filename TEXT NOT NULL,
                    page_number INTEGER NOT NULL,
                    section_header TEXT NOT NULL,
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS child_chunks (
                    child_id TEXT PRIMARY KEY,
                    parent_id TEXT NOT NULL REFERENCES parent_chunks(parent_id) ON DELETE CASCADE,
                    doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
                    filename TEXT NOT NULL,
                    page_number INTEGER NOT NULL,
                    section_header TEXT NOT NULL,
                    text TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chat_sessions (
                    session_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chat_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    citations_json TEXT DEFAULT '[]',
                    trace_json TEXT DEFAULT '[]',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chat_jobs (
                    job_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    citations_json TEXT NOT NULL DEFAULT '[]',
                    trace_json TEXT NOT NULL DEFAULT '[]',
                    followups_json TEXT NOT NULL DEFAULT '[]',
                    error TEXT,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
                CREATE INDEX IF NOT EXISTS idx_chat_jobs_session ON chat_jobs(session_id, updated_at);
                """
            )
            cols = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(documents)").fetchall()
            }
            if "collection_name" not in cols:
                conn.execute("ALTER TABLE documents ADD COLUMN collection_name TEXT DEFAULT 'General'")
            if "file_hash" not in cols:
                conn.execute("ALTER TABLE documents ADD COLUMN file_hash TEXT DEFAULT ''")

    def create_document(
        self,
        doc_id: str,
        filename: str,
        file_type: str,
        size_bytes: int,
        file_hash: str = "",
    ) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO documents (
                    doc_id, filename, file_type, size_bytes, status, progress,
                    file_hash, created_at
                )
                VALUES (?, ?, ?, ?, 'processing', 5, ?, ?)
                """,
                (doc_id, filename, file_type, size_bytes, file_hash or "", now),
            )
        return self.get_document(doc_id) or {}

    def find_document_by_hash(self, file_hash: str) -> dict[str, Any] | None:
        if not file_hash:
            return None
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE file_hash = ? LIMIT 1", (file_hash,)
            ).fetchone()
            return dict(row) if row else None

    def update_document_status(
        self,
        doc_id: str,
        status: str,
        progress: int,
        error_message: str | None = None,
        parent_count: int | None = None,
        child_count: int | None = None,
    ) -> None:
        with self._connect() as conn:
            if parent_count is not None and child_count is not None:
                conn.execute(
                    """
                    UPDATE documents
                    SET status = ?, progress = ?, error_message = ?, parent_count = ?, child_count = ?
                    WHERE doc_id = ?
                    """,
                    (status, progress, error_message, parent_count, child_count, doc_id),
                )
            else:
                conn.execute(
                    "UPDATE documents SET status = ?, progress = ?, error_message = ? WHERE doc_id = ?",
                    (status, progress, error_message, doc_id),
                )

    def get_document(self, doc_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM documents WHERE doc_id = ?", (doc_id,)).fetchone()
            return dict(row) if row else None

    def list_documents(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM documents ORDER BY created_at DESC").fetchall()
            return [dict(r) for r in rows]

    def delete_document(self, doc_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))
            return cur.rowcount > 0

    def insert_chunks(self, parents: list[dict[str, Any]], children: list[dict[str, Any]]) -> None:
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO parent_chunks (parent_id, doc_id, filename, page_number, section_header, text, created_at)
                VALUES (:parent_id, :doc_id, :filename, :page_number, :section_header, :text, :created_at)
                """,
                parents,
            )
            conn.executemany(
                """
                INSERT INTO child_chunks (child_id, parent_id, doc_id, filename, page_number, section_header, text)
                VALUES (:child_id, :parent_id, :doc_id, :filename, :page_number, :section_header, :text)
                """,
                children,
            )

    def get_document_chunks(self, doc_id: str) -> dict[str, list[dict[str, Any]]]:
        with self._connect() as conn:
            parents = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM parent_chunks WHERE doc_id = ? ORDER BY page_number ASC, rowid ASC", (doc_id,)
                ).fetchall()
            ]
            children = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM child_chunks WHERE doc_id = ? ORDER BY page_number ASC, rowid ASC", (doc_id,)
                ).fetchall()
            ]
            return {"parents": parents, "children": children}

    def get_all_child_chunks(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM child_chunks").fetchall()
            return [dict(r) for r in rows]

    def get_parents_by_ids(self, parent_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not parent_ids:
            return {}
        placeholders = ",".join("?" for _ in parent_ids)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM parent_chunks WHERE parent_id IN ({placeholders})", parent_ids
            ).fetchall()
            return {r["parent_id"]: dict(r) for r in rows}

    def get_representative_parents(
        self, doc_ids: list[str] | None = None, limit: int = 8
    ) -> list[dict[str, Any]]:
        """Sample evenly spaced parent chunks across scoped documents for summaries/overviews."""
        with self._connect() as conn:
            if doc_ids:
                placeholders = ",".join("?" for _ in doc_ids)
                rows = conn.execute(
                    f"SELECT * FROM parent_chunks WHERE doc_id IN ({placeholders}) ORDER BY doc_id, page_number ASC, rowid ASC",
                    doc_ids,
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM parent_chunks ORDER BY doc_id, page_number ASC, rowid ASC"
                ).fetchall()
        all_rows = [dict(r) for r in rows]
        if len(all_rows) <= limit:
            return all_rows
        step = (len(all_rows) - 1) / max(1, limit - 1)
        return [all_rows[round(i * step)] for i in range(limit)]

    # ── Sessions ─────────────────────────────────────────────────────────────

    def list_chat_sessions(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    s.session_id AS id,
                    s.title AS title,
                    s.updated_at AS updatedAt,
                    COUNT(m.id) AS messageCount
                FROM chat_sessions s
                LEFT JOIN chat_messages m ON m.session_id = s.session_id
                GROUP BY s.session_id
                ORDER BY s.updated_at DESC
                """
            ).fetchall()
            session_rows = [dict(r) for r in rows]
            known_ids = {r["id"] for r in session_rows}

            # Include any orphan sessions present only in chat_messages
            orphans = conn.execute(
                """
                SELECT
                    session_id AS id,
                    MAX(created_at) AS updatedAt,
                    COUNT(*) AS messageCount
                FROM chat_messages
                GROUP BY session_id
                """
            ).fetchall()
            for o in orphans:
                if o["id"] not in known_ids:
                    first_user = conn.execute(
                        "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1",
                        (o["id"],),
                    ).fetchone()
                    raw_title = (first_user["content"] if first_user else "Conversation").strip()
                    title = raw_title[:42] + ("…" if len(raw_title) > 42 else "")
                    session_rows.append(
                        {
                            "id": o["id"],
                            "title": title or "New Conversation",
                            "updatedAt": o["updatedAt"],
                            "messageCount": int(o["messageCount"]),
                        }
                    )
        session_rows.sort(key=lambda r: r.get("updatedAt") or "", reverse=True)
        return session_rows

    def upsert_chat_session(self, session_id: str, title: str = "New Conversation") -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT session_id, created_at FROM chat_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE chat_sessions SET title = ?, updated_at = ? WHERE session_id = ?",
                    (title, now, session_id),
                )
            else:
                conn.execute(
                    "INSERT INTO chat_sessions (session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    (session_id, title, now, now),
                )
            cnt_row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        return {
            "id": session_id,
            "title": title,
            "updatedAt": now,
            "messageCount": int(cnt_row["cnt"]) if cnt_row else 0,
        }

    def touch_chat_session(self, session_id: str, user_message: str | None = None) -> None:
        now = datetime.now(UTC).isoformat()
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT title FROM chat_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if not existing:
                title = "New Conversation"
                if user_message:
                    trimmed = user_message.strip()
                    title = trimmed[:42] + ("…" if len(trimmed) > 42 else "")
                conn.execute(
                    "INSERT INTO chat_sessions (session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    (session_id, title or "New Conversation", now, now),
                )
            else:
                next_title = existing["title"]
                if user_message and next_title == "New Conversation":
                    trimmed = user_message.strip()
                    if trimmed:
                        next_title = trimmed[:42] + ("…" if len(trimmed) > 42 else "")
                conn.execute(
                    "UPDATE chat_sessions SET title = ?, updated_at = ? WHERE session_id = ?",
                    (next_title, now, session_id),
                )

    def delete_chat_session(self, session_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
            conn.execute("DELETE FROM chat_jobs WHERE session_id = ?", (session_id,))
            conn.execute("DELETE FROM chat_sessions WHERE session_id = ?", (session_id,))

    # ── Chat History & Jobs ──────────────────────────────────────────────────

    def add_chat_message(
        self,
        session_id: str,
        role: str,
        content: str,
        citations: list[dict[str, Any]] | None = None,
        trace: list[dict[str, Any]] | None = None,
    ) -> None:
        now = datetime.now(UTC).isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO chat_messages (session_id, role, content, citations_json, trace_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    role,
                    content,
                    json.dumps(citations or []),
                    json.dumps(trace or []),
                    now,
                ),
            )
        self.touch_chat_session(session_id, user_message=content if role == "user" else None)

    def get_chat_history(self, session_id: str, limit: int = 12) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT role, content, citations_json, trace_json, created_at
                FROM chat_messages
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()
        out = []
        for r in reversed(rows):
            out.append(
                {
                    "role": r["role"],
                    "content": r["content"],
                    "citations": json.loads(r["citations_json"]),
                    "trace": json.loads(r["trace_json"]),
                    "created_at": r["created_at"],
                }
            )
        return out

    def clear_chat_history(self, session_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
            conn.execute("DELETE FROM chat_jobs WHERE session_id = ?", (session_id,))

    def upsert_chat_job(
        self,
        job_id: str,
        session_id: str,
        status: str,
        content: str = "",
        citations: list[dict[str, Any]] | None = None,
        trace: list[dict[str, Any]] | None = None,
        followups: list[str] | None = None,
        error: str | None = None,
    ) -> None:
        now = datetime.now(UTC).isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO chat_jobs
                (job_id, session_id, status, content, citations_json, trace_json, followups_json, error, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    session_id,
                    status,
                    content,
                    json.dumps(citations or []),
                    json.dumps(trace or []),
                    json.dumps(followups or []),
                    error,
                    now,
                ),
            )

    def get_latest_chat_job(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM chat_jobs WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1",
                (session_id,),
            ).fetchone()
            if not row:
                return None
            return {
                "job_id": row["job_id"],
                "session_id": row["session_id"],
                "status": "stopped" if row["status"] == "running" else row["status"],
                "content": row["content"],
                "citations": json.loads(row["citations_json"]),
                "trace": json.loads(row["trace_json"]),
                "followups": json.loads(row["followups_json"]),
                "error": row["error"],
                "updated_at": row["updated_at"],
            }

    # ── Backup & Restore ─────────────────────────────────────────────────────

    def export_all_data(self) -> dict[str, Any]:
        with self._connect() as conn:
            docs = [dict(r) for r in conn.execute("SELECT * FROM documents ORDER BY created_at DESC").fetchall()]
            parents = [dict(r) for r in conn.execute("SELECT * FROM parent_chunks").fetchall()]
            children = [dict(r) for r in conn.execute("SELECT * FROM child_chunks").fetchall()]
            chats = [dict(r) for r in conn.execute("SELECT * FROM chat_messages ORDER BY id ASC").fetchall()]
            sessions = [dict(r) for r in conn.execute("SELECT * FROM chat_sessions ORDER BY updated_at DESC").fetchall()]
        return {
            "version": 2,
            "exported_at": datetime.now(UTC).isoformat(),
            "documents": docs,
            "parent_chunks": parents,
            "child_chunks": children,
            "chat_messages": chats,
            "chat_sessions": sessions,
        }

    def import_backup_data(self, payload: dict[str, Any]) -> dict[str, int]:
        docs = payload.get("documents", [])
        parents = payload.get("parent_chunks", [])
        children = payload.get("child_chunks", [])
        chats = payload.get("chat_messages", [])
        sessions = payload.get("chat_sessions", [])
        now = datetime.now(UTC).isoformat()
        with self._connect() as conn:
            for d in docs:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO documents
                    (doc_id, filename, file_type, size_bytes, status, progress, error_message,
                     parent_count, child_count, collection_name, file_hash, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        d["doc_id"],
                        d["filename"],
                        d["file_type"],
                        d["size_bytes"],
                        d.get("status", "ready"),
                        d.get("progress", 100),
                        d.get("error_message"),
                        d.get("parent_count", 0),
                        d.get("child_count", 0),
                        d.get("collection_name", "General"),
                        d.get("file_hash", ""),
                        d.get("created_at") or now,
                    ),
                )
            for p in parents:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO parent_chunks
                    (parent_id, doc_id, filename, page_number, section_header, text, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        p["parent_id"],
                        p["doc_id"],
                        p["filename"],
                        p["page_number"],
                        p["section_header"],
                        p["text"],
                        p.get("created_at") or now,
                    ),
                )
            for c in children:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO child_chunks
                    (child_id, parent_id, doc_id, filename, page_number, section_header, text)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        c["child_id"],
                        c["parent_id"],
                        c["doc_id"],
                        c["filename"],
                        c["page_number"],
                        c["section_header"],
                        c["text"],
                    ),
                )
            for s in sessions:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO chat_sessions (session_id, title, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        s["session_id"],
                        s.get("title", "New Conversation"),
                        s.get("created_at") or now,
                        s.get("updated_at") or now,
                    ),
                )
            for m in chats:
                conn.execute(
                    """
                    INSERT INTO chat_messages (session_id, role, content, citations_json, trace_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        m["session_id"],
                        m["role"],
                        m["content"],
                        m.get("citations_json", "[]"),
                        m.get("trace_json", "[]"),
                        m.get("created_at") or now,
                    ),
                )
        return {
            "documents": len(docs),
            "parents": len(parents),
            "children": len(children),
            "chats": len(chats),
            "sessions": len(sessions),
        }
