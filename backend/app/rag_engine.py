"""Hybrid Retrieval & Corrective RAG engine (Qdrant dense + persisted bm25s + Cross-Encoder + Ollama/OpenAI)."""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncGenerator, Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import bm25s
import httpx
import numpy as np
from qdrant_client import QdrantClient
from qdrant_client import models as qmodels
from sentence_transformers import CrossEncoder, SentenceTransformer

from .config import Settings
from .database import MetadataDB
from .hardware_advisor import HardwareAdvisor
from .logging_config import get_logger

logger = get_logger("owly_rag.engine")


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9_]+", text.lower())


_GREETING_RE = re.compile(
    r"^(?:"
    r"h(?:i+|e+y+|e+l+o+|owdy|iya)|"
    r"yo+|sup|greetings|namaste|"
    r"good\s+(?:morning|afternoon|evening)|"
    r"(?:hi|hello|hey)\s+(?:owly|there|rag)|"
    r"how\s+are\s+you(?:\s+doing)?|"
    r"who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do|"
    r"thank(?:s|\s+you)(?:\s+so\s+much)?"
    r")[!.,?\s]*$",
    re.IGNORECASE,
)


def _build_greeting_reply(query: str, docs: list[dict[str, Any]]) -> str | None:
    cleaned = query.strip()
    if not cleaned or not _GREETING_RE.match(cleaned):
        return None
    lower = cleaned.lower()
    if lower.startswith("thank"):
        return "You're welcome! Ask me anything else about your uploaded documents whenever you're ready."
    doc_count = len(docs)
    if doc_count == 0:
        return (
            "Hi! I'm **Owly**, your local document assistant in **Owly RAG**. "
            "Upload files or a folder in the Knowledge Base on the left, and ask me any question about them!"
        )
    names = ", ".join(f"`{d['filename']}`" for d in docs[:3])
    extra = f" and {doc_count - 3} more" if doc_count > 3 else ""
    return (
        f"Hi! I'm **Owly**, your local assistant in **Owly RAG**. "
        f"I have **{doc_count}** ready {('file' if doc_count == 1 else 'files')} loaded ({names}{extra}). "
        "Ask me any question about your documents!"
    )


PERSONA_PROMPTS: dict[str, str] = {
    "default": "You are a precision, strictly grounded AI research assistant.",
    "analyst": "You are a rigorous financial and technical analyst. Highlight metrics, trends, risks, and discrepancies concisely.",
    "summarizer": "You are an executive summarizer. Deliver crisp bullet points, key takeaways, and structured headings.",
    "coder": "You are a senior software engineer. Focus on architecture, symbols, edge cases, and clean code explanations.",
    "eli5": "You are a clear, patient teacher. Explain complex concepts simply using plain language and short examples.",
}

MODE_INSTRUCTIONS: dict[str, str] = {
    "qa": "Answer the question directly using only retrieved facts.",
    "chat": "Chat naturally, helpfully, and clearly as Owly.",
    "summarize": "Provide a structured executive summary covering the core points from the retrieved context.",
    "compare": "Compare and contrast the relevant facts, approaches, or documents side-by-side (use a Markdown table when helpful).",
    "extract": "Extract key entities, numbers, dates, and structured facts cleanly into bullet points or a table.",
    "quiz": "Generate 5 clear study questions with concise grounded answers and citations based on the retrieved context.",
}

_CHAT_INTENT_RE = re.compile(
    r"^(?:"
    r"(?:write|create|generate|compose|draft|code|implement|debug|fix|refactor)\s+(?:a|an|me|the|some)?\s*"
    r"(?:[\w\-\s]{0,24})?\b(?:poem|story|joke|haiku|email|letter|essay|script|function|class|program|snippet|query|python|javascript|typescript|sql|html|css|bash|regex|hello\s*world)\b|"
    r"(?:tell\s+me\s+(?:a\s+joke|something\s+funny|about\s+yourself)|sing\s+a\s+song|surprise\s+me)|"
    r"(?:how\s+are\s+you|how\s+is\s+it\s+going|what'?s\s+up|nice\s+to\s+meet\s+you|good\s+night|bye|goodbye|see\s+you|cool|nice|awesome|ok(?:ay)?|got\s+it|makes\s+sense)|"
    r"(?:translate\s+.+\s+(?:to|into)\s+[a-z]+)|"
    r"(?:what\s+did\s+i\s+(?:just\s+)?(?:ask|say)|can\s+we\s+chat|let'?s\s+chat|just\s+chatting)|"
    r"(?:calculate|compute|solve)\s+[\d\s+\-*/().^%=x]+|"
    r"[\d\s+\-*/().^%=?]{3,}$"
    r")",
    re.IGNORECASE,
)

_BROAD_SUMMARY_RE = re.compile(
    r"\b(?:summarize|summary|overview|key\s+takeaways|main\s+points|tldr|tl;dr|what\s+is\s+(?:this|the)\s+(?:file|doc|document)\s+about)\b",
    re.IGNORECASE,
)

_FOLLOWUP_PRONOUN_RE = re.compile(
    r"\b(?:it|its|they|them|their|that|those|this|these|above|previous|former|latter)\b",
    re.IGNORECASE,
)


