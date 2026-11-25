import {
  ChatSession,
  ChatSettings,
  DocumentItem,
  HardwareReport,
  LiveStage,
  SourceCitation,
  TraceStep,
} from "./types";

const BASE = "/api";

export async function fetchHardware(): Promise<HardwareReport> {
  const res = await fetch(`${BASE}/hardware`);
  if (!res.ok) throw new Error("Failed to load hardware profile.");
  return res.json();
}

export async function selectTier(tierId: string): Promise<HardwareReport> {
  const res = await fetch(`${BASE}/hardware/select-tier`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tier_id: tierId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function smartDetectHardware(): Promise<HardwareReport> {
  const res = await fetch(`${BASE}/hardware/smart-detect`, { method: "POST" });
  if (!res.ok) throw new Error("Smart hardware detection failed.");
  return res.json();
}

export async function selectLlm(modelId: string): Promise<HardwareReport> {
  const res = await fetch(`${BASE}/hardware/select-llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: modelId }),
  });
  if (!res.ok) throw new Error("Failed to select LLM model.");
  return res.json();
}

async function consumeInstallStream(
  res: Response,
  onProgress: (status: string, percent: number | null) => void
): Promise<void> {
  if (!res.ok || !res.body) throw new Error("Failed to start model install.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const evt = JSON.parse(line.slice(5).trim());
      if (evt.status === "error") throw new Error(evt.detail || "Install failed");
      onProgress(evt.status, evt.percent ?? null);
    }
  }
}

export async function installModel(
  modelId: string,
  kind: "llm" | "embedding" | "reranker",
  onProgress: (status: string, percent: number | null) => void
): Promise<void> {
  const res = await fetch(`${BASE}/hardware/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: modelId, kind }),
  });
  await consumeInstallStream(res, onProgress);
}

export async function uninstallModel(
  modelId: string,
  kind: "llm" | "embedding" | "reranker"
): Promise<HardwareReport> {
  const res = await fetch(`${BASE}/hardware/uninstall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: modelId, kind }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || "Failed to uninstall model.");
  }
  return res.json();
}

export async function fetchDocuments(): Promise<DocumentItem[]> {
  const res = await fetch(`${BASE}/documents`);
  if (!res.ok) throw new Error("Failed to fetch documents.");
  return res.json();
}

export async function uploadFiles(
  files: File[],
  allowDuplicate = false
): Promise<DocumentItem[]> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  form.append("allow_duplicate", String(allowDuplicate));
  const res = await fetch(`${BASE}/documents/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Upload failed" }));
    throw new Error(err.detail || "Upload failed");
  }
  return res.json();
}

export async function deleteDocument(docId: string): Promise<void> {
  const res = await fetch(`${BASE}/documents/${docId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to delete document." }));
    throw new Error(err.detail || "Failed to delete document.");
  }
}

export async function fetchDocumentChunks(docId: string): Promise<{
  parents: Array<{ parent_id: string; page_number: number; section_header: string; text: string }>;
  children: Array<{ child_id: string; parent_id: string; page_number: number; text: string }>;
}> {
  const res = await fetch(`${BASE}/documents/${docId}/chunks`);
  if (!res.ok) throw new Error("Failed to inspect chunks.");
  return res.json();
}

export async function fetchSessions(): Promise<ChatSession[]> {
  const res = await fetch(`${BASE}/sessions`);
  if (!res.ok) return [];
  return res.json();
}

export async function upsertSessionApi(
  sessionId: string | undefined,
  title: string
): Promise<ChatSession> {
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, title }),
  });
  if (!res.ok) throw new Error("Failed to save session.");
  return res.json();
}

export async function deleteSessionApi(sessionId: string): Promise<void> {
  await fetch(`${BASE}/sessions/${sessionId}`, { method: "DELETE" });
}

export async function fetchChatHistory(sessionId: string) {
  const res = await fetch(`${BASE}/chat/${sessionId}/history`);
  if (!res.ok) return [];
  return res.json();
}

export async function clearChatHistory(sessionId: string): Promise<void> {
  await fetch(`${BASE}/chat/${sessionId}/history`, { method: "DELETE" });
}

export async function exportWorkspaceBackup(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/backup/export`);
  if (!res.ok) throw new Error("Backup export failed.");
  return res.json();
}

export async function restoreWorkspaceBackup(
  payload: Record<string, unknown>
): Promise<{ counts: Record<string, number> }> {
  const res = await fetch(`${BASE}/backup/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Backup restore failed.");
  return res.json();
}

export interface ChatJobStatusResponse {
  exists: boolean;
  job_id?: string;
  session_id: string;
  status?: "running" | "done" | "stopped" | "error";
  content?: string;
  trace?: TraceStep[];
  citations?: SourceCitation[];
  followups?: string[];
  live_stage?: LiveStage | null;
  error?: string | null;
  event_count?: number;
}

export async function startChatJob(
  sessionId: string,
  query: string,
  options?: {
    docIds?: string[];
    settings?: Partial<ChatSettings>;
  }
): Promise<{ job_id: string; session_id: string; status: string }> {
  const body = JSON.stringify({
    session_id: sessionId,
    query,
    doc_ids: options?.docIds && options.docIds.length > 0 ? options.docIds : undefined,
    temperature: options?.settings?.temperature ?? 0.1,
    top_k: options?.settings?.top_k ?? 5,
    system_persona: options?.settings?.system_persona ?? "default",
    query_mode: options?.settings?.query_mode ?? "qa",
    llm_model: options?.settings?.llm_model || undefined,
  });

  let lastErr = "Failed to start background generation.";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.ok) return res.json();

      const errData = await res.json().catch(() => null);
      lastErr = errData?.detail || `Backend returned ${res.status} while starting generation.`;
      if (![502, 503, 504].includes(res.status) && res.status !== 500) break;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err.message : "Cannot reach backend server.";
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 650));
    }
  }
  throw new Error(lastErr);
}

export async function getChatJobStatus(sessionId: string): Promise<ChatJobStatusResponse> {
  const res = await fetch(`${BASE}/chat/jobs/${sessionId}/status`);
  if (!res.ok) return { exists: false, session_id: sessionId };
  return res.json();
}

export async function stopChatJob(sessionId: string): Promise<void> {
  await fetch(`${BASE}/chat/jobs/${sessionId}/stop`, { method: "POST" });
}

export async function attachChatJobStream(
  sessionId: string,
  after: number,
  handlers: {
    onStage?: (stage: LiveStage) => void;
    onTrace: (step: TraceStep) => void;
    onSources: (sources: SourceCitation[]) => void;
    onToken: (token: string) => void;
    onFollowups?: (followups: string[]) => void;
    onDone: () => void;
    onError: (msg: string) => void;
  },
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/jobs/${sessionId}/stream?after=${after}`, { signal });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      handlers.onDone();
      return;
    }
    handlers.onError("Backend connection failed.");
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onError("Backend stream unavailable.");
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const evt = JSON.parse(line.slice(5).trim());
        if (evt.type === "stage") handlers.onStage?.(evt.data);
        else if (evt.type === "trace") handlers.onTrace(evt.data);
        else if (evt.type === "sources") handlers.onSources(evt.data);
        else if (evt.type === "token") handlers.onToken(evt.data);
        else if (evt.type === "followups") handlers.onFollowups?.(evt.data);
        else if (evt.type === "error") handlers.onError(evt.data);
        else if (evt.type === "done") handlers.onDone();
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      handlers.onDone();
      return;
    }
    handlers.onError(err instanceof Error ? err.message : "Stream interrupted.");
  }
}

