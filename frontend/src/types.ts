export interface ModelTier {
  tier_id: string;
  tier_name: string;
  embedding_model: string;
  embedding_dim: number;
  reranker_model: string;
  llm_model: string;
  estimated_memory_gb: number;
  rationale: string;
  licenses: Record<string, string>;
}

export interface HardwareProfile {
  os_name: string;
  os_version: string;
  cpu_arch: string;
  cpu_model: string;
  cpu_cores_logical: number;
  total_ram_gb: number;
  available_ram_gb: number;
  disk_free_gb: number;
  accelerator: "cuda" | "mps" | "rocm" | "cpu";
  gpu_name: string;
  gpu_vram_total_gb: number;
  gpu_vram_free_gb: number;
  effective_memory_gb: number;
  recommended_tier: string;
  fallback_triggered: boolean;
  fallback_reason: string | null;
  smart_notes: string[];
}

export interface ModelInventoryItem {
  model_id: string;
  kind: "embedding" | "reranker" | "llm";
  provider?: "qwen" | "ollama" | "baai" | "microsoft" | "huggingface";
  role_desc: string;
  license: string;
  required: boolean;
  optional: boolean;
  recommended: boolean;
  installed: boolean;
  loaded: boolean;
  fit: "optimal" | "compatible" | "heavy";
  estimated_gb: number;
  size_label: string;
  tier_ids: string[];
}

export interface HardwareReport {
  profile: HardwareProfile;
  active_tier: ModelTier;
  selected_llm?: string;
  all_tiers: ModelTier[];
  ollama: {
    reachable: boolean;
    installed_models: string[];
    running_models?: string[];
    error: string | null;
  };
  models: ModelInventoryItem[];
  reindexed_chunks?: number;
}

export interface DocumentItem {
  doc_id: string;
  filename: string;
  file_type: string;
  size_bytes: number;
  status: "processing" | "ready" | "error";
  progress: number;
  error_message: string | null;
  parent_count: number;
  child_count: number;
  file_hash?: string;
  created_at: string;
}

export interface SourceCitation {
  parent_id: string;
  doc_id: string;
  filename: string;
  page_number: number;
  section_header: string;
  text: string;
  matched_excerpt: string;
  rerank_score: number;
  rrf_score: number;
}

export interface TraceMeta {
  pass?: number;
  dense_hits?: number;
  bm25_hits?: number;
  candidates?: number;
  windows?: number;
  top_score?: number | null;
  cache_hit?: boolean;
  verdict?: "approved" | "denied";
  rewritten_query?: string;
  model?: string;
  ttft_ms?: number;
  words?: number;
  chars?: number;
  words_per_sec?: number;
  ready_docs?: number;
}

export interface TraceStep {
  step: string;
  status: string;
  detail: string;
  duration_ms: number;
  meta?: TraceMeta;
}

export interface LiveStage {
  stage: "search" | "rerank" | "grade" | "rewrite" | "generate";
  pass?: number;
  label: string;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: SourceCitation[];
  trace: TraceStep[];
  liveStage?: LiveStage | null;
  streaming?: boolean;
  isError?: boolean;
  followups?: string[];
}

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export type SystemPersona = "default" | "analyst" | "summarizer" | "coder" | "eli5";
export type QueryMode = "qa" | "chat" | "summarize" | "compare" | "extract" | "quiz";

export interface ChatSettings {
  temperature: number;
  top_k: number;
  system_persona: SystemPersona;
  query_mode: QueryMode;
  llm_model?: string;
}




