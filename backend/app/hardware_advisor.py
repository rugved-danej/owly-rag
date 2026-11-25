"""Hardware profiler and tier-based model manager for Ollama LLMs and Hugging Face rankers/embedders."""

from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
import subprocess
import threading
from collections.abc import AsyncGenerator
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx
import psutil


@dataclass(frozen=True)
class ModelRecommendation:
    tier_id: str
    tier_name: str
    embedding_model: str
    embedding_dim: int
    reranker_model: str
    llm_model: str
    estimated_memory_gb: float
    rationale: str
    licenses: dict[str, str]


@dataclass
class HardwareProfile:
    os_name: str
    os_version: str
    cpu_arch: str
    cpu_model: str
    cpu_cores_logical: int
    total_ram_gb: float
    available_ram_gb: float
    disk_free_gb: float
    accelerator: str  # "cuda" | "mps" | "rocm" | "cpu"
    gpu_name: str
    gpu_vram_total_gb: float
    gpu_vram_free_gb: float
    effective_memory_gb: float
    recommended_tier: str
    fallback_triggered: bool
    fallback_reason: str | None
    smart_notes: list[str]


TIER_MATRIX: dict[str, ModelRecommendation] = {
    "ultra_light": ModelRecommendation(
        tier_id="ultra_light",
        tier_name="Ultra-Light / CPU-Only",
        embedding_model="BAAI/bge-small-en-v1.5",
        embedding_dim=384,
        reranker_model="cross-encoder/ms-marco-MiniLM-L-6-v2",
        llm_model="qwen3:1.7b",
        estimated_memory_gb=2.4,
        rationale=(
            "Optimized for CPU-only or constrained memory (<6.5 GB usable). Pairs compact 384d "
            "BGE embeddings and a sub-20ms MiniLM cross-encoder with Qwen 3 (1.7B) to avoid swap thrashing."
        ),
        licenses={
            "embedding": "MIT",
            "reranker": "Apache-2.0",
            "llm": "Apache-2.0",
        },
    ),
    "standard_laptop": ModelRecommendation(
        tier_id="standard_laptop",
        tier_name="Standard Laptop",
        embedding_model="Qwen/Qwen3-Embedding-0.6B",
        embedding_dim=1024,
        reranker_model="mixedbread-ai/mxbai-rerank-base-v1",
        llm_model="qwen3.5:4b",
        estimated_memory_gb=5.4,
        rationale=(
            "Tuned for 8-12 GB GPUs and 16 GB Apple Silicon. Combines 1024d Qwen3-Embedding (32K context), "
            "Mixedbread base reranking, and Qwen 3.5 (4B) while preserving VRAM headroom for RAG KV cache."
        ),
        licenses={
            "embedding": "Apache-2.0",
            "reranker": "Apache-2.0",
            "llm": "Apache-2.0",
        },
    ),
    "pro_workstation": ModelRecommendation(
        tier_id="pro_workstation",
        tier_name="Pro Workstation",
        embedding_model="Qwen/Qwen3-Embedding-0.6B",
        embedding_dim=1024,
        reranker_model="BAAI/bge-reranker-v2-m3",
        llm_model="qwen3.5:9b",
        estimated_memory_gb=11.0,
        rationale=(
            "Designed for 16-24 GB VRAM/Unified Memory. Upgrades to BGE-Reranker-v2-M3 multilingual "
            "reranking and Qwen 3.5 (9B, 256K context) for deep multi-document synthesis."
        ),
        licenses={
            "embedding": "Apache-2.0",
            "reranker": "MIT",
            "llm": "Apache-2.0",
        },
    ),
    "enterprise_gpu": ModelRecommendation(
        tier_id="enterprise_gpu",
        tier_name="Enterprise GPU",
        embedding_model="BAAI/bge-m3",
        embedding_dim=1024,
        reranker_model="BAAI/bge-reranker-v2-m3",
        llm_model="qwen3.5:27b",
        estimated_memory_gb=22.4,
        rationale=(
            "Built for 24+ GB VRAM workstations/servers. Pairs multilingual BGE-M3 + BGE-Reranker-v2-M3 "
            "with Qwen 3.5 (27B, 256K context) for flagship local RAG accuracy."
        ),
        licenses={
            "embedding": "MIT",
            "reranker": "MIT",
            "llm": "Apache-2.0",
        },
    ),
}

TIER_ORDER = ["ultra_light", "standard_laptop", "pro_workstation", "enterprise_gpu"]

