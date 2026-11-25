from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass
class EvalCaseResult:
    query: str
    recall_at_k: float
    reciprocal_rank: float
    keyword_hit_rate: float
    retrieved_doc_ids: list[str]


def evaluate_retrieval_metrics(
    cases: list[dict[str, Any]],
    search_fn: Callable[[str, int], list[dict[str, Any]]],
    top_k: int = 5,
) -> dict[str, Any]:
    """Evaluate dense/sparse/reranked retrieval quality against golden doc IDs and keywords."""
    if not cases:
        return {
            "count": 0,
            "mean_recall_at_k": 0.0,
            "mrr": 0.0,
            "mean_keyword_hit_rate": 0.0,
            "cases": [],
        }

    results: list[EvalCaseResult] = []
    for case in cases:
        query = str(case["query"])
        expected_docs = list(case.get("expected_doc_ids") or [])
        expected_kws = [str(k).lower() for k in (case.get("expected_keywords") or [])]

        hits = search_fn(query, top_k)
        retrieved_docs = [str(h.get("doc_id", "")) for h in hits]
        combined_text = "\n".join(str(h.get("text", "")) for h in hits).lower()

        if expected_docs:
            matched_docs = sum(1 for d in expected_docs if d in retrieved_docs)
            recall = matched_docs / len(expected_docs)
            rr = 0.0
            for rank, doc_id in enumerate(retrieved_docs, start=1):
                if doc_id in expected_docs:
                    rr = 1.0 / rank
                    break
        else:
            recall = 1.0 if hits else 0.0
            rr = 1.0 if hits else 0.0

        if expected_kws:
            kw_hits = sum(1 for kw in expected_kws if kw in combined_text)
            kw_rate = kw_hits / len(expected_kws)
        else:
            kw_rate = 1.0 if hits else 0.0

        results.append(
            EvalCaseResult(
                query=query,
                recall_at_k=round(recall, 4),
                reciprocal_rank=round(rr, 4),
                keyword_hit_rate=round(kw_rate, 4),
                retrieved_doc_ids=retrieved_docs,
            )
        )

    n = len(results)
    return {
        "count": n,
        "mean_recall_at_k": round(sum(r.recall_at_k for r in results) / n, 4),
        "mrr": round(sum(r.reciprocal_rank for r in results) / n, 4),
        "mean_keyword_hit_rate": round(sum(r.keyword_hit_rate for r in results) / n, 4),
        "cases": [
            {
                "query": r.query,
                "recall_at_k": r.recall_at_k,
                "reciprocal_rank": r.reciprocal_rank,
                "keyword_hit_rate": r.keyword_hit_rate,
                "retrieved_doc_ids": r.retrieved_doc_ids,
            }
            for r in results
        ],
    }
