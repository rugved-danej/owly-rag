"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, AnimatePresence } from "motion/react";
import {
  UploadCloud, FileText, Trash2, Eye, AlertCircle,
  CheckCircle2, Loader2, X, FileCode, FileSpreadsheet,
  File, Image as ImageIcon, ChevronDown, ChevronRight, CheckSquare, Square,
  Filter, Search, FolderPlus,
} from "lucide-react";
import { DocumentItem } from "../types";
import { deleteDocument, fetchDocumentChunks, uploadFiles } from "../api";

interface Props {
  documents: DocumentItem[];
  onRefresh: () => void;
  onUploaded?: (created: DocumentItem[]) => void;
  onOptimisticDelete?: (docId: string) => void;
  selectedDocIds?: string[];
  onToggleSelectDoc?: (docId: string) => void;
  onClearSelection?: () => void;
  onCloseMobile?: () => void;
}

type ParentChunk = {
  parent_id: string;
  page_number: number;
  section_header: string;
  text: string;
};

type InspectState = {
  doc: DocumentItem;
  parents: ParentChunk[];
  activeTab: "full" | "chunks";
  expandedChunks: Set<number>;
  searchQuery: string;
};

const CODE_EXTS = new Set(["py", "ts", "tsx", "js", "jsx", "css", "sql", "yaml", "yml", "toml", "json", "html", "htm"]);
const SUPPORTED_UPLOAD_EXTS = new Set([
  "pdf", "docx", "md", "markdown", "txt", "csv", "json", "html", "htm", "pptx", "xlsx",
  "py", "ts", "tsx", "js", "jsx", "css", "sql", "yaml", "yml", "toml",
]);

/** Map file extension -> icon + color */
function FileIcon({ filename, className = "h-4 w-4" }: { filename: string; className?: string }) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return <FileText className={`${className} text-rose-400`} />;
  if (["docx", "doc", "pptx"].includes(ext)) return <FileText className={`${className} text-orange-300`} />;
  if (["md", "markdown"].includes(ext) || CODE_EXTS.has(ext)) return <FileCode className={`${className} text-orange-400`} />;
  if (["csv", "xlsx"].includes(ext)) return <FileSpreadsheet className={`${className} text-emerald-400`} />;
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return <ImageIcon className={`${className} text-pink-400`} />;
  if (ext === "txt") return <FileText className={`${className} text-zinc-300`} />;
  return <File className={`${className} text-orange-400`} />;
}