ESTIMATED_MODEL_GB: dict[str, float] = {
    "BAAI/bge-small-en-v1.5": 0.13,
    "Qwen/Qwen3-Embedding-0.6B": 1.12,
    "BAAI/bge-m3": 2.27,
    "cross-encoder/ms-marco-MiniLM-L-6-v2": 0.09,
    "mixedbread-ai/mxbai-rerank-base-v1": 0.74,
    "BAAI/bge-reranker-v2-m3": 2.14,
    "qwen3:1.7b": 1.4,
    "qwen3.5:4b": 3.3,
    "qwen3.5:9b": 6.6,
    "qwen3.5:27b": 17.0,
}


def _format_bytes(num_bytes: float) -> str:
    gb = num_bytes / (1024**3)
    if gb >= 1.0:
        return f"{gb:.1f} GB"
    mb = num_bytes / (1024**2)
    return f"{max(1, round(mb))} MB"


def _run_cmd(cmd: list[str], timeout: int = 4) -> str | None:
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=timeout)
        return out.decode("utf-8", errors="ignore").strip()
    except Exception:
        return None


def _detect_cpu_model() -> str:
    sys_name = platform.system()
    if sys_name == "Darwin":
        out = _run_cmd(["sysctl", "-n", "machdep.cpu.brand_string"])
        if out:
            return out
    elif sys_name == "Linux" and os.path.exists("/proc/cpuinfo"):
        try:
            with open("/proc/cpuinfo", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if "model name" in line:
                        return line.split(":", 1)[1].strip()
        except OSError:
            pass
    return platform.processor() or platform.machine()


def _detect_nvidia_gpu() -> tuple[str, float, float] | None:
    out = _run_cmd(
        [
            "nvidia-smi",
            "--query-gpu=name,memory.total,memory.free",
            "--format=csv,noheader,nounits",
        ]
    )
    if not out:
        return None
    best: tuple[str, float, float] | None = None
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 3:
            try:
                name = parts[0]
                total_gb = round(float(parts[1]) / 1024.0, 2)
                free_gb = round(float(parts[2]) / 1024.0, 2)
                if best is None or total_gb > best[1]:
                    best = (name, total_gb, free_gb)
            except ValueError:
                continue
    return best


def _detect_amd_rocm() -> tuple[str, float, float] | None:
    out = _run_cmd(["rocm-smi", "--showmeminfo", "vram", "--csv"])
    if out:
        lines = [ln for ln in out.splitlines() if ln.strip() and not ln.lower().startswith("device")]
        for ln in lines:
            parts = [p.strip() for p in ln.split(",")]
            if len(parts) >= 3:
                try:
                    total_b = float(parts[1])
                    used_b = float(parts[2])
                    total_gb = round(total_b / (1024**3), 2)
                    free_gb = round(max(0.0, total_b - used_b) / (1024**3), 2)
                    return ("AMD ROCm GPU", total_gb, free_gb)
                except ValueError:
                    continue
    drm_root = "/sys/class/drm"
    if os.path.isdir(drm_root):
        for entry in os.listdir(drm_root):
            vram_total_path = os.path.join(drm_root, entry, "device", "mem_info_vram_total")
            vram_used_path = os.path.join(drm_root, entry, "device", "mem_info_vram_used")
            if os.path.exists(vram_total_path):
                try:
                    with open(vram_total_path, encoding="utf-8") as f:
                        total_b = float(f.read().strip())
                    used_b = 0.0
                    if os.path.exists(vram_used_path):
                        with open(vram_used_path, encoding="utf-8") as f:
                            used_b = float(f.read().strip())
                    total_gb = round(total_b / (1024**3), 2)
                    free_gb = round(max(0.0, total_b - used_b) / (1024**3), 2)
                    if total_gb >= 2.0:
                        return ("AMD GPU (sysfs)", total_gb, free_gb)
                except (OSError, ValueError):
                    continue
    return None


def _match_ollama_tag(model_id: str, models: list[str]) -> str | None:
    """Match a canonical Ollama model tag against installed or active tags."""
    if ":" in model_id:
        return next((m for m in models if m == model_id or m.startswith(model_id + "-")), None)
    return next((m for m in models if m == model_id or m == f"{model_id}:latest"), None)


def _scan_hf_cache() -> dict[str, int]:
    """Return mapping of cached HuggingFace repo_id -> size_on_disk bytes (ignoring <1 MB stubs)."""
    cached: dict[str, int] = {}
    try:
        from huggingface_hub import scan_cache_dir

        info = scan_cache_dir()
        for repo in info.repos:
            if repo.size_on_disk >= 1024 * 1024:
                cached[repo.repo_id] = int(repo.size_on_disk)
    except Exception:
        pass
    return cached


def inspect_hardware() -> HardwareProfile:
    vm = psutil.virtual_memory()
    total_ram_gb = round(vm.total / (1024**3), 2)
    avail_ram_gb = round(vm.available / (1024**3), 2)
    try:
        disk_free_gb = round(shutil.disk_usage(Path.cwd()).free / (1024**3), 1)
    except OSError:
        disk_free_gb = 0.0

    os_name = platform.system()
    arch = platform.machine().lower()
    cpu_model = _detect_cpu_model()
    cores = psutil.cpu_count(logical=True) or 1

    accelerator = "cpu"
    gpu_name = "None (CPU-Only)"
    vram_total = 0.0
    vram_free = 0.0
    smart_notes: list[str] = []

    nvidia = _detect_nvidia_gpu()
    if nvidia:
        accelerator = "cuda"
        gpu_name, vram_total, vram_free = nvidia
        effective_mem = vram_total
        smart_notes.append(f"Detected NVIDIA CUDA GPU ({gpu_name}, {vram_total:.1f} GB VRAM).")
    elif os_name == "Darwin" and ("arm" in arch or "aarch64" in arch):
        accelerator = "mps"
        gpu_name = f"{cpu_model} (Unified Memory / Metal)"
        vram_total = round(total_ram_gb * 0.70, 2)
        vram_free = round(min(avail_ram_gb, vram_total), 2)
        effective_mem = vram_total
        smart_notes.append(f"Detected Apple Silicon Unified Memory (~{vram_total:.1f} GB Metal budget).")
    else:
        amd = _detect_amd_rocm()
        if amd:
            accelerator = "rocm"
            gpu_name, vram_total, vram_free = amd
            effective_mem = vram_total
            smart_notes.append(f"Detected AMD ROCm GPU ({vram_total:.1f} GB VRAM).")
        else:
            effective_mem = round(total_ram_gb * 0.55, 2)
            smart_notes.append(
                f"CPU-only mode ({cores} threads, {avail_ram_gb:.1f}/{total_ram_gb:.1f} GB RAM free)."
            )

    if accelerator in {"cuda", "mps", "rocm"}:
        if effective_mem >= 24.0:
            tier = "enterprise_gpu"
        elif effective_mem >= 13.0:
            tier = "pro_workstation"
        elif effective_mem >= 6.5:
            tier = "standard_laptop"
        else:
            tier = "ultra_light"
    else:
        tier = "standard_laptop" if effective_mem >= 10.0 else "ultra_light"

    fallback_triggered = False
    fallback_reason: str | None = None
    live_headroom = vram_free if accelerator in {"cuda", "rocm"} else avail_ram_gb

    while TIER_ORDER.index(tier) > 0:
        req = TIER_MATRIX[tier].estimated_memory_gb
        if live_headroom + 1.0 < req:
            prev_tier = tier
            tier = TIER_ORDER[TIER_ORDER.index(tier) - 1]
            fallback_triggered = True
            fallback_reason = (
                f"Downgraded from {TIER_MATRIX[prev_tier].tier_name} to "
                f"{TIER_MATRIX[tier].tier_name} because only {live_headroom:.1f} GB live memory "
                f"is currently free (needed ~{req:.1f} GB)."
            )
        else:
            break

    smart_notes.append(
        f"Smart tier pick: {TIER_MATRIX[tier].tier_name} (~{TIER_MATRIX[tier].estimated_memory_gb} GB footprint)."
    )
    if disk_free_gb > 0:
        smart_notes.append(f"Local storage free: {disk_free_gb:.1f} GB available for model weights.")

    return HardwareProfile(
        os_name=os_name,
        os_version=platform.release(),
        cpu_arch=arch,
        cpu_model=cpu_model,
        cpu_cores_logical=cores,
        total_ram_gb=total_ram_gb,
        available_ram_gb=avail_ram_gb,
        disk_free_gb=disk_free_gb,
        accelerator=accelerator,
        gpu_name=gpu_name,
        gpu_vram_total_gb=vram_total,
        gpu_vram_free_gb=vram_free,
        effective_memory_gb=effective_mem,
        recommended_tier=tier,
        fallback_triggered=fallback_triggered,
        fallback_reason=fallback_reason,
        smart_notes=smart_notes,
    )


class HardwareAdvisor:
    def __init__(self, ollama_base_url: str, override_tier: str = "") -> None:
        self.ollama_base_url = ollama_base_url.rstrip("/")
        self.profile: HardwareProfile = inspect_hardware()
        selected_tier = override_tier if override_tier in TIER_MATRIX else self.profile.recommended_tier
        self.active_tier_id: str = selected_tier
        self.active_llm_override: str | None = None

    def refresh(self) -> HardwareProfile:
        self.profile = inspect_hardware()
        return self.profile

    def get_active_recommendation(self) -> ModelRecommendation:
        return TIER_MATRIX[self.active_tier_id]

    def select_tier(self, tier_id: str) -> ModelRecommendation:
        if tier_id not in TIER_MATRIX:
            raise ValueError(f"Unknown tier '{tier_id}'. Valid tiers: {list(TIER_MATRIX.keys())}")
        self.active_tier_id = tier_id
        self.active_llm_override = None
        return TIER_MATRIX[tier_id]

    def select_llm(self, model_id: str) -> str:
        cleaned = model_id.strip()
        if not cleaned:
            self.active_llm_override = None
            return self.get_active_recommendation().llm_model
        self.active_llm_override = cleaned
        return cleaned

    async def get_ollama_status(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                tags_resp = await client.get(f"{self.ollama_base_url}/api/tags")
                tags_resp.raise_for_status()
                raw_models = tags_resp.json().get("models", [])
                installed_models = [m.get("name", "") for m in raw_models if m.get("name")]
                model_sizes = {
                    m["name"]: int(m.get("size") or 0) for m in raw_models if m.get("name")
                }

                running_models: list[str] = []
                try:
                    ps_resp = await client.get(f"{self.ollama_base_url}/api/ps")
                    if ps_resp.status_code == 200:
                        running_models = [
                            m.get("name", "") for m in ps_resp.json().get("models", []) if m.get("name")
                        ]
                except Exception:
                    pass

                return {
                    "reachable": True,
                    "installed_models": installed_models,
                    "running_models": running_models,
                    "model_sizes": model_sizes,
                    "error": None,
                }
        except Exception as exc:
            return {
                "reachable": False,
                "installed_models": [],
                "running_models": [],
                "model_sizes": {},
                "error": f"Ollama unreachable at {self.ollama_base_url}: {exc}",
            }

    def build_model_inventory(self, ollama_status: dict[str, Any]) -> list[dict[str, Any]]:
        """Build inventory of all required and optional models across all capability tiers."""
        active = self.get_active_recommendation()
        rec = TIER_MATRIX[self.profile.recommended_tier]
        hf_cached = _scan_hf_cache()

        installed_ollama: list[str] = ollama_status.get("installed_models", []) or []
        running_ollama: list[str] = ollama_status.get("running_models", []) or []
        ollama_sizes: dict[str, int] = ollama_status.get("model_sizes", {}) or {}

        live_headroom = (
            self.profile.gpu_vram_free_gb
            if self.profile.accelerator in {"cuda", "rocm"}
            else self.profile.available_ram_gb
        )

        # Deduplicate while preserving deterministic tier order
        seen: dict[tuple[str, str], dict[str, Any]] = {}
        for tier_id in TIER_ORDER:
            t = TIER_MATRIX[tier_id]
            entries = [
                ("embedding", t.embedding_model, f"{t.embedding_dim}d vector embedder", t.licenses.get("embedding", "MIT")),
                ("reranker", t.reranker_model, "Cross-encoder passage reranker", t.licenses.get("reranker", "MIT")),
                ("llm", t.llm_model, "Local grounded generator LLM", t.licenses.get("llm", "Apache-2.0")),
            ]
            for kind, model_id, role_desc, lic in entries:
                key = (kind, model_id)
                if key not in seen:
                    est_gb = ESTIMATED_MODEL_GB.get(model_id, 1.0)
                    is_required = (
                        (kind == "embedding" and model_id == active.embedding_model)
                        or (kind == "reranker" and model_id == active.reranker_model)
                        or (kind == "llm" and model_id == active.llm_model)
                    )
                    is_recommended = (
                        (kind == "embedding" and model_id == rec.embedding_model)
                        or (kind == "reranker" and model_id == rec.reranker_model)
                        or (kind == "llm" and model_id == rec.llm_model)
                    )

                    if kind == "llm":
                        matched_tag = _match_ollama_tag(model_id, installed_ollama)
                        loaded = _match_ollama_tag(model_id, running_ollama) is not None
                        installed = matched_tag is not None
                        size_bytes = ollama_sizes.get(matched_tag or "", 0)
                    else:
                        size_bytes = hf_cached.get(model_id, 0)
                        installed = size_bytes > 0
                        loaded = False

                    if size_bytes > 0:
                        size_label = _format_bytes(size_bytes)
                    else:
                        size_label = f"~{_format_bytes(est_gb * (1024**3))}"

                    if est_gb <= max(2.0, self.profile.effective_memory_gb * 0.75) and est_gb <= live_headroom + 1.5:
                        fit = "optimal"
                    elif est_gb <= max(4.0, self.profile.effective_memory_gb):
                        fit = "compatible"
                    else:
                        fit = "heavy"

                    if kind == "llm":
                        provider = "qwen" if model_id.lower().startswith("qwen") else "ollama"
                    elif model_id.startswith("BAAI/"):
                        provider = "baai"
                    elif model_id.startswith("Qwen/"):
                        provider = "qwen"
                    elif model_id.startswith("cross-encoder/"):
                        provider = "microsoft"
                    else:
                        provider = "huggingface"

                    seen[key] = {
                        "model_id": model_id,
                        "kind": kind,
                        "provider": provider,
                        "role_desc": role_desc,
                        "license": lic,
                        "required": is_required,
                        "optional": not is_required,
                        "recommended": is_recommended,
                        "installed": installed,
                        "loaded": loaded,
                        "fit": fit,
                        "estimated_gb": est_gb,
                        "size_label": size_label,
                        "tier_ids": [tier_id],
                    }
                else:
                    if tier_id not in seen[key]["tier_ids"]:
                        seen[key]["tier_ids"].append(tier_id)

        # Include any extra locally installed Ollama models so users can switch freely
        for ollama_name in installed_ollama:
            base_id = ollama_name
            already_listed = any(
                k[0] == "llm" and _match_ollama_tag(k[1], [ollama_name]) is not None
                for k in seen
            )
            if not already_listed:
                size_bytes = ollama_sizes.get(ollama_name, 0)
                est_gb = round(size_bytes / (1024**3), 2) if size_bytes > 0 else 4.0
                lower_name = base_id.lower()
                provider = "qwen" if "qwen" in lower_name else "ollama"
                seen[("llm", base_id)] = {
                    "model_id": base_id,
                    "kind": "llm",
                    "provider": provider,
                    "role_desc": "Local Ollama model",
                    "license": "Local",
                    "required": False,
                    "optional": True,
                    "recommended": False,
                    "installed": True,
                    "loaded": _match_ollama_tag(base_id, running_ollama) is not None,
                    "fit": "compatible",
                    "estimated_gb": est_gb,
                    "size_label": _format_bytes(size_bytes) if size_bytes > 0 else "~4.0 GB",
                    "tier_ids": [self.active_tier_id],
                }

        # Include models belonging to the active tier, plus any optional models already installed locally
        kind_rank = {"embedding": 0, "reranker": 1, "llm": 2}
        items = [v for v in seen.values() if v["required"] or v["installed"]]
        items.sort(key=lambda x: (0 if x["required"] else 1, kind_rank.get(x["kind"], 9), x["estimated_gb"]))
        return items

    async def install_ollama_model_stream(self, model_name: str) -> AsyncGenerator[str, None]:
        """Streams Ollama install progress as SSE payloads at maximum network throughput."""
        url = f"{self.ollama_base_url}/api/pull"
        limits = httpx.Limits(max_connections=20, max_keepalive_connections=10)
        try:
            async with httpx.AsyncClient(timeout=None, limits=limits) as client:
                async with client.stream("POST", url, json={"name": model_name, "stream": True}) as resp:
                    if resp.status_code >= 400:
                        body = await resp.aread()
                        yield f"data: {json.dumps({'status': 'error', 'detail': body.decode('utf-8', 'ignore')})}\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            payload = json.loads(line)
                            total = payload.get("total") or 0
                            completed = payload.get("completed") or 0
                            pct = round((completed / total) * 100, 1) if total > 0 else None
                            yield f"data: {json.dumps({'status': payload.get('status', 'installing'), 'percent': pct})}\n\n"
                        except json.JSONDecodeError:
                            continue
            yield f"data: {json.dumps({'status': 'done', 'percent': 100.0})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'status': 'error', 'detail': str(exc)})}\n\n"

    async def install_hf_model_stream(self, model_id: str) -> AsyncGenerator[str, None]:
        """Download and cache a HuggingFace embedding or reranker model while streaming progress."""
        yield f"data: {json.dumps({'status': f'Checking cache for {model_id}…', 'percent': 5.0})}\n\n"

        os.environ.pop("HF_HUB_OFFLINE", None)
        os.environ.pop("TRANSFORMERS_OFFLINE", None)

        est_bytes = int(ESTIMATED_MODEL_GB.get(model_id, 0.25) * (1024**3))
        done_evt = threading.Event()
        err_holder: list[str] = []

        def _dir_size_bytes() -> int:
            try:
                from huggingface_hub.constants import HF_HUB_CACHE

                slug = f"models--{model_id.replace('/', '--')}"
                repo_dir = Path(HF_HUB_CACHE) / slug
                if not repo_dir.exists():
                    return 0
                return sum(f.stat().st_size for f in repo_dir.rglob("*") if f.is_file())
            except Exception:
                return 0

        def _worker() -> None:
            try:
                from huggingface_hub import snapshot_download

                snapshot_download(repo_id=model_id)
            except Exception as exc:
                err_holder.append(str(exc))
            finally:
                done_evt.set()

        t = threading.Thread(target=_worker, daemon=True)
        t.start()

        last_pct = 8.0
        while not done_evt.is_set():
            cur_bytes = _dir_size_bytes()
            if est_bytes > 0 and cur_bytes > 0:
                pct = min(96.0, max(last_pct, round((cur_bytes / est_bytes) * 100.0, 1)))
            else:
                pct = min(90.0, round(last_pct + 3.5, 1))
            last_pct = pct
            status_msg = (
                f"Installing {model_id} ({_format_bytes(cur_bytes)})…"
                if cur_bytes > 0
                else f"Resolving {model_id}…"
            )
            yield f"data: {json.dumps({'status': status_msg, 'percent': pct})}\n\n"
            await asyncio.sleep(0.45)

        if err_holder:
            yield f"data: {json.dumps({'status': 'error', 'detail': err_holder[0]})}\n\n"
            return

        yield f"data: {json.dumps({'status': 'done', 'percent': 100.0})}\n\n"

    async def install_model_stream(self, model_id: str, kind: str) -> AsyncGenerator[str, None]:
        if kind == "llm":
            async for chunk in self.install_ollama_model_stream(model_id):
                yield chunk
        elif kind in {"embedding", "reranker"}:
            async for chunk in self.install_hf_model_stream(model_id):
                yield chunk
        else:
            yield f"data: {json.dumps({'status': 'error', 'detail': f'Unsupported model kind: {kind}'})}\n\n"

    async def uninstall_model(self, model_id: str, kind: str) -> dict[str, Any]:
        """Uninstall a local Ollama LLM or delete a cached HuggingFace embedding/reranker model."""
        if kind == "llm":
            status = await self.get_ollama_status()
            if not status.get("reachable"):
                raise RuntimeError("Ollama is not running. Start Ollama to uninstall local LLMs.")
            installed = status.get("installed_models", []) or []
            target = _match_ollama_tag(model_id, installed) or model_id
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.request(
                    "DELETE",
                    f"{self.ollama_base_url}/api/delete",
                    json={"name": target},
                )
                if resp.status_code >= 400 and resp.status_code != 404:
                    raise RuntimeError(f"Ollama delete failed ({resp.status_code}): {resp.text}")
            return {"uninstalled": True, "model_id": model_id, "kind": kind}

        if kind in {"embedding", "reranker"}:
            def _delete_hf_sync() -> bool:
                from huggingface_hub import scan_cache_dir

                info = scan_cache_dir()
                hashes: list[str] = []
                for repo in info.repos:
                    if repo.repo_id == model_id:
                        for rev in repo.revisions:
                            hashes.append(rev.commit_hash)
                if not hashes:
                    return False
                strategy = info.delete_revisions(*hashes)
                strategy.execute()
                return True

            await asyncio.to_thread(_delete_hf_sync)
            return {"uninstalled": True, "model_id": model_id, "kind": kind}

        raise ValueError(f"Unsupported model kind: {kind}")

    async def get_full_report(self) -> dict[str, Any]:
        ollama = await self.get_ollama_status()
        models = self.build_model_inventory(ollama)
        active = self.get_active_recommendation()
        return {
            "profile": asdict(self.profile),
            "active_tier": asdict(active),
            "selected_llm": self.active_llm_override or active.llm_model,
            "all_tiers": [asdict(TIER_MATRIX[k]) for k in TIER_ORDER],
            "ollama": ollama,
            "models": models,
        }
