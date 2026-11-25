"use client";

import React, { useRef, useState } from "react";
import { motion } from "motion/react";
import { HardDrive, X, Download, Upload } from "lucide-react";
import { exportWorkspaceBackup, restoreWorkspaceBackup } from "../api";

interface Props {
  onClose: () => void;
  onRestored: () => void;
}

export const BackupModal: React.FC<Props> = ({ onClose, onRestored }) => {
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restoreRef = useRef<HTMLInputElement>(null);

  const handleExportBackup = async () => {
    setError(null);
    setStatusMsg(null);
    try {
      const data = await exportWorkspaceBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `owly-rag-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMsg("Workspace backup downloaded.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Export failed.");
    }
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setStatusMsg(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await restoreWorkspaceBackup(json);
      setStatusMsg(
        `Restored ${res.counts.documents ?? 0} documents and ${res.counts.chats ?? 0} chat entries.`
      );
      onRestored();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Invalid backup JSON.");
    } finally {
      e.target.value = "";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-orange-500/20">
              <HardDrive className="h-4 w-4 text-orange-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Backup &amp; Restore</h2>
              <p className="text-[11px] text-zinc-400">Export or restore your workspace data</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 transition">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <p className="text-xs text-zinc-400 leading-relaxed">
            Export all indexed documents, chunks, and backend chat history into a portable JSON archive,
            or restore from a previous backup.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleExportBackup}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-[#DE7356] to-[#C15F3C] px-4 py-2 text-xs font-semibold text-white transition hover:brightness-110"
            >
              <Download className="h-3.5 w-3.5" />
              Export Full Backup (.json)
            </button>
            <button
              onClick={() => restoreRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-200 transition hover:border-orange-500/60"
            >
              <Upload className="h-3.5 w-3.5 text-orange-400" />
              Restore from Backup
            </button>
            <input ref={restoreRef} type="file" accept=".json" className="hidden" onChange={handleRestoreFile} />
          </div>
          {error && <div className="rounded-lg bg-rose-500/10 p-2.5 text-xs text-rose-400">{error}</div>}
          {statusMsg && <div className="rounded-lg bg-emerald-500/10 p-2.5 text-xs text-emerald-300">{statusMsg}</div>}
        </div>
      </motion.div>
    </motion.div>
  );
};
