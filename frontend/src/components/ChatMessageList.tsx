"use client";

import React, { memo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { motion, AnimatePresence } from "motion/react";
import {
  AlertTriangle, User, BookOpen, Copy, Check,
  Volume2, VolumeX, RotateCcw, Pencil, Sparkles, Repeat2,
} from "lucide-react";
import { ChatTurn, SourceCitation } from "../types";
import { PipelineActivity } from "./PipelineActivity";
import { Mascot } from "./Mascot";

const CITATION_REGEX = /\[([^,\]]+),\s*p\.\s*(\d+)\]/g;

const TypingIndicator = () => (
  <div className="flex items-center gap-1 px-1 py-0.5">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="inline-block h-1.5 w-1.5 rounded-full bg-orange-400 animate-pulse-dot"
        style={{ animationDelay: `${i * 0.2}s` }}
      />
    ))}
  </div>
);

function CodeBlockPre({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopyCode = async () => {
    const txt = preRef.current?.innerText || "";
    try {
      await navigator.clipboard.writeText(txt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="group/code relative">
      <button
        type="button"
        onClick={handleCopyCode}
        title="Copy code"
        className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/90 px-2 py-0.5 text-[10px] text-zinc-300 opacity-0 transition group-hover/code:opacity-100 hover:border-orange-500/50 hover:text-orange-300"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={preRef} {...props}>
        {children}
      </pre>
    </div>
  );
}

const AnswerBody = memo(function AnswerBody({
  turn,
  onCite,
}: {
  turn: ChatTurn;
  onCite: (c: SourceCitation) => void;
}) {
  // Replace repeated inline [filename, p. N] tags with a clean filename reference
  const displayContent = turn.content.replace(CITATION_REGEX, (_full, fname) => `[${fname.trim()}]`);
  const regex = new RegExp(CITATION_REGEX);
  const seenFiles = new Set<string>();
  const inlineCitations: Array<{ filename: string; citation?: SourceCitation }> = [];
  let m: RegExpExecArray | null;

  while ((m = regex.exec(turn.content)) !== null) {
    const fname = m[1].trim();
    const page = parseInt(m[2], 10);
    if (seenFiles.has(fname.toLowerCase())) continue;
    seenFiles.add(fname.toLowerCase());
    const src =
      turn.citations.find((c) => c.filename === fname && c.page_number === page) ||
      turn.citations.find((c) => c.filename.toLowerCase().includes(fname.toLowerCase())) ||
      turn.citations[0];
    inlineCitations.push({ filename: fname, citation: src });
  }

  return (
    <div>
      <div className={`chat-prose ${turn.streaming ? "streaming-cursor" : ""}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex, rehypeHighlight]}
          components={{
            pre({ children, ...props }) {
              return <CodeBlockPre {...props}>{children}</CodeBlockPre>;
            },
            code({ className, children }) {
              return <code className={className}>{children}</code>;
            },
          }}
        >
          {displayContent || (turn.streaming ? "" : "\u200b")}
        </ReactMarkdown>
      </div>
      {inlineCitations.length > 0 && turn.citations.length === 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {inlineCitations.map((item) => (
            <button
              key={item.filename}
              onClick={() => item.citation && onCite(item.citation)}
              className="inline-flex items-center gap-1 rounded-md bg-orange-500/15 px-2 py-0.5 text-[11px] font-medium text-orange-300 ring-1 ring-orange-500/30 transition hover:bg-orange-500/25 hover:text-orange-200"
            >
              <BookOpen className="h-2.5 w-2.5" />
              {item.filename}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

interface Props {
  messages: ChatTurn[];
  streaming: boolean;
  userTyping?: boolean;
  hasReadyDocs?: boolean;
  openDiagrams: Record<string, boolean>;
  copiedId: string | null;
  speakingId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onToggleDiagram: (turnId: string) => void;
  onCite: (c: SourceCitation) => void;
  onSubmitQuery: (query: string) => void;
  onEditUserMessage: (index: number) => void;
  onRegenerate: (index: number) => void;
  onCopyAnswer: (turn: ChatTurn) => void;
  onSpeakAnswer: (turn: ChatTurn) => void;
  onCloseHistory: () => void;
}

export const ChatMessageList: React.FC<Props> = ({
  messages,
  streaming,
  userTyping = false,
  hasReadyDocs = false,
  openDiagrams,
  copiedId,
  speakingId,
  scrollRef,
  onToggleDiagram,
  onCite,
  onSubmitQuery,
  onEditUserMessage,
  onRegenerate,
  onCopyAnswer,
  onSpeakAnswer,
  onCloseHistory,
}) => (
  <div
    ref={scrollRef}
    onClick={onCloseHistory}
    className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 space-y-4"
  >
    <AnimatePresence>
      {messages.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="mx-auto mt-14 max-w-xl text-center"
        >
          <div className="relative mx-auto mb-4 flex items-center justify-center">
            <motion.div
              animate={{ scale: [1, 1.12, 1], opacity: [0.22, 0.42, 0.22] }}
              transition={{ repeat: Infinity, duration: 3.4, ease: "easeInOut" }}
              className="pointer-events-none absolute h-24 w-24 rounded-full bg-gradient-to-tr from-[#C15F3C]/35 to-[#FCD34D]/25 blur-xl"
            />
            <Mascot
              size={88}
              mood={userTyping ? "curious" : "hello"}
              greetOnHover
              speech={userTyping ? "Owly is listening…" : "Hi, I'm Owly! 👋"}
            />
          </div>
          <motion.h1
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.35 }}
            className="text-xl font-semibold text-white"
          >
            Ask your documents anything
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18, duration: 0.35 }}
            className="mt-2 text-sm text-cloudy leading-relaxed"
          >
            Chat naturally with Owly, or upload PDF, DOCX, PPTX, XLSX, HTML, Code, Markdown, CSV, or TXT files for grounded Q&amp;A.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.26, duration: 0.35 }}
            className="mt-6 flex flex-wrap items-center justify-center gap-2"
          >
            {(hasReadyDocs
              ? [
                  "Summarize the key takeaways",
                  "What important numbers or specs are in my files?",
                  "Compare the main topics covered",
                ]
              : [
                  "Hi Owly! What can you help me with?",
                  "Explain how hybrid RAG works simply",
                  "Write a clean Python script to parse JSON",
                ]
            ).map((starter, idx) => (
              <motion.button
                key={starter}
                type="button"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.28 + idx * 0.06 }}
                whileHover={{ scale: 1.03, y: -1 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => onSubmitQuery(starter)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#2E2C29] bg-[#1C1B19]/80 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-orange-500/50 hover:text-orange-200"
              >
                <Sparkles className="h-3 w-3 text-[#DE7356]" />
                {starter}
              </motion.button>
            ))}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    <AnimatePresence initial={false}>
      {messages.map((turn, turnIndex) => (
        <motion.div
          key={turn.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className={`mx-auto max-w-3xl ${turn.role === "user" ? "flex justify-end" : ""}`}
        >
          {turn.role === "user" ? (
            <div className="group/user flex items-end gap-2">
              <div
                className={`mb-1 flex items-center gap-1 transition ${
                  copiedId === turn.id
                    ? "opacity-100"
                    : "opacity-100 sm:opacity-0 sm:group-hover/user:opacity-100"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onCopyAnswer(turn)}
                  title={copiedId === turn.id ? "Copied" : "Copy your message"}
                  className="rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-orange-400"
                >
                  {copiedId === turn.id ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
                {!streaming && (
                  <>
                    <button
                      type="button"
                      onClick={() => onSubmitQuery(turn.content)}
                      title="Repeat message"
                      className="rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-orange-400"
                    >
                      <Repeat2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditUserMessage(turnIndex)}
                      title="Edit & resend"
                      className="rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-orange-400"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
              <div className="max-w-[82%] rounded-2xl rounded-br-sm bg-gradient-to-br from-[#DE7356] to-[#C15F3C] px-4 py-2.5 text-sm font-medium text-white shadow-[0_4px_24px_rgba(193,95,60,0.3)]">
                {turn.content}
              </div>
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#C15F3C]/20 ring-1 ring-[#C15F3C]/50">
                <User className="h-3.5 w-3.5 text-[#DE7356]" />
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center">
                <Mascot
                  size={32}
                  thinking={Boolean(turn.streaming)}
                  greetOnHover
                  mood={
                    turn.isError
                      ? "sad"
                      : turn.streaming
                        ? turn.content
                          ? "writing"
                          : turn.liveStage?.stage === "search"
                            ? "searching"
                            : "thinking"
                        : turnIndex === messages.length - 1 && turn.content
                          ? "celebrating"
                          : "normal"
                  }
                />
              </div>
              <div className="flex-1 space-y-2.5 rounded-2xl rounded-tl-sm border border-[#2E2C29] bg-[#1C1B19]/90 p-4 shadow-sm">
                <PipelineActivity
                  trace={turn.trace}
                  liveStage={turn.liveStage}
                  streaming={turn.streaming}
                  hasContent={Boolean(turn.content)}
                  isError={turn.isError}
                  isOpen={Boolean(openDiagrams[turn.id])}
                  onToggle={() => onToggleDiagram(turn.id)}
                />

                {turn.isError ? (
                  <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <span className="leading-relaxed">{turn.content}</span>
                  </div>
                ) : turn.content || turn.streaming ? (
                  turn.content ? (
                    <AnswerBody turn={turn} onCite={onCite} />
                  ) : null
                ) : (
                  <TypingIndicator />
                )}

                {!turn.streaming && turn.followups && turn.followups.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {turn.followups.map((fq, fi) => (
                      <button
                        key={fi}
                        onClick={() => onSubmitQuery(fq)}
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-orange-500/50 hover:text-orange-300"
                      >
                        <Sparkles className="h-2.5 w-2.5 text-orange-400" />
                        {fq}
                      </button>
                    ))}
                  </div>
                )}

                {(turn.citations.length > 0 || (!turn.streaming && turn.content && !turn.isError)) && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {Array.from(
                        turn.citations
                          .reduce((map, src) => {
                            const key = src.doc_id || src.filename;
                            const prev = map.get(key);
                            if (!prev || src.rerank_score > prev.rerank_score) {
                              map.set(key, src);
                            }
                            return map;
                          }, new Map<string, SourceCitation>())
                          .values()
                      ).map((src) => (
                        <motion.button
                          key={src.doc_id || src.filename}
                          whileHover={{ scale: 1.04 }}
                          whileTap={{ scale: 0.96 }}
                          onClick={() => onCite(src)}
                          className="flex items-center gap-1 rounded-lg border border-zinc-700/80 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-orange-500/50 hover:text-orange-300"
                        >
                          <BookOpen className="h-2.5 w-2.5 text-orange-400" />
                          {src.filename}
                        </motion.button>
                      ))}
                    </div>

                    {!turn.streaming && turn.content && !turn.isError && (
                      <div className="ml-auto flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSpeakAnswer(turn)}
                          title={speakingId === turn.id ? "Stop reading" : "Read aloud"}
                          className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-orange-500/40 hover:text-orange-300"
                        >
                          {speakingId === turn.id ? (
                            <VolumeX className="h-3 w-3 text-orange-400" />
                          ) : (
                            <Volume2 className="h-3 w-3" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onRegenerate(turnIndex)}
                          title="Regenerate response"
                          className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-orange-500/40 hover:text-orange-300"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                        <motion.button
                          whileHover={{ scale: 1.04 }}
                          whileTap={{ scale: 0.96 }}
                          onClick={() => onCopyAnswer(turn)}
                          title="Copy answer"
                          className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-orange-500/40 hover:text-orange-300"
                        >
                          {copiedId === turn.id ? (
                            <>
                              <Check className="h-3 w-3 text-emerald-400" />
                              <span className="text-emerald-300">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>Copy</span>
                            </>
                          )}
                        </motion.button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </motion.div>
      ))}
    </AnimatePresence>
  </div>
);
