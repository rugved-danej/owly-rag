"use client";

import React from "react";
import { motion, AnimatePresence } from "motion/react";
import { BookOpen, X, FileText, Hash, Star } from "lucide-react";
import { SourceCitation } from "../types";

interface Props {
  citation: SourceCitation | null;
  onClose: () => void;
}

export const CitationDrawer: React.FC<Props> = ({ citation, onClose }) => (
  <AnimatePresence>
    {citation && (
      <motion.aside
        key="drawer"
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: 400, opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ duration: 0.22, ease: "easeInOut" }}
        className="fixed inset-y-0 right-0 z-40 flex h-full max-w-[92vw] flex-col border-l border-[#2E2C29] bg-[#1C1B19]/98 overflow-hidden shadow-2xl lg:static lg:z-auto lg:shadow-none"
        style={{ minWidth: 0 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#2E2C29] px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-orange-500/20">
              <BookOpen className="h-3.5 w-3.5 text-orange-400" />
            </div>
            <span className="truncate text-sm font-semibold text-zinc-100">Source Passage</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 p-4">
          {/* File metadata card */}
          <div className="rounded-xl border border-[#2E2C29] bg-[#141413] p-3 space-y-2">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 shrink-0 text-orange-400" />
              <span className="truncate text-sm font-semibold text-zinc-100 break-all">
                {citation.filename}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <span className="flex items-center gap-1 rounded-md bg-orange-500/15 px-2 py-0.5 text-orange-300">
                <Hash className="h-2.5 w-2.5" />Page {citation.page_number}
              </span>
              {citation.section_header && (
                <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-zinc-300">
                  {citation.section_header}
                </span>
              )}
              <span className="flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-0.5 text-emerald-300">
                <Star className="h-2.5 w-2.5" />
                {citation.rerank_score.toFixed(2)}
              </span>
              {citation.rrf_score > 0 && (
                <span className="rounded-md bg-orange-500/15 px-2 py-0.5 text-orange-300">
                  RRF {citation.rrf_score.toFixed(3)}
                </span>
              )}
            </div>
          </div>

          {/* Matched part / parent window */}
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-400">
              Matched Passage
            </div>
            <div className="rounded-xl border border-[#2E2C29] bg-[#141413] p-4">
              <HighlightedText text={citation.text} excerpt={citation.matched_excerpt} />
            </div>
          </div>
        </div>
      </motion.aside>
    )}
  </AnimatePresence>
);

function HighlightedText({ text, excerpt }: { text: string; excerpt: string }) {
  const idx = excerpt ? text.indexOf(excerpt) : -1;
  if (idx === -1) {
    return (
      <p
        className="whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-200"
        style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", unicodeBidi: "plaintext" }}
      >
        {text}
      </p>
    );
  }
  return (
    <p
      className="whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-200"
      style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", unicodeBidi: "plaintext" }}
    >
      {text.slice(0, idx)}
      <mark className="rounded bg-[#C15F3C]/40 px-1 py-0.5 text-white ring-1 ring-[#DE7356]/60">
        {text.slice(idx, idx + excerpt.length)}
      </mark>
      {text.slice(idx + excerpt.length)}
    </p>
  );
}