def _should_chat_directly(
    query: str, docs: list[dict[str, Any]], query_mode: str
) -> bool:
    """Route general conversation, coding/math tasks, or zero-doc queries directly to normal chat."""
    if query_mode == "chat" or not docs:
        return True
    cleaned = query.strip()
    if not cleaned:
        return False
    # If the user explicitly asks about uploaded files/documents, always run RAG.
    if re.search(r"\b(?:file|files|doc|docs|document|documents|pdf|uploaded|page|section)\b", cleaned, re.I):
        return False
    return bool(_CHAT_INTENT_RE.match(cleaned))


class RAGEngine:
    def __init__(self, settings: Settings, db: MetadataDB, advisor: HardwareAdvisor) -> None:
        self.settings = settings
        self.db = db
        self.advisor = advisor

        if settings.qdrant_url:
            self.qdrant = QdrantClient(url=settings.qdrant_url, timeout=15)
        else:
            self.qdrant = QdrantClient(path=str(settings.qdrant_local_path))

        self._model_lock = threading.Lock()
        self._embedder: SentenceTransformer | None = None
        self._embedder_name: str = ""
        self._reranker: CrossEncoder | None = None
        self._reranker_name: str = ""

        self._bm25_lock = threading.Lock()
        self._bm25: bm25s.BM25 | None = None
        self._bm25_docs: list[dict[str, Any]] = []

        # High-speed LRU caches & pooled HTTP client
        self._cache_lock = threading.Lock()
        self._query_vec_cache: OrderedDict[tuple[str, str], list[float]] = OrderedDict()
        self._retrieval_cache: OrderedDict[tuple[str, int, tuple[str, ...]], list[dict[str, Any]]] = OrderedDict()
        self._search_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="rag-search")
        self._http_client: httpx.AsyncClient | None = None

        self._load_or_build_bm25()

    def _get_http_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            limits = httpx.Limits(max_connections=30, max_keepalive_connections=15)
            self._http_client = httpx.AsyncClient(timeout=None, limits=limits)
        return self._http_client

    def _invalidate_caches(self) -> None:
        with self._cache_lock:
            self._retrieval_cache.clear()

    def warmup_sync(self) -> None:
        """Pre-load already-cached embedding & cross-encoder models without triggering surprise downloads."""
        try:
            from .hardware_advisor import _scan_hf_cache

            cached = _scan_hf_cache()
            emb_name, _, rerank_name, _ = self._active_models()
            if emb_name in cached:
                self._get_embedder()
            if rerank_name in cached:
                self._get_reranker()
        except Exception:
            pass

    def _active_models(self, llm_override: str | None = None) -> tuple[str, int, str, str]:
        rec = self.advisor.get_active_recommendation()
        emb_name = self.settings.override_embedding_model or rec.embedding_model
        rerank_name = self.settings.override_reranker_model or rec.reranker_model
        llm_name = (
            llm_override
            or self.advisor.active_llm_override
            or self.settings.override_llm_model
            or rec.llm_model
        )
        return emb_name, rec.embedding_dim, rerank_name, llm_name

    def _collection_name(self, dim: int) -> str:
        return f"rag_chunks_{dim}"

    def _device(self) -> str:
        acc = self.advisor.profile.accelerator
        if acc == "cuda":
            return "cuda"
        if acc == "mps":
            return "mps"
        return "cpu"

    def release_model_sync(self, model_id: str, kind: str) -> None:
        """Unload an embedding or reranker instance from RAM so cache deletion succeeds cleanly."""
        import gc

        with self._model_lock:
            if kind == "embedding" and self._embedder_name == model_id:
                self._embedder = None
                self._embedder_name = ""
            elif kind == "reranker" and self._reranker_name == model_id:
                self._reranker = None
                self._reranker_name = ""
        gc.collect()

    def _get_embedder(self) -> tuple[SentenceTransformer, int]:
        emb_name, _, _, _ = self._active_models()
        with self._model_lock:
            if self._embedder is None or self._embedder_name != emb_name:
                self._embedder = SentenceTransformer(emb_name, device=self._device())
                self._embedder_name = emb_name
            embedder = self._embedder
            dim_fn = getattr(embedder, "get_embedding_dimension", None) or embedder.get_sentence_embedding_dimension
            dim = dim_fn()
            if dim is None:
                raise RuntimeError(f"Could not determine embedding dimension for {emb_name}")
            return embedder, int(dim)

    def _get_reranker(self) -> CrossEncoder:
        _, _, rerank_name, _ = self._active_models()
        with self._model_lock:
            if self._reranker is None or self._reranker_name != rerank_name:
                self._reranker = CrossEncoder(rerank_name, device=self._device())
                self._reranker_name = rerank_name
            return self._reranker

    def _ensure_collection(self, dim: int) -> str:
        col = self._collection_name(dim)
        existing = {c.name for c in self.qdrant.get_collections().collections}
        if col not in existing:
            self.qdrant.create_collection(
                collection_name=col,
                vectors_config=qmodels.VectorParams(size=dim, distance=qmodels.Distance.COSINE),
            )
        return col

    def _bm25_manifest_path(self):
        return self.settings.bm25_index_dir / "manifest.json"

    def _load_or_build_bm25(self) -> None:
        docs = self.db.get_all_child_chunks()
        manifest_path = self._bm25_manifest_path()
        expected_ids = [d["child_id"] for d in docs]
        if docs and manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if manifest.get("child_ids") == expected_ids:
                    retriever = bm25s.BM25.load(str(self.settings.bm25_index_dir), load_corpus=False)
                    with self._bm25_lock:
                        self._bm25_docs = docs
                        self._bm25 = retriever
                    return
            except Exception:
                pass
        self.rebuild_bm25()

    def rebuild_bm25(self) -> None:
        with self._bm25_lock:
            self._bm25_docs = self.db.get_all_child_chunks()
            if self._bm25_docs:
                corpus = [
                    _tokenize(f"{d.get('filename', '')} {d.get('section_header', '')} {d['text']}")
                    for d in self._bm25_docs
                ]
                retriever = bm25s.BM25()
                retriever.index(corpus, show_progress=False)
                self._bm25 = retriever
                try:
                    retriever.save(str(self.settings.bm25_index_dir), corpus=None)
                    self._bm25_manifest_path().write_text(
                        json.dumps({"child_ids": [d["child_id"] for d in self._bm25_docs]}),
                        encoding="utf-8",
                    )
                except Exception:
                    pass
            else:
                self._bm25 = None
                try:
                    if self._bm25_manifest_path().exists():
                        self._bm25_manifest_path().unlink()
                except OSError:
                    pass

    def index_children_sync(
        self,
        children: list[dict[str, Any]],
        progress_cb: Callable[[int], None] | None = None,
    ) -> None:
        if not children:
            return
        embedder, dim = self._get_embedder()
        col = self._ensure_collection(dim)

        batch_size = 64
        total = len(children)
        for i in range(0, total, batch_size):
            batch = children[i : i + batch_size]
            texts = [str(c.get("embed_text") or c["text"]) for c in batch]
            vectors = embedder.encode(texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False)
            points = [
                qmodels.PointStruct(
                    id=c["child_id"],
                    vector=vec.tolist(),
                    payload={
                        "child_id": c["child_id"],
                        "parent_id": c["parent_id"],
                        "doc_id": c["doc_id"],
                        "filename": c["filename"],
                        "page_number": c["page_number"],
                        "section_header": c["section_header"],
                        "text": c["text"],
                    },
                )
                for c, vec in zip(batch, vectors, strict=True)
            ]
            self.qdrant.upsert(collection_name=col, points=points)
            if progress_cb:
                pct = 35 + int(((i + len(batch)) / total) * 60)
                progress_cb(min(95, pct))

        self.rebuild_bm25()
        self._invalidate_caches()

    def delete_document_vectors(self, doc_id: str) -> None:
        try:
            collections = self.qdrant.get_collections().collections
        except Exception:
            collections = []
        for c in collections:
            if c.name.startswith("rag_chunks_"):
                try:
                    self.qdrant.delete(
                        collection_name=c.name,
                        points_selector=qmodels.FilterSelector(
                            filter=qmodels.Filter(
                                must=[qmodels.FieldCondition(key="doc_id", match=qmodels.MatchValue(value=doc_id))]
                            )
                        ),
                    )
                except Exception:
                    pass
        self.rebuild_bm25()
        self._invalidate_caches()

    def reindex_all_sync(self) -> int:
        children = self.db.get_all_child_chunks()
        if not children:
            return 0
        self.index_children_sync(children)
        return len(children)

    def _get_query_vector(self, query: str) -> tuple[list[float], str]:
        emb_name, _, _, _ = self._active_models()
        cache_key = (emb_name, query)
        with self._cache_lock:
            cached = self._query_vec_cache.get(cache_key)
            if cached is not None:
                self._query_vec_cache.move_to_end(cache_key)
                _, dim = self._get_embedder()
                return cached, self._ensure_collection(dim)

        embedder, dim = self._get_embedder()
        col = self._ensure_collection(dim)
        vec = embedder.encode([query], normalize_embeddings=True, show_progress_bar=False)[0].tolist()
        with self._cache_lock:
            self._query_vec_cache[cache_key] = vec
            if len(self._query_vec_cache) > 128:
                self._query_vec_cache.popitem(last=False)
        return vec, col

    def _sparse_bm25_search(self, query: str, allowed_ids: set | None) -> list[dict[str, Any]]:
        sparse_hits: list[dict[str, Any]] = []
        q_tokens = _tokenize(query)
        if not q_tokens:
            return sparse_hits
        with self._bm25_lock:
            if self._bm25 is not None and self._bm25_docs:
                weight_mask = None
                if allowed_ids is not None:
                    weight_mask = np.array(
                        [doc.get("doc_id") in allowed_ids for doc in self._bm25_docs],
                        dtype=bool,
                    )
                    if not weight_mask.any():
                        return sparse_hits
                k = min(40, len(self._bm25_docs))
                if weight_mask is not None:
                    indices, scores = self._bm25.retrieve(
                        [q_tokens],
                        k=k,
                        weight_mask=weight_mask,
                        show_progress=False,
                    )
                else:
                    indices, scores = self._bm25.retrieve(
                        [q_tokens],
                        k=k,
                        show_progress=False,
                    )
                for idx, score in zip(indices[0], scores[0], strict=True):
                    if float(score) <= 0.0:
                        break
                    doc = self._bm25_docs[int(idx)]
                    if allowed_ids and doc.get("doc_id") not in allowed_ids:
                        continue
                    sparse_hits.append(doc)
        return sparse_hits

    def _hybrid_search_with_stats_sync(
        self,
        query: str,
        top_k: int,
        doc_ids: list[str] | None = None,
    ) -> tuple[list[dict[str, Any]], dict[str, int]]:
        allowed_ids = set(doc_ids) if doc_ids else None
        qdrant_filter = (
            qmodels.Filter(
                must=[qmodels.FieldCondition(key="doc_id", match=qmodels.MatchAny(any=list(allowed_ids)))]
            )
            if allowed_ids
            else None
        )

        # Run Sparse BM25 in parallel with Dense Embedding + Qdrant lookup
        bm25_future = self._search_pool.submit(self._sparse_bm25_search, query, allowed_ids)

        # 1. Dense Semantic Search (Qdrant)
        q_vec, col = self._get_query_vector(query)
        dense_hits: list[dict[str, Any]] = []
        res = self.qdrant.query_points(
            collection_name=col, query=q_vec, query_filter=qdrant_filter, limit=40
        )
        for pt in res.points:
            if pt.payload:
                dense_hits.append(dict(pt.payload))

        # 2. Collect Sparse Lexical Search (BM25)
        sparse_hits = bm25_future.result()

        # 3. Reciprocal Rank Fusion (RRF, k=60)
        rrf_k = 60.0
        fused_scores: dict[str, float] = {}
        payload_map: dict[str, dict[str, Any]] = {}

        for rank, item in enumerate(dense_hits, start=1):
            cid = item["child_id"]
            fused_scores[cid] = fused_scores.get(cid, 0.0) + (1.0 / (rrf_k + rank))
            payload_map[cid] = item

        for rank, item in enumerate(sparse_hits, start=1):
            cid = item["child_id"]
            fused_scores[cid] = fused_scores.get(cid, 0.0) + (1.0 / (rrf_k + rank))
            payload_map[cid] = item

        ordered_ids = sorted(fused_scores.keys(), key=lambda cid: fused_scores[cid], reverse=True)[:top_k]
        results = []
        for cid in ordered_ids:
            entry = dict(payload_map[cid])
            entry["rrf_score"] = round(fused_scores[cid], 5)
            results.append(entry)
        stats = {
            "dense_hits": len(dense_hits),
            "bm25_hits": len(sparse_hits),
            "fused_candidates": len(results),
        }
        return results, stats

    def _rerank_and_expand_parents_sync(self, query: str, candidates: list[dict[str, Any]], top_k: int) -> list[dict[str, Any]]:
        if not candidates:
            return []
        reranker = self._get_reranker()
        pairs = [(query, c["text"]) for c in candidates]
        scores = reranker.predict(pairs)

        scored = []
        for cand, score in zip(candidates, scores, strict=True):
            item = dict(cand)
            item["rerank_score"] = float(score)
            scored.append(item)
        scored.sort(key=lambda x: x["rerank_score"], reverse=True)

        selected_parent_ids: list[str] = []
        best_child_by_parent: dict[str, dict[str, Any]] = {}
        for item in scored:
            pid = item["parent_id"]
            if pid not in best_child_by_parent:
                selected_parent_ids.append(pid)
                best_child_by_parent[pid] = item
            if len(selected_parent_ids) >= top_k:
                break

        parents_map = self.db.get_parents_by_ids(selected_parent_ids)
        final_contexts: list[dict[str, Any]] = []
        for pid in selected_parent_ids:
            parent = parents_map.get(pid)
            if not parent:
                continue
            child_meta = best_child_by_parent[pid]
            final_contexts.append(
                {
                    "parent_id": pid,
                    "doc_id": parent["doc_id"],
                    "filename": parent["filename"],
                    "page_number": parent["page_number"],
                    "section_header": parent["section_header"],
                    "text": parent["text"],
                    "matched_excerpt": child_meta["text"],
                    "rerank_score": round(child_meta["rerank_score"], 4),
                    "rrf_score": child_meta.get("rrf_score", 0.0),
                }
            )
        return final_contexts

    def _is_external_openai(self, llm_name: str) -> bool:
        return bool(
            self.settings.openai_base_url.strip()
            and self.settings.openai_api_key.strip()
            and (llm_name.startswith("openai:") or llm_name == "external")
        )

    def _resolve_openai_model(self, llm_name: str) -> str:
        if llm_name.startswith("openai:"):
            return llm_name.split(":", 1)[1].strip() or self.settings.openai_model or "gpt-4o-mini"
        return self.settings.openai_model or "gpt-4o-mini"

    @staticmethod
    def _supports_think_toggle(llm_name: str) -> bool:
        lower = llm_name.lower()
        return lower.startswith(("qwen3", "gemma4", "deepseek-r1", "gpt-oss"))

    def _build_ollama_payload(
        self,
        model: str,
        messages: list[dict[str, str]],
        stream: bool,
        temperature: float,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": stream,
            "keep_alive": "30m",
            "options": {"temperature": temperature},
        }
        # Disable hidden reasoning chains on hybrid thinking models to keep RAG fast and loop-free
        if self._supports_think_toggle(model):
            payload["think"] = False
        return payload

    async def _llm_complete(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.0,
        llm_override: str | None = None,
    ) -> str:
        _, _, _, llm_name = self._active_models(llm_override)
        if self._is_external_openai(llm_name):
            model = self._resolve_openai_model(llm_name)
            base = self.settings.openai_base_url.rstrip("/")
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{base}/chat/completions",
                    headers={"Authorization": f"Bearer {self.settings.openai_api_key}"},
                    json={"model": model, "messages": messages, "temperature": temperature, "stream": False},
                )
                resp.raise_for_status()
                choices = resp.json().get("choices") or []
                return (choices[0].get("message", {}).get("content", "") if choices else "").strip()

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{self.settings.ollama_base_url.rstrip('/')}/api/chat",
                json=self._build_ollama_payload(llm_name, messages, stream=False, temperature=temperature),
            )
            resp.raise_for_status()
            return resp.json().get("message", {}).get("content", "").strip()

    async def _stream_llm_tokens(
        self,
        messages: list[dict[str, str]],
        temperature: float,
        llm_name: str,
    ) -> AsyncGenerator[str, None]:
        client = self._get_http_client()
        if self._is_external_openai(llm_name):
            model = self._resolve_openai_model(llm_name)
            base = self.settings.openai_base_url.rstrip("/")
            async with client.stream(
                "POST",
                f"{base}/chat/completions",
                headers={"Authorization": f"Bearer {self.settings.openai_api_key}"},
                json={"model": model, "messages": messages, "temperature": temperature, "stream": True},
            ) as resp:
                if resp.status_code >= 400:
                    err_txt = (await resp.aread()).decode("utf-8", "ignore")
                    raise RuntimeError(f"External LLM failed ({resp.status_code}): {err_txt}")
                async for line in resp.aiter_lines():
                    stripped = line.strip()
                    if not stripped.startswith("data:"):
                        continue
                    data_str = stripped[5:].strip()
                    if data_str == "[DONE]":
                        break
                    chunk = json.loads(data_str)
                    delta = ((chunk.get("choices") or [{}])[0].get("delta") or {}).get("content", "")
                    if delta:
                        yield delta
            return

        async with client.stream(
            "POST",
            f"{self.settings.ollama_base_url.rstrip('/')}/api/chat",
            json=self._build_ollama_payload(llm_name, messages, stream=True, temperature=temperature),
        ) as resp:
            if resp.status_code >= 400:
                err_txt = (await resp.aread()).decode("utf-8", "ignore")
                raise RuntimeError(f"Ollama generation failed ({resp.status_code}): {err_txt}")
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                chunk = json.loads(line)
                delta = chunk.get("message", {}).get("content", "")
                if delta:
                    yield delta

    async def _grade_relevance(self, query: str, contexts: list[dict[str, Any]]) -> tuple[bool, str]:
        if not contexts:
            return False, "No candidate passages retrieved."
        preview = "\n\n".join(
            f"[{i+1}] ({c['filename']} p.{c['page_number']}): {c['text'][:450]}"
            for i, c in enumerate(contexts[:3])
        )
        prompt = (
            "You are a strict retrieval relevance grader.\n"
            f"User Question: {query}\n\n"
            f"Retrieved Excerpts:\n{preview}\n\n"
            "Do these excerpts contain concrete information that helps answer the question? "
            "Respond ONLY with YES or NO followed by a 1-sentence reason."
        )
        try:
            verdict = await self._llm_complete([{"role": "user", "content": prompt}], temperature=0.0)
            is_relevant = verdict.upper().startswith("YES")
            return is_relevant, verdict
        except Exception:
            return True, "Bypassed LLM grading; trusting cross-encoder scores."

    async def _rewrite_query(self, query: str, history: list[dict[str, Any]]) -> str:
        hist_text = "\n".join(f"{m['role']}: {m['content'][:200]}" for m in history[-4:])
        prompt = (
            "Rewrite and expand the following search query to maximize recall in a hybrid "
            "semantic + keyword search engine. Include key synonyms or resolved pronouns from history. "
            "Output ONLY the improved search query with no quotes or preamble.\n\n"
            f"Conversation History:\n{hist_text or 'None'}\n\nOriginal Query: {query}"
        )
        try:
            rewritten = await self._llm_complete([{"role": "user", "content": prompt}], temperature=0.2)
            return rewritten.strip().strip('"') or query
        except Exception:
            return query

    @staticmethod
    def _build_followups(contexts: list[dict[str, Any]], user_query: str) -> list[str]:
        sections = []
        for c in contexts:
            sec = (c.get("section_header") or "").strip()
            if sec and sec not in {"Text Body", "Document Overview", "Introduction"} and sec not in sections:
                sections.append(sec)
        followups: list[str] = []
        if sections:
            followups.append(f"Explain more details from '{sections[0]}'")
        if len(sections) > 1:
            followups.append(f"Compare '{sections[0]}' and '{sections[1]}'")
        return followups[:2]

    async def stream_chat(
        self,
        session_id: str,
        user_query: str,
        doc_ids: list[str] | None = None,
        temperature: float = 0.1,
        top_k: int | None = None,
        system_persona: str = "default",
        query_mode: str = "qa",
        llm_model: str | None = None,
    ) -> AsyncGenerator[str, None]:
        """Full Corrective RAG streaming pipeline yielding structured SSE events."""

        def sse(event_type: str, payload: Any) -> str:
            return f"data: {json.dumps({'type': event_type, 'data': payload})}\n\n"

        trace_steps: list[dict[str, Any]] = []

        def emit_trace(
            step: str,
            status: str,
            detail: str,
            duration_ms: int = 0,
            meta: dict[str, Any] | None = None,
        ) -> str:
            entry: dict[str, Any] = {
                "step": step,
                "status": status,
                "detail": detail,
                "duration_ms": duration_ms,
                "meta": meta or {},
            }
            trace_steps.append(entry)
            return sse("trace", entry)

        def emit_stage(stage: str, label: str, pass_num: int = 1) -> str:
            return sse("stage", {"stage": stage, "pass": pass_num, "label": label})

        docs = [d for d in self.db.list_documents() if d["status"] == "ready"]
        if doc_ids:
            allowed_set = set(doc_ids)
            docs = [d for d in docs if d["doc_id"] in allowed_set]

        greeting_reply = _build_greeting_reply(user_query, docs)
        if greeting_reply is not None:
            self.db.add_chat_message(session_id, "user", user_query)
            yield emit_trace(
                "Owly Greeting",
                "completed",
                "Answered greeting directly without needing a file search.",
                1,
                meta={"pass": 1, "ready_docs": len(docs)},
            )
            yield sse("sources", [])
            yield sse("token", greeting_reply)
            self.db.add_chat_message(
                session_id=session_id,
                role="assistant",
                content=greeting_reply,
                citations=[],
                trace=trace_steps,
            )
            yield sse("done", {"citations": [], "trace": trace_steps, "followups": []})
            return

        _, _, _, llm_name = self._active_models(llm_model)

        if not self._is_external_openai(llm_name):
            ollama_status = await self.advisor.get_ollama_status()
            if not ollama_status["reachable"]:
                yield sse(
                    "error",
                    f"Local LLM runtime (Ollama) is not reachable at {self.settings.ollama_base_url}. "
                    "Please start Ollama (`ollama serve`).",
                )
                return

            installed = ollama_status.get("installed_models", [])
            if installed and not any(
                m == llm_name or m.startswith(llm_name + "-") or (":" not in llm_name and m == f"{llm_name}:latest")
                for m in installed
            ):
                yield sse(
                    "error",
                    f"Recommended model '{llm_name}' is not installed in Ollama yet. "
                    "Open the Hardware & Model Manager modal and click 'Install'.",
                )
                return

        history = self.db.get_chat_history(session_id, limit=8)
        self.db.add_chat_message(session_id, "user", user_query)

        # Route general conversation / zero-doc chat / explicit "Normal Chat" mode cleanly to Ollama
        if _should_chat_directly(user_query, docs, query_mode):
            persona_line = PERSONA_PROMPTS.get(system_persona, PERSONA_PROMPTS["default"])
            file_note = (
                f"The user currently has {len(docs)} ready document(s) in their Knowledge Base: "
                + ", ".join(d["filename"] for d in docs[:5])
                + "."
                if docs
                else "The user has not uploaded any documents yet."
            )
            chat_system = (
                f"{persona_line}\n"
                "You are Owly, a smart, friendly, and accurate AI assistant inside Owly RAG.\n"
                f"{file_note}\n"
                "Answer conversationally, clearly, and helpfully. Do NOT invent or fake document citations when answering general questions."
            )
            chat_messages: list[dict[str, str]] = [{"role": "system", "content": chat_system}]
            for turn in history[-8:]:
                chat_messages.append({"role": turn["role"], "content": turn["content"]})
            chat_messages.append({"role": "user", "content": user_query})

            yield sse("sources", [])
            yield emit_stage("generate", f"Chatting with {llm_name}…", 1)
            t_gen = time.perf_counter()
            first_token_ms: int | None = None
            full_answer = ""
            try:
                if self._is_external_openai(llm_name):
                    async for delta in self._stream_llm_tokens(chat_messages, max(0.3, temperature), llm_name):
                        if first_token_ms is None:
                            first_token_ms = int((time.perf_counter() - t_gen) * 1000)
                        full_answer += delta
                        yield sse("token", delta)
                else:
                    client = self._get_http_client()
                    async with client.stream(
                        "POST",
                        f"{self.settings.ollama_base_url.rstrip('/')}/api/chat",
                        json=self._build_ollama_payload(
                            llm_name, chat_messages, stream=True, temperature=max(0.3, temperature)
                        ),
                    ) as resp:
                        if resp.status_code >= 400:
                            err_txt = (await resp.aread()).decode("utf-8", "ignore")
                            yield sse("error", f"Ollama generation failed ({resp.status_code}): {err_txt}")
                            return
                        async for line in resp.aiter_lines():
                            if not line.strip():
                                continue
                            chunk = json.loads(line)
                            delta = chunk.get("message", {}).get("content", "")
                            if delta:
                                if first_token_ms is None:
                                    first_token_ms = int((time.perf_counter() - t_gen) * 1000)
                                full_answer += delta
                                yield sse("token", delta)
            except Exception as exc:
                yield sse("error", f"Streaming generation interrupted: {exc}")
                return

            dt_gen = int((time.perf_counter() - t_gen) * 1000)
            word_count = len(full_answer.split())
            words_per_sec = round(word_count / max(0.1, dt_gen / 1000.0), 1)
            ttft_ms = first_token_ms if first_token_ms is not None else dt_gen
            yield emit_trace(
                "Normal Chat",
                "completed",
                f"Chatted directly using {llm_name} ({words_per_sec} words/sec).",
                dt_gen,
                meta={
                    "model": llm_name,
                    "ttft_ms": ttft_ms,
                    "words": word_count,
                    "chars": len(full_answer),
                    "words_per_sec": words_per_sec,
                },
            )
            self.db.add_chat_message(
                session_id=session_id,
                role="assistant",
                content=full_answer,
                citations=[],
                trace=trace_steps,
            )
            yield sse("done", {"citations": [], "trace": trace_steps, "followups": []})
            return

        effective_top_k = top_k or self.settings.rerank_top_k
        active_query = user_query
        if history and _FOLLOWUP_PRONOUN_RE.search(user_query):
            active_query = await self._rewrite_query(user_query, history)
        contexts: list[dict[str, Any]] = []
        is_relevant = False

        if docs:
            doc_scope_key = tuple(sorted(doc_ids)) if doc_ids else ()
            for attempt in range(self.settings.max_crag_retries + 1):
                pass_num = attempt + 1
                yield emit_stage(
                    "search",
                    "Looking through your files for matching parts…"
                    if pass_num == 1
                    else "Searching your files again with better keywords…",
                    pass_num,
                )

                cache_key = (active_query, effective_top_k, doc_scope_key)
                cached_contexts: list[dict[str, Any]] | None = None
                with self._cache_lock:
                    if cache_key in self._retrieval_cache:
                        self._retrieval_cache.move_to_end(cache_key)
                        cached_contexts = self._retrieval_cache[cache_key]

                if cached_contexts is not None:
                    contexts = cached_contexts
                    top_cached = round(float(contexts[0].get("rerank_score", 0.0)), 2) if contexts else None
                    yield emit_trace(
                        f"Hybrid Search & Rerank (Pass {pass_num})",
                        "completed",
                        f"Found {len(contexts)} top sections instantly from memory.",
                        1,
                        meta={
                            "pass": pass_num,
                            "windows": len(contexts),
                            "top_score": top_cached,
                            "cache_hit": True,
                        },
                    )
                else:
                    t0 = time.perf_counter()
                    candidates, s_stats = await asyncio.to_thread(
                        self._hybrid_search_with_stats_sync, active_query, self.settings.hybrid_top_k, doc_ids
                    )
                    dt = int((time.perf_counter() - t0) * 1000)
                    yield emit_trace(
                        f"Hybrid Search (Pass {pass_num})",
                        "completed",
                        f"Checked meaning ({s_stats['dense_hits']}) + exact words ({s_stats['bm25_hits']}) and found {len(candidates)} candidate parts.",
                        dt,
                        meta={
                            "pass": pass_num,
                            "dense_hits": s_stats["dense_hits"],
                            "bm25_hits": s_stats["bm25_hits"],
                            "candidates": len(candidates),
                            "cache_hit": False,
                        },
                    )

                    yield emit_stage("rerank", "Picking the best matching sections…", pass_num)
                    t1 = time.perf_counter()
                    contexts = await asyncio.to_thread(
                        self._rerank_and_expand_parents_sync, active_query, candidates, effective_top_k
                    )
                    dt1 = int((time.perf_counter() - t1) * 1000)
                    with self._cache_lock:
                        self._retrieval_cache[cache_key] = contexts
                        if len(self._retrieval_cache) > 64:
                            self._retrieval_cache.popitem(last=False)
                    top_rr = round(float(contexts[0].get("rerank_score", 0.0)), 2) if contexts else None
                    yield emit_trace(
                        f"Cross-Encoder Reranking (Pass {pass_num})",
                        "completed",
                        f"Picked the top {len(contexts)} most relevant sections out of {len(candidates)}.",
                        dt1,
                        meta={
                            "pass": pass_num,
                            "candidates": len(candidates),
                            "windows": len(contexts),
                            "top_score": top_rr,
                            "cache_hit": False,
                        },
                    )

                yield emit_stage("grade", "Checking if these sections answer your question…", pass_num)
                t2 = time.perf_counter()
                top_rerank = float(contexts[0].get("rerank_score", -99.0)) if contexts else -99.0
                if contexts and top_rerank >= -1.5:
                    is_relevant = True
                    reason = "Verified! Found a clear, strong match in your files."
                    dt2 = max(1, int((time.perf_counter() - t2) * 1000))
                elif not contexts or top_rerank < -4.0:
                    is_relevant = False
                    reason = (
                        "These parts don't look related yet — trying different search words."
                        if attempt < self.settings.max_crag_retries
                        else "None of your uploaded files appear to cover this topic."
                    )
                    dt2 = max(1, int((time.perf_counter() - t2) * 1000))
                else:
                    is_relevant, raw_reason = await self._grade_relevance(user_query, contexts)
                    reason = (
                        "Verified! The AI confirmed these sections fit your question."
                        if is_relevant
                        else (
                            "Not quite right yet — rephrasing your question to search again."
                            if attempt < self.settings.max_crag_retries
                            else "The AI checked the files and couldn't find a direct answer."
                        )
                    )
                    dt2 = int((time.perf_counter() - t2) * 1000)

                yield emit_trace(
                    f"Corrective RAG Grading (Pass {pass_num})",
                    "completed" if is_relevant else "retry",
                    reason,
                    dt2,
                    meta={
                        "pass": pass_num,
                        "verdict": "approved" if is_relevant else "denied",
                        "top_score": round(top_rerank, 2) if contexts else None,
                    },
                )

                if is_relevant or attempt >= self.settings.max_crag_retries:
                    break

                yield emit_stage("rewrite", "Rephrasing your question for a better search…", pass_num)
                t3 = time.perf_counter()
                active_query = await self._rewrite_query(user_query, history)
                dt3 = int((time.perf_counter() - t3) * 1000)
                yield emit_trace(
                    "Query Rewriting & Expansion",
                    "completed",
                    f"Rephrased question to: '{active_query}'",
                    dt3,
                    meta={"pass": pass_num, "rewritten_query": active_query},
                )

        # Broad summary / overview boost: ensure beginning/middle/end document coverage
        if (query_mode in {"summarize", "quiz"} or _BROAD_SUMMARY_RE.search(user_query)) and docs:
            rep_parents = self.db.get_representative_parents(doc_ids, limit=max(effective_top_k, 6))
            existing_pids = {c["parent_id"] for c in contexts}
            for rp in rep_parents:
                if rp["parent_id"] not in existing_pids:
                    contexts.append(
                        {
                            "parent_id": rp["parent_id"],
                            "doc_id": rp["doc_id"],
                            "filename": rp["filename"],
                            "page_number": rp["page_number"],
                            "section_header": rp["section_header"],
                            "text": rp["text"],
                            "matched_excerpt": rp["text"][:220],
                            "rerank_score": 0.0,
                            "rrf_score": 0.0,
                        }
                    )
                    existing_pids.add(rp["parent_id"])
            if contexts:
                is_relevant = True

        # Drop irrelevant document contexts so unrelated files are never cited or passed to generation
        if not is_relevant:
            contexts = []

        # If no relevant context was found in documents, return a clear "not found" answer without citations
        if not contexts or not is_relevant:
            not_found_msg = (
                "I could not find any relevant information in your indexed documents for this query. "
                "Please try rephrasing or upload documents covering this topic."
            )
            yield sse("sources", [])
            yield sse("token", not_found_msg)
            self.db.add_chat_message(
                session_id=session_id,
                role="assistant",
                content=not_found_msg,
                citations=[],
                trace=trace_steps,
            )
            yield sse("done", {"citations": [], "trace": trace_steps, "followups": []})
            return

        yield sse("sources", contexts)

        context_block = "\n\n---\n\n".join(
            f"[{c['filename']}, p. {c['page_number']}] (Section: {c['section_header']})\n{c['text']}"
            for c in contexts
        )
        persona_line = PERSONA_PROMPTS.get(system_persona, PERSONA_PROMPTS["default"])
        mode_line = MODE_INSTRUCTIONS.get(query_mode, MODE_INSTRUCTIONS["qa"])

        system_prompt = (
            f"{persona_line}\n"
            f"TASK MODE: {mode_line}\n"
            "RULES:\n"
            "1. Answer ONLY using facts explicitly stated in the Retrieved Context below.\n"
            "2. If the context does not contain enough information, state clearly what is missing without inventing facts.\n"
            "3. Every factual claim MUST include an inline clickable citation in the EXACT format: "
            "[<filename>, p. <page_number>] matching the provided source headers.\n"
            "4. Preserve markdown tables, code blocks, numbers, and technical specifics accurately.\n\n"
            f"RETRIEVED CONTEXT:\n{context_block}"
        )

        messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
        for turn in history[-6:]:
            messages.append({"role": turn["role"], "content": turn["content"]})
        messages.append({"role": "user", "content": user_query})

        yield emit_stage("generate", f"Writing your answer with {llm_name}…", len(trace_steps))
        t_gen = time.perf_counter()
        first_token_ms: int | None = None
        full_answer = ""
        try:
            if self._is_external_openai(llm_name):
                async for delta in self._stream_llm_tokens(messages, temperature, llm_name):
                    if first_token_ms is None:
                        first_token_ms = int((time.perf_counter() - t_gen) * 1000)
                    full_answer += delta
                    yield sse("token", delta)
            else:
                client = self._get_http_client()
                async with client.stream(
                    "POST",
                    f"{self.settings.ollama_base_url.rstrip('/')}/api/chat",
                    json=self._build_ollama_payload(
                        llm_name, messages, stream=True, temperature=temperature
                    ),
                ) as resp:
                    if resp.status_code >= 400:
                        err_txt = (await resp.aread()).decode("utf-8", "ignore")
                        yield sse("error", f"Ollama generation failed ({resp.status_code}): {err_txt}")
                        return
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        chunk = json.loads(line)
                        delta = chunk.get("message", {}).get("content", "")
                        if delta:
                            if first_token_ms is None:
                                first_token_ms = int((time.perf_counter() - t_gen) * 1000)
                            full_answer += delta
                            yield sse("token", delta)
        except Exception as exc:
            yield sse("error", f"Streaming generation interrupted: {exc}")
            return

        dt_gen = int((time.perf_counter() - t_gen) * 1000)
        word_count = len(full_answer.split())
        words_per_sec = round(word_count / max(0.1, dt_gen / 1000.0), 1)
        ttft_ms = first_token_ms if first_token_ms is not None else dt_gen
        logger.info(
            "rag_generation_complete",
            session_id=session_id,
            model=llm_name,
            contexts=len(contexts),
            words=word_count,
            ttft_ms=ttft_ms,
            words_per_sec=words_per_sec,
            duration_ms=dt_gen,
        )
        yield emit_trace(
            "Grounded Generation",
            "completed",
            f"Wrote {word_count} words using {llm_name} ({words_per_sec} words/sec).",
            dt_gen,
            meta={
                "model": llm_name,
                "ttft_ms": ttft_ms,
                "words": word_count,
                "chars": len(full_answer),
                "words_per_sec": words_per_sec,
            },
        )

        followups = self._build_followups(contexts, user_query)
        yield sse("followups", followups)

        self.db.add_chat_message(
            session_id=session_id,
            role="assistant",
            content=full_answer,
            citations=contexts,
            trace=trace_steps,
        )
        yield sse("done", {"citations": contexts, "trace": trace_steps, "followups": followups})
