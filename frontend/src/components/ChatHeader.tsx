"use client";

import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Trash2, AlertTriangle, History, Plus,
  FolderOpen, Download, HardDrive,
} from "lucide-react";
import { ChatSession, HardwareReport } from "../types";
import { Mascot } from "./Mascot";
import { ModelBrandIcon } from "./BrandIcons";

interface Props {
  streaming: boolean;
  readyDocsCount: number;
  sessions: ChatSession[];
  activeSessionId: string;
  showHistory: boolean;
  setShowHistory: React.Dispatch<React.SetStateAction<boolean>>;
  onOpenMobileKB: () => void;
  onNewChat: () => void;
  onSwitchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, e: React.MouseEvent) => void;
  onOpenBackup: () => void;
  hasMessages: boolean;
  onExportMarkdown: () => void;
  hardware: HardwareReport | null;
  onOpenHardware: () => void;
  onClearChat: () => void;
}

export const ChatHeader: React.FC<Props> = ({
  streaming,
  readyDocsCount,
  sessions,
  activeSessionId,
  showHistory,
  setShowHistory,
  onOpenMobileKB,
  onNewChat,
  onSwitchSession,
  onDeleteSession,
  onOpenBackup,
  hasMessages,
  onExportMarkdown,
  hardware,
  onOpenHardware,
  onClearChat,
}) => {
  const [initialGreeting, setInitialGreeting] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setInitialGreeting(false), 2600);
    return () => clearTimeout(t);
  }, []);

  return (
    <header className="relative z-30 flex items-center justify-between border-b border-[#2E2C29] bg-[#1C1B19]/95 px-4 py-2.5 backdrop-blur-md">
    <div className="flex items-center gap-2.5">
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onOpenMobileKB}
        title="Open Knowledge Base"
        className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-[#2E2C29] bg-[#242220] text-zinc-300 hover:border-orange-500/60 hover:text-orange-400 transition md:hidden"
      >
        <FolderOpen className="h-4 w-4" />
        {readyDocsCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[9px] font-bold text-white">
            {readyDocsCount}
          </span>
        )}
      </motion.button>

      <div className="flex h-9 w-9 items-center justify-center">
        <Mascot
          size={36}
          thinking={streaming}
          mood={streaming ? "writing" : initialGreeting ? "hello" : "normal"}
          greetOnHover
        />
      </div>
      <div>
        <div className="text-sm font-bold leading-tight tracking-tight text-white">
          Owly RAG
        </div>
        <div className="text-[10px] text-zinc-400 leading-tight">with Owly</div>
      </div>
    </div>

    <div className="flex items-center gap-1.5 sm:gap-2">
      <motion.button
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        onClick={onNewChat}
        title="New conversation"
        className="flex items-center gap-1 rounded-lg border border-zinc-700/80 bg-zinc-800/60 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-orange-500/60 hover:text-orange-300"
      >
        <Plus className="h-3.5 w-3.5 text-orange-400" />
        <span className="hidden sm:inline">New Chat</span>
      </motion.button>

      <div className="relative">
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={() => setShowHistory((p) => !p)}
          title="Chat history"
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
            showHistory
              ? "border-orange-500/70 bg-orange-500/15 text-orange-300"
              : "border-zinc-700/80 bg-zinc-800/60 text-zinc-300 hover:border-orange-500/60 hover:text-orange-300"
          }`}
        >
          <History className="h-3.5 w-3.5 text-orange-400" />
          <span className="hidden sm:inline">Chats</span>
          <span className="rounded bg-zinc-900 px-1.5 py-0.2 font-mono text-[10px] text-zinc-400">
            {sessions.length}
          </span>
        </motion.button>

        <AnimatePresence>
          {showHistory && (
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: 0.16 }}
              className="absolute right-0 mt-2 w-72 rounded-xl border border-[#2E2C29] bg-[#1C1B19] p-2 shadow-2xl z-50"
            >
              <div className="flex items-center justify-between px-2 py-1.5 border-b border-[#2E2C29] mb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  Conversations
                </span>
                <button
                  onClick={onNewChat}
                  className="flex items-center gap-1 text-[11px] font-medium text-orange-400 hover:text-orange-300"
                >
                  <Plus className="h-3 w-3" /> New
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1">
                {sessions.map((s) => {
                  const active = s.id === activeSessionId;
                  return (
                    <div
                      key={s.id}
                      onClick={() => onSwitchSession(s.id)}
                      className={`group flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs transition ${
                        active
                          ? "bg-orange-500/15 text-white ring-1 ring-orange-500/40"
                          : "text-zinc-300 hover:bg-zinc-800/60"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{s.title}</div>
                        <div className="text-[10px] text-zinc-400">
                          {s.messageCount} {s.messageCount === 1 ? "message" : "messages"}
                        </div>
                      </div>
                      <button
                        onClick={(e) => onDeleteSession(s.id, e)}
                        title="Delete conversation"
                        className="rounded p-1 text-zinc-400 opacity-70 hover:bg-zinc-800 hover:text-rose-400 hover:opacity-100 transition"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onOpenBackup}
        title="Backup &amp; Restore"
        className="rounded-lg border border-zinc-700/80 bg-zinc-800/60 p-1.5 text-zinc-300 transition hover:border-orange-500/60 hover:text-orange-300"
      >
        <HardDrive className="h-4 w-4 text-orange-400" />
      </motion.button>

      {hasMessages && (
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onExportMarkdown}
          title="Export conversation (.md)"
          className="rounded-lg border border-zinc-700/80 bg-zinc-800/60 p-1.5 text-zinc-300 transition hover:border-orange-500/60 hover:text-orange-300"
        >
          <Download className="h-4 w-4" />
        </motion.button>
      )}

      {hardware && (
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={onOpenHardware}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-800/60 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-orange-500/60 hover:text-orange-300"
        >
          <ModelBrandIcon
            modelId={hardware.selected_llm || hardware.active_tier.llm_model}
            size={14}
            className="shrink-0"
          />
          <span className="hidden sm:inline font-mono text-orange-400">
            {hardware.selected_llm || hardware.active_tier.llm_model}
          </span>
          {(!hardware.ollama.reachable ||
            hardware.models?.some((m) => m.required && !m.installed)) && (
            <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
          )}
        </motion.button>
      )}

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onClearChat}
        title="Clear current chat"
        className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-orange-400"
      >
        <Trash2 className="h-4 w-4" />
      </motion.button>
    </div>
  </header>
  );
};