function sanitiseText(raw: string): string {
  return raw.replace(/\0/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function HighlightQuery({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const q = query.trim();
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="rounded bg-orange-500/35 px-0.5 text-white">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
}

/** Render chunk content based on its file type */
function ChunkContent({ text, filename, search = "" }: { text: string; filename: string; search?: string }) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const clean = sanitiseText(text);

  if (["md", "markdown"].includes(ext) && !search.trim()) {
    return (
      <div className="chat-prose max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{clean}</ReactMarkdown>
      </div>
    );
  }

  if (["csv", "xlsx"].includes(ext) && !search.trim()) {
    const lines = clean.trim().split("\n");
    if (lines.length <= 1) {
      return <pre className="whitespace-pre-wrap break-words font-mono text-xs text-zinc-300">{clean}</pre>;
    }
    const isMdTable = lines[0].startsWith("|");
    if (isMdTable) {
      return (
        <div className="chat-prose max-w-none overflow-x-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{clean}</ReactMarkdown>
        </div>
      );
    }
    const headers = lines[0].split(",");
    const rows = lines.slice(1).map((l) => l.split(","));
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="border border-zinc-700 bg-orange-500/10 px-2 py-1 text-left font-semibold text-orange-300">
                  {h.trim()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? "" : "bg-zinc-900/40"}>
                {row.map((cell, ci) => (
                  <td key={ci} className="border border-zinc-700/50 px-2 py-1 text-zinc-300">
                    {cell.trim()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (CODE_EXTS.has(ext)) {
    return (
      <pre className="whitespace-pre-wrap break-words rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200 border border-zinc-800">
        <HighlightQuery text={clean} query={search} />
      </pre>
    );
  }

  return (
    <p
      className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-zinc-200"
      style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", unicodeBidi: "plaintext" }}
    >
      <HighlightQuery text={clean} query={search} />
    </p>
  );
}

export const KnowledgeBase: React.FC<Props> = ({
  documents,
  onRefresh,
  onUploaded,
  onOptimisticDelete,
  selectedDocIds = [],
  onToggleSelectDoc,
  onClearSelection,
  onCloseMobile,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const chunkCacheRef = useRef<Map<string, ParentChunk[]>>(new Map());

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspect, setInspect] = useState<InspectState | null>(null);

  const [searchTerm, setSearchTerm] = useState("");

  const filteredDocs = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => d.filename.toLowerCase().includes(q));
  }, [documents, searchTerm]);

  const handleFiles = useCallback(async (fileList: FileList | null, fromFolder = false) => {
    if (!fileList || fileList.length === 0) return;
    let files = Array.from(fileList);
    if (fromFolder) {
      files = files.filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        return SUPPORTED_UPLOAD_EXTS.has(ext);
      });
      if (files.length === 0) {
        setError("No supported document files found in the selected folder.");
        return;
      }
    }
    setError(null);
    setUploading(true);
    try {
      const created = await uploadFiles(files);
      if (onUploaded) onUploaded(created);
      else onRefresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }, [onRefresh, onUploaded]);

  const handleDelete = async (docId: string) => {
    if (deletingId === docId) return;
    setError(null);
    setDeletingId(docId);
    if (inspect?.doc.doc_id === docId) setInspect(null);
    chunkCacheRef.current.delete(docId);
    onOptimisticDelete?.(docId);
    try {
      await deleteDocument(docId);
      if (!onOptimisticDelete) onRefresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete document.");
      onRefresh();
    } finally {
      setDeletingId(null);
    }
  };

  const handleInspect = async (doc: DocumentItem) => {
    const cached = chunkCacheRef.current.get(doc.doc_id);
    if (cached) {
      setInspect({ doc, parents: cached, activeTab: "full", expandedChunks: new Set([0]), searchQuery: "" });
      return;
    }
    const data = await fetchDocumentChunks(doc.doc_id);
    chunkCacheRef.current.set(doc.doc_id, data.parents);
    setInspect({ doc, parents: data.parents, activeTab: "full", expandedChunks: new Set([0]), searchQuery: "" });
  };

  const toggleChunk = (idx: number) => {
    setInspect((prev) => {
      if (!prev) return prev;
      const next = new Set(prev.expandedChunks);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return { ...prev, expandedChunks: next };
    });
  };

  const inspectFilteredParents = useMemo(() => {
    if (!inspect) return [];
    const q = inspect.searchQuery.trim().toLowerCase();
    if (!q) return inspect.parents;
    return inspect.parents.filter(
      (p) => p.text.toLowerCase().includes(q) || (p.section_header || "").toLowerCase().includes(q)
    );
  }, [inspect]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Knowledge Base</h2>
          <p className="text-[11px] text-zinc-400">PDF · DOCX · PPTX · XLSX · HTML · Code · TXT</p>
        </div>
        {onCloseMobile && (
          <button
            onClick={onCloseMobile}
            title="Close drawer"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Upload zone */}
      <div className="p-3 space-y-2.5">
        <motion.div
          whileHover={{ borderColor: "rgba(222,115,86,0.65)" }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-3.5 text-center transition-all ${
            dragging ? "border-orange-500 bg-orange-500/10" : "border-zinc-700"
          }`}
        >
          {uploading ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-orange-400" />
          ) : (
            <UploadCloud className="mx-auto h-5 w-5 text-orange-400" />
          )}
          <div className="mt-1 text-xs font-medium text-zinc-200">
            {uploading ? "Ingesting…" : "Drop files or click to upload"}
          </div>
          <div className="text-[10px] text-zinc-400">SHA-256 dedup · contextual indexing</div>
        </motion.div>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.md,.markdown,.txt,.csv,.json,.html,.htm,.pptx,.xlsx,.py,.ts,.tsx,.js,.jsx,.css,.sql,.yaml,.yml,.toml"
          className="hidden"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { handleFiles(e.target.files, false); e.target.value = ""; }}
        />
        <input
          ref={(el) => {
            folderRef.current = el;
            if (el) {
              el.webkitdirectory = true;
              (el as HTMLInputElement & { directory?: boolean }).directory = true;
            }
          }}
          type="file"
          webkitdirectory=""
          multiple
          className="hidden"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { handleFiles(e.target.files, true); e.target.value = ""; }}
        />

        <button
          type="button"
          onClick={() => folderRef.current?.click()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 py-1.5 text-[11px] font-medium text-zinc-300 hover:border-orange-500/50 hover:text-orange-300 transition"
        >
          <FolderPlus className="h-3.5 w-3.5 text-orange-400" />
          Upload Folder
        </button>

        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3 w-3 text-zinc-500" />
          <input
            id="kb-search-input"
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search files… (Ctrl+K)"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 pl-7 pr-2 py-1.5 text-[11px] text-zinc-200 placeholder-zinc-500 outline-none focus:border-orange-500/50"
          />
        </div>

        {selectedDocIds.length > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-orange-500/30 bg-orange-500/10 px-2.5 py-1.5 text-[11px] text-orange-300">
            <span className="flex items-center gap-1.5 font-medium">
              <Filter className="h-3 w-3" />
              Scoped to {selectedDocIds.length} {selectedDocIds.length === 1 ? "file" : "files"}
            </span>
            {onClearSelection && (
              <button onClick={onClearSelection} className="text-orange-400 hover:text-orange-200 underline">
                Clear
              </button>
            )}
          </div>
        )}

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-400"
            >
              {error}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Document list */}
      <div className="flex-1 space-y-1.5 overflow-y-auto px-3 pb-4">
        {filteredDocs.length === 0 && (
          <div className="rounded-xl border border-zinc-800 p-4 text-center text-xs text-zinc-500">
            {documents.length === 0 ? "No documents yet. Upload files above." : "No matching files."}
          </div>
        )}
        <AnimatePresence>
          {filteredDocs.map((doc) => (
            <motion.div
              key={doc.doc_id}
              initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.18 }}
              className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {doc.status === "ready" && onToggleSelectDoc && (
                      <button
                        type="button"
                        onClick={() => onToggleSelectDoc(doc.doc_id)}
                        title={selectedDocIds.includes(doc.doc_id) ? "Remove from chat scope" : "Scope chat to this file"}
                        className="shrink-0 text-zinc-500 hover:text-orange-400 transition"
                      >
                        {selectedDocIds.includes(doc.doc_id) ? (
                          <CheckSquare className="h-3.5 w-3.5 text-orange-400" />
                        ) : (
                          <Square className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                    <FileIcon filename={doc.filename} className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate text-xs font-medium text-zinc-100" title={doc.filename}>
                      {doc.filename}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">
                    {doc.status === "ready" && (
                      <>
                        <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                        <span>{doc.parent_count}p/{doc.child_count}c</span>
                        <span>·</span>
                        <span>{(doc.size_bytes / 1024).toFixed(1)} KB</span>
                      </>
                    )}
                    {doc.status === "processing" && (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin text-orange-400" />
                        <span>Ingesting {doc.progress}%</span>
                      </>
                    )}
                    {doc.status === "error" && (
                      <span className="flex items-center gap-1 text-rose-400">
                        <AlertCircle className="h-3 w-3" />
                        {doc.error_message || "Failed"}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-0.5">
                  {doc.status === "ready" && (
                    <motion.button
                      whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                      onClick={() => handleInspect(doc)}
                      title="Preview document"
                      className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-orange-400 transition"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </motion.button>
                  )}
                  <motion.button
                    whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                    onClick={() => handleDelete(doc.doc_id)}
                    disabled={deletingId === doc.doc_id}
                    title="Delete"
                    className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-rose-400 transition disabled:opacity-50"
                  >
                    {deletingId === doc.doc_id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-400" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </motion.button>
                </div>
              </div>
              {doc.status === "processing" && (
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                  <motion.div
                    className="h-full bg-gradient-to-r from-[#C15F3C] to-[#DE7356]"
                    initial={{ width: 0 }}
                    animate={{ width: `${doc.progress}%` }}
                    transition={{ duration: 0.5 }}
                  />
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* ── Document Preview Modal ───────────────────────────────── */}
      <AnimatePresence>
        {inspect && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && setInspect(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
            >
              {/* Modal header */}
              <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <FileIcon filename={inspect.doc.filename} className="h-5 w-5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-zinc-100 truncate">{inspect.doc.filename}</div>
                    <div className="text-[10px] text-zinc-400">
                      {inspect.parents.length} parent chunks · {inspect.doc.child_count} children · {(inspect.doc.size_bytes / 1024).toFixed(1)} KB
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setInspect(null)}
                  className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Tabs & In-document search */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-5 py-2.5">
                <div className="flex gap-1">
                  <button
                    onClick={() => setInspect((p) => p ? { ...p, activeTab: "full" } : p)}
                    className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                      inspect.activeTab === "full"
                        ? "bg-orange-500/20 text-orange-300 ring-1 ring-orange-500/40"
                        : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                  >
                    Full Document
                  </button>
                  <button
                    onClick={() => setInspect((p) => p ? { ...p, activeTab: "chunks" } : p)}
                    className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                      inspect.activeTab === "chunks"
                        ? "bg-orange-500/20 text-orange-300 ring-1 ring-orange-500/40"
                        : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                  >
                    Chunks ({inspectFilteredParents.length})
                  </button>
                </div>

                <div className="relative w-56">
                  <Search className="pointer-events-none absolute left-2.5 top-2 h-3 w-3 text-zinc-500" />
                  <input
                    type="text"
                    value={inspect.searchQuery}
                    onChange={(e) => setInspect((p) => p ? { ...p, searchQuery: e.target.value } : p)}
                    placeholder="Find in document…"
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 pl-7 pr-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-orange-500/60"
                  />
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto space-y-2 p-4">
                {inspectFilteredParents.length === 0 ? (
                  <div className="text-center text-sm text-zinc-500 py-8">No matching content.</div>
                ) : inspect.activeTab === "full" ? (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-4">
                    <ChunkContent
                      text={inspectFilteredParents.map((p) => p.text).join("\n\n")}
                      filename={inspect.doc.filename}
                      search={inspect.searchQuery}
                    />
                  </div>
                ) : (
                  inspectFilteredParents.map((p, idx) => {
                    const isOpen = inspect.expandedChunks.has(idx);
                    return (
                      <div key={p.parent_id} className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
                        <button
                          onClick={() => toggleChunk(idx)}
                          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-zinc-800/40 transition"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="shrink-0 rounded-md bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-bold font-mono text-orange-400">
                              #{idx + 1}
                            </span>
                            <span className="truncate text-xs font-medium text-zinc-200">{p.section_header || "—"}</span>
                          </div>
                          <div className="flex shrink-0 items-center gap-2 text-[10px] text-zinc-400">
                            <span>p.{p.page_number}</span>
                            <span>{p.text.length} chars</span>
                            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </div>
                        </button>
                        <AnimatePresence>
                          {isOpen && (
                            <motion.div
                              initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="border-t border-zinc-800 px-4 py-3">
                                <ChunkContent text={p.text} filename={inspect.doc.filename} search={inspect.searchQuery} />
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
