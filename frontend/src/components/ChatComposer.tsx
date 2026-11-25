"use client";

import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Send, Square, SlidersHorizontal, Filter, X,
} from "lucide-react";
import { ChatSettings, DocumentItem, QueryMode, SystemPersona } from "../types";

interface Props {
  input: string;
  setInput: (val: string) => void;
  streaming: boolean;
  showControls: boolean;
  setShowControls: React.Dispatch<React.SetStateAction<boolean>>;
  chatSettings: ChatSettings;
  setChatSettings: React.Dispatch<React.SetStateAction<ChatSettings>>;
  scopedDocs: DocumentItem[];
  onToggleSelectDoc: (docId: string) => void;
  onStopGeneration: () => void;
  onSend: (e: React.FormEvent) => void;
}

export const ChatComposer: React.FC<Props> = ({
  input,
  setInput,
  streaming,
  showControls,
  setShowControls,
  chatSettings,
  setChatSettings,
  scopedDocs,
  onToggleSelectDoc,
  onStopGeneration,
  onSend,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  return (
    <form
      onSubmit={onSend}
      className="border-t border-[#2E2C29] bg-[#1C1B19]/95 p-3 backdrop-blur"
    >
      <AnimatePresence>
        {showControls && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="mx-auto mb-2.5 max-w-3xl rounded-xl border border-[#2E2C29] bg-[#141413] p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs"
          >
            <div>
              <label className="block text-[10px] uppercase text-zinc-400 mb-1">Persona</label>
              <select
                value={chatSettings.system_persona}
                onChange={(e) =>
                  setChatSettings((s) => ({ ...s, system_persona: e.target.value as SystemPersona }))
                }
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
              >
                <option value="default">Default</option>
                <option value="analyst">Analyst</option>
                <option value="summarizer">Summarizer</option>
                <option value="coder">Code Reviewer</option>
                <option value="eli5">Simple (ELI5)</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase text-zinc-400 mb-1">Mode</label>
              <select
                value={chatSettings.query_mode}
                onChange={(e) =>
                  setChatSettings((s) => ({ ...s, query_mode: e.target.value as QueryMode }))
                }
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
              >
                <option value="qa">Smart Auto (Docs + Chat)</option>
                <option value="chat">Normal Chat</option>
                <option value="summarize">Summarize</option>
                <option value="compare">Compare</option>
                <option value="extract">Extract Facts</option>
                <option value="quiz">Study Quiz</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase text-zinc-400 mb-1">
                Temp: {chatSettings.temperature.toFixed(1)}
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={chatSettings.temperature}
                onChange={(e) =>
                  setChatSettings((s) => ({ ...s, temperature: parseFloat(e.target.value) }))
                }
                className="w-full accent-orange-500"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase text-zinc-400 mb-1">
                Top-K: {chatSettings.top_k}
              </label>
              <input
                type="range"
                min="2"
                max="12"
                step="1"
                value={chatSettings.top_k}
                onChange={(e) =>
                  setChatSettings((s) => ({ ...s, top_k: parseInt(e.target.value, 10) }))
                }
                className="w-full accent-orange-500"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {scopedDocs.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-1.5 text-[11px]">
          <span className="flex items-center gap-1 text-orange-400 font-medium">
            <Filter className="h-3 w-3" />
            Searching only:
          </span>
          {scopedDocs.map((d) => (
            <span
              key={d.doc_id}
              className="inline-flex items-center gap-1 rounded-md border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-orange-300"
            >
              <span className="max-w-[140px] truncate">{d.filename}</span>
              <button type="button" onClick={() => onToggleSelectDoc(d.doc_id)} className="hover:text-white">
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <button
          type="button"
          onClick={() => setShowControls((p) => !p)}
          title="Generation parameters & query mode"
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition ${
            showControls
              ? "border-orange-500/60 bg-orange-500/15 text-orange-300"
              : "border-zinc-700/80 bg-zinc-950 text-zinc-400 hover:border-orange-500/50 hover:text-orange-300"
          }`}
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={1}
          placeholder={
            scopedDocs.length > 0
              ? `Ask within ${scopedDocs.length} selected document(s)… (Shift+Enter for newline)`
              : "Ask Owly anything — chat normally or ask about your files… (Shift+Enter for newline)"
          }
          className="flex-1 resize-none rounded-xl border border-zinc-700/80 bg-zinc-950 px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition focus:border-orange-500/60 focus:ring-1 focus:ring-orange-500/20"
          style={{ maxHeight: "160px", overflowY: "auto" }}
        />

        <AnimatePresence mode="wait" initial={false}>
          {streaming ? (
            <motion.button
              key="stop-btn"
              type="button"
              onClick={onStopGeneration}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.94 }}
              transition={{ duration: 0.15 }}
              title="Stop generation"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-rose-500/50 bg-rose-500/20 text-rose-300 transition hover:bg-rose-500/30"
            >
              <Square className="h-4 w-4 fill-current" />
            </motion.button>
          ) : (
            <motion.button
              key="send-btn"
              type="submit"
              disabled={!input.trim()}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.94 }}
              transition={{ duration: 0.15 }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#DE7356] to-[#C15F3C] text-white shadow-[0_0_20px_rgba(193,95,60,0.35)] transition hover:brightness-110 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </form>
  );
};
