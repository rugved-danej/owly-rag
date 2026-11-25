"use client";

import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Search, Layers, ShieldCheck, ShieldAlert, Cpu, RefreshCw,
  CheckCircle2, ChevronDown, ChevronRight, Activity, XCircle,
  Sparkles, Zap, AlertTriangle,
} from "lucide-react";
import { LiveStage, TraceStep } from "../types";
import { Mascot } from "./Mascot";

interface Props {
  trace: TraceStep[];
  liveStage?: LiveStage | null;
  streaming?: boolean;
  hasContent: boolean;
  isError?: boolean;
  isOpen: boolean;
  onToggle: () => void;
}

type StageKey = "search" | "rerank" | "grade" | "rewrite" | "generate" | "rejected" | "blocked";

function formatSeconds(ms: number): string {
  const sec = ms / 1000;
  return `${(sec < 0.1 ? 0.1 : sec).toFixed(1)}s`;
}

function deriveJourneyState(
  trace: TraceStep[],
  liveStage: LiveStage | null | undefined,
  streaming: boolean,
  hasContent: boolean,
  isError: boolean
) {
  const searchSteps = trace.filter((t) => t.step.toLowerCase().includes("hybrid search"));
  const rerankSteps = trace.filter((t) => t.step.toLowerCase().includes("rerank"));
  const gradeSteps = trace.filter((t) => t.step.toLowerCase().includes("grading"));
  const rewriteSteps = trace.filter((t) => t.step.toLowerCase().includes("rewriting"));
  const genSteps = trace.filter((t) => t.step.toLowerCase().includes("generation"));
  const directSteps = trace.filter(
    (t) => t.step.toLowerCase().includes("greeting") || t.step.toLowerCase().includes("normal chat")
  );
  const kbWarnings = trace.filter((t) => t.step.toLowerCase().includes("knowledge base"));
  const isDirectChat =
    (directSteps.length > 0 || (liveStage?.stage === "generate" && searchSteps.length === 0)) &&
    searchSteps.length === 0;

  const latestSearch = searchSteps[searchSteps.length - 1];
  const latestRerank =
    rerankSteps[rerankSteps.length - 1] ||
    (latestSearch?.step.includes("& Rerank") ? latestSearch : undefined);
  const latestGrade = gradeSteps[gradeSteps.length - 1];
  const latestGen = genSteps[genSteps.length - 1];

  const hadRetry = gradeSteps.some((g) => g.status === "retry") || rewriteSteps.length > 0;
  const hadCacheHit = trace.some((t) => Boolean(t.meta?.cache_hit));
  const passCount = Math.max(1, searchSteps.length, gradeSteps.length, liveStage?.pass ?? 1);

  const finalRejected = !streaming && latestGrade?.status === "retry";
  const finalApproved = latestGrade?.status === "completed";
  const noFilesBlocked =
    !streaming && (kbWarnings.length > 0 || (isError && !latestGen && !hasContent));

  let mascotStage: StageKey = "search";
  if (streaming) {
    if (hasContent || latestGen) {
      mascotStage = "generate";
    } else if (liveStage?.stage) {
      mascotStage = liveStage.stage;
    } else {
      const last = trace[trace.length - 1];
      const lower = last?.step.toLowerCase() ?? "";
      if (!last) mascotStage = "search";
      else if (lower.includes("hybrid search & rerank")) mascotStage = "grade";
      else if (lower.includes("hybrid search")) mascotStage = "rerank";
      else if (lower.includes("reranking")) mascotStage = "grade";
      else if (lower.includes("grading")) mascotStage = last.status === "retry" ? "rewrite" : "generate";
      else if (lower.includes("rewriting")) mascotStage = "search";
      else if (lower.includes("generation")) mascotStage = "generate";
    }
  } else if (noFilesBlocked) {
    mascotStage = "blocked";
  } else if (finalRejected) {
    mascotStage = "rejected";
  } else {
    mascotStage = "generate";
  }

  return {
    searchSteps,
    rerankSteps: rerankSteps.length > 0 ? rerankSteps : latestRerank ? [latestRerank] : [],
    gradeSteps,
    rewriteSteps,
    genSteps,
    directSteps,
    isDirectChat,
    kbWarnings,
    latestSearch,
    latestRerank,
    latestGrade,
    latestGen,
    hadRetry,
    hadCacheHit,
    passCount,
    finalRejected,
    finalApproved,
    noFilesBlocked,
    mascotStage,
  };
}

function getLiveStatusLabel(
  trace: TraceStep[],
  liveStage: LiveStage | null | undefined,
  streaming: boolean,
  hasContent: boolean,
  state: ReturnType<typeof deriveJourneyState>
): string {
  if (!streaming) {
    const totalMs = trace.reduce((acc, t) => acc + (t.duration_ms || 0), 0);
    if (state.isDirectChat) {
      return `Chatted directly with Owly${totalMs > 0 ? ` · ${formatSeconds(totalMs)}` : ""}`;
    }
    if (state.noFilesBlocked) return "Stopped before searching · No ready files";
    if (state.finalRejected) {
      return `Searched ${state.passCount} ${state.passCount === 1 ? "time" : "times"} · Answer not in your files${totalMs > 0 ? ` · ${formatSeconds(totalMs)}` : ""}`;
    }
    const retryNote = state.hadRetry ? ` · Tried ${state.passCount} times` : "";
    const cacheNote = state.hadCacheHit ? " · Instant memory hit" : "";
    return `Answered from your files${retryNote}${cacheNote}${totalMs > 0 ? ` · ${formatSeconds(totalMs)}` : ""}`;
  }

  if (hasContent) return "Writing your answer…";
  if (liveStage?.label) return liveStage.label;
  if (state.mascotStage === "search") return "Looking through your files…";
  if (state.mascotStage === "rerank") return "Picking the best sections…";
  if (state.mascotStage === "grade") return "Checking if these parts answer your question…";
  if (state.mascotStage === "rewrite") return "Trying a better way to phrase your question…";
  return "Writing your answer…";
}

const MASCOT_COORDS: Record<StageKey, { left: string; top: string; bubble: string }> = {
  search: { left: "14.5%", top: "17%", bubble: "Looking in files…" },
  rerank: { left: "38%", top: "17%", bubble: "Picking best parts…" },
  grade: { left: "62%", top: "17%", bubble: "Checking fit…" },
  rewrite: { left: "38%", top: "63%", bubble: "Trying new words!" },
  generate: { left: "85.5%", top: "17%", bubble: "Writing answer!" },
  rejected: { left: "62%", top: "17%", bubble: "Not in files" },
  blocked: { left: "14.5%", top: "17%", bubble: "No files ready" },
};

export const PipelineActivity: React.FC<Props> = ({
  trace,
  liveStage = null,
  streaming = false,
  hasContent,
  isError = false,
  isOpen,
  onToggle,
}) => {
  const [selectedNode, setSelectedNode] = useState<StageKey | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runDirection, setRunDirection] = useState<"right" | "left">("right");
  const state = deriveJourneyState(trace, liveStage, streaming, hasContent, isError);
  const prevStageRef = useRef<StageKey>(state.mascotStage);

  useEffect(() => {
    const prev = prevStageRef.current;
    const next = state.mascotStage;
    if (prev !== next) {
      const prevX = parseFloat(MASCOT_COORDS[prev].left);
      const nextX = parseFloat(MASCOT_COORDS[next].left);
      if (nextX < prevX || next === "rewrite") {
        setRunDirection("left");
      } else if (nextX > prevX) {
        setRunDirection("right");
      }
      prevStageRef.current = next;
      setIsRunning(true);
      const timer = setTimeout(() => setIsRunning(false), 680);
      return () => clearTimeout(timer);
    }
  }, [state.mascotStage]);

  if (!streaming && trace.length === 0) return null;

  if (state.isDirectChat) {
    const label = getLiveStatusLabel(trace, liveStage, streaming, hasContent, state);
    return (
      <div className="inline-flex items-center gap-2 rounded-lg border border-[#2E2C29] bg-[#141413]/75 px-2.5 py-1 text-[11px] text-zinc-300">
        <span className={`h-2 w-2 rounded-full ${streaming ? "bg-[#DE7356] animate-pulse" : "bg-emerald-400"}`} />
        <span>{label}</span>
      </div>
    );
  }

  const statusLabel = getLiveStatusLabel(trace, liveStage, streaming, hasContent, state);
  const mascotPos = MASCOT_COORDS[state.mascotStage];

  const activeDetailNode = streaming ? state.mascotStage : (selectedNode ?? state.mascotStage);
  const inspectedSteps: TraceStep[] = (() => {
    if (activeDetailNode === "search" || activeDetailNode === "blocked") {
      return state.kbWarnings.length > 0 && state.searchSteps.length === 0
        ? state.kbWarnings
        : state.searchSteps;
    }
    if (activeDetailNode === "rerank") return state.rerankSteps;
    if (activeDetailNode === "grade" || activeDetailNode === "rejected") return state.gradeSteps;
    if (activeDetailNode === "rewrite") return state.rewriteSteps;
    if (activeDetailNode === "generate") return state.genSteps;
    return [];
  })();

  const searchDone = Boolean(state.latestSearch) && state.mascotStage !== "search";
  const rerankDone = Boolean(state.latestRerank) && state.mascotStage !== "rerank";
  const gradeApproved = state.finalApproved;
  const gradeDeniedActive = state.mascotStage === "rewrite" || state.finalRejected;
  const rewriteActive = state.hadRetry;
  const generateDone =
    (Boolean(state.latestGen) || (!streaming && !state.finalRejected && !state.noFilesBlocked && hasContent)) &&
    !state.noFilesBlocked;

  const mascotMood = (() => {
    if (state.mascotStage === "search" && streaming) return "searching" as const;
    if (state.mascotStage === "generate" && streaming) return "writing" as const;
    if (state.mascotStage === "rewrite") return "curious" as const;
    if (state.mascotStage === "rejected" || state.mascotStage === "blocked") return "sad" as const;
    if (!streaming && generateDone) return "celebrating" as const;
    return "normal" as const;
  })();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`rounded-xl border transition-colors ${
        streaming
          ? "border-[#C15F3C]/45 bg-[#141413]/90 shadow-[0_0_24px_rgba(193,95,60,0.12)]"
          : "border-[#2E2C29] bg-[#141413]/75"
      }`}
    >
      {/* Friendly Summary Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs transition hover:text-zinc-200"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {streaming && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#DE7356] opacity-75" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                streaming
                  ? "bg-[#DE7356]"
                  : state.finalRejected || state.noFilesBlocked
                    ? "bg-rose-400"
                    : "bg-emerald-400"
              }`}
            />
          </span>
          <Activity className="h-3.5 w-3.5 shrink-0 text-[#DE7356]" />
          <span className={`truncate font-medium ${streaming ? "text-orange-300" : "text-zinc-300"}`}>
            {statusLabel}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-[11px] text-zinc-500">
          {state.hadCacheHit && (
            <span className="hidden sm:inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
              <Zap className="h-2.5 w-2.5" />
              Instant Cache
            </span>
          )}
          <span className="hidden sm:inline">{isOpen ? "Hide Owly's journey" : "Show Owly's journey"}</span>
          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </div>
      </button>

      {/* Visual Mascot Journey Diagram */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            className="overflow-hidden border-t border-[#2E2C29]"
          >
            <div className="p-3 sm:p-4 space-y-2.5">
              {/* Diagram Stage Canvas */}
              <div className="relative w-full h-44 sm:h-48 rounded-xl bg-[#181715] border border-[#2A2724] overflow-hidden select-none">
                <div
                  className="pointer-events-none absolute inset-0 opacity-25"
                  style={{
                    backgroundImage: "radial-gradient(#4A453E 1px, transparent 1px)",
                    backgroundSize: "16px 16px",
                  }}
                />

                <svg
                  viewBox="0 0 800 220"
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                >
                  <defs>
                    <linearGradient id="flowForward" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#DE7356" />
                      <stop offset="100%" stopColor="#FBBF24" />
                    </linearGradient>
                  </defs>

                  <line x1="158" y1="80" x2="262" y2="80" stroke="#2E2C29" strokeWidth="3" strokeLinecap="round" />
                  <line x1="346" y1="80" x2="454" y2="80" stroke="#2E2C29" strokeWidth="3" strokeLinecap="round" />
                  <line x1="538" y1="80" x2="642" y2="80" stroke="#2E2C29" strokeWidth="3" strokeLinecap="round" />

                  {(searchDone || state.mascotStage === "rerank") && !state.noFilesBlocked && (
                    <motion.line
                      x1="158" y1="80" x2="262" y2="80"
                      stroke="url(#flowForward)" strokeWidth="3" strokeLinecap="round"
                      initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35 }}
                    />
                  )}
                  {(rerankDone || state.mascotStage === "grade") && !state.noFilesBlocked && (
                    <motion.line
                      x1="346" y1="80" x2="454" y2="80"
                      stroke="url(#flowForward)" strokeWidth="3" strokeLinecap="round"
                      initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35 }}
                    />
                  )}
                  {(gradeApproved || generateDone || state.mascotStage === "generate") &&
                    !state.finalRejected &&
                    !state.noFilesBlocked && (
                      <motion.line
                        x1="538" y1="80" x2="642" y2="80"
                        stroke="#34D399" strokeWidth="3" strokeLinecap="round"
                        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35 }}
                      />
                    )}

                  <path
                    d="M 496 108 C 496 164, 425 174, 352 174"
                    fill="none"
                    stroke={rewriteActive ? "#F59E0B" : "#2A2724"}
                    strokeWidth={rewriteActive ? "2.8" : "2"}
                    strokeDasharray="6 5"
                  />
                  <path
                    d="M 256 174 C 185 174, 116 164, 116 108"
                    fill="none"
                    stroke={rewriteActive ? "#DE7356" : "#2A2724"}
                    strokeWidth={rewriteActive ? "2.8" : "2"}
                    strokeDasharray="6 5"
                  />
                  <polygon
                    points="116,103 110,115 122,115"
                    fill={rewriteActive ? "#DE7356" : "#2A2724"}
                  />
                </svg>

                {/* Node 1: Find Matches */}
                <button
                  type="button"
                  onClick={() => setSelectedNode("search")}
                  style={{ left: "14.5%", top: "36%", transform: "translate(-50%, -50%)" }}
                  className={`absolute flex flex-col items-center justify-center w-[76px] sm:w-24 rounded-xl border px-1.5 py-1.5 transition ${
                    state.noFilesBlocked
                      ? "border-amber-500/70 bg-amber-500/15"
                      : state.mascotStage === "search"
                        ? "border-[#DE7356] bg-[#DE7356]/15 shadow-[0_0_16px_rgba(222,115,86,0.28)]"
                        : searchDone
                          ? "border-emerald-500/45 bg-emerald-500/10"
                          : "border-[#2E2C29] bg-[#1C1B19]"
                  } ${selectedNode === "search" ? "ring-1 ring-white/30" : ""}`}
                >
                  {state.noFilesBlocked ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                  ) : state.latestSearch?.meta?.cache_hit ? (
                    <Zap className="h-3.5 w-3.5 text-amber-400" />
                  ) : (
                    <Search className={`h-3.5 w-3.5 ${state.mascotStage === "search" ? "text-[#DE7356]" : searchDone ? "text-emerald-400" : "text-zinc-400"}`} />
                  )}
                  <span className="mt-1 text-[10px] font-semibold text-zinc-100 leading-tight">Find Matches</span>
                  <span className="text-[9px] text-zinc-400 leading-tight truncate max-w-full">
                    {state.noFilesBlocked
                      ? "No files"
                      : state.latestSearch?.meta?.cache_hit
                        ? "Instant Cache"
                        : state.latestSearch
                          ? `${state.latestSearch.meta?.candidates ?? 25} parts · ${formatSeconds(state.latestSearch.duration_ms)}`
                          : "Your files"}
                  </span>
                </button>

                {/* Node 2: Pick Best Parts */}
                <button
                  type="button"
                  onClick={() => setSelectedNode("rerank")}
                  style={{ left: "38%", top: "36%", transform: "translate(-50%, -50%)" }}
                  className={`absolute flex flex-col items-center justify-center w-[76px] sm:w-24 rounded-xl border px-1.5 py-1.5 transition ${
                    state.noFilesBlocked
                      ? "border-[#2E2C29] bg-[#1C1B19]/50 opacity-50"
                      : state.mascotStage === "rerank"
                        ? "border-[#DE7356] bg-[#DE7356]/15 shadow-[0_0_16px_rgba(222,115,86,0.28)]"
                        : rerankDone
                          ? "border-emerald-500/45 bg-emerald-500/10"
                          : "border-[#2E2C29] bg-[#1C1B19]"
                  } ${selectedNode === "rerank" ? "ring-1 ring-white/30" : ""}`}
                >
                  <Layers className={`h-3.5 w-3.5 ${state.mascotStage === "rerank" ? "text-[#DE7356]" : rerankDone ? "text-emerald-400" : "text-zinc-400"}`} />
                  <span className="mt-1 text-[10px] font-semibold text-zinc-100 leading-tight">Best Parts</span>
                  <span className="text-[9px] text-zinc-400 leading-tight truncate max-w-full">
                    {state.latestRerank
                      ? `Top ${state.latestRerank.meta?.windows ?? 5} · ${formatSeconds(state.latestRerank.duration_ms)}`
                      : "Rank snippets"}
                  </span>
                </button>

                {/* Node 3: Relevance Check */}
                <button
                  type="button"
                  onClick={() => setSelectedNode("grade")}
                  style={{ left: "62%", top: "36%", transform: "translate(-50%, -50%)" }}
                  className={`absolute flex flex-col items-center justify-center w-[76px] sm:w-24 rounded-xl border px-1.5 py-1.5 transition ${
                    state.noFilesBlocked
                      ? "border-[#2E2C29] bg-[#1C1B19]/50 opacity-50"
                      : state.finalRejected
                        ? "border-rose-500/70 bg-rose-500/15 shadow-[0_0_16px_rgba(244,63,94,0.25)]"
                        : state.mascotStage === "rewrite"
                          ? "border-amber-500/70 bg-amber-500/15 shadow-[0_0_16px_rgba(245,158,11,0.25)]"
                          : state.mascotStage === "grade"
                            ? "border-[#DE7356] bg-[#DE7356]/15 shadow-[0_0_16px_rgba(222,115,86,0.28)]"
                            : gradeApproved
                              ? "border-emerald-500/50 bg-emerald-500/10"
                              : "border-[#2E2C29] bg-[#1C1B19]"
                  } ${selectedNode === "grade" ? "ring-1 ring-white/30" : ""}`}
                >
                  {state.finalRejected ? (
                    <XCircle className="h-3.5 w-3.5 text-rose-400" />
                  ) : state.mascotStage === "rewrite" ? (
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
                  ) : (
                    <ShieldCheck className={`h-3.5 w-3.5 ${gradeApproved ? "text-emerald-400" : state.mascotStage === "grade" ? "text-[#DE7356]" : "text-zinc-400"}`} />
                  )}
                  <span className="mt-1 text-[10px] font-semibold text-zinc-100 leading-tight">Fit Check</span>
                  <span className={`text-[9px] leading-tight truncate max-w-full ${
                    state.finalRejected
                      ? "text-rose-300"
                      : state.mascotStage === "rewrite"
                        ? "text-amber-300"
                        : gradeApproved
                          ? "text-emerald-300"
                          : "text-zinc-400"
                  }`}>
                    {state.finalRejected
                      ? "No match"
                      : state.mascotStage === "rewrite"
                        ? "Not fit · Retry"
                        : gradeApproved
                          ? `Good match!`
                          : "Fits question?"}
                  </span>
                </button>

                {/* Node 4: Write Answer */}
                <button
                  type="button"
                  onClick={() => setSelectedNode("generate")}
                  style={{ left: "85.5%", top: "36%", transform: "translate(-50%, -50%)" }}
                  className={`absolute flex flex-col items-center justify-center w-[76px] sm:w-24 rounded-xl border px-1.5 py-1.5 transition ${
                    state.finalRejected || state.noFilesBlocked
                      ? "border-[#2E2C29] bg-[#1C1B19]/50 opacity-50"
                      : state.mascotStage === "generate" && streaming
                        ? "border-[#DE7356] bg-[#DE7356]/15 shadow-[0_0_16px_rgba(222,115,86,0.28)]"
                        : generateDone
                          ? "border-emerald-500/50 bg-emerald-500/10"
                          : "border-[#2E2C29] bg-[#1C1B19]"
                  } ${selectedNode === "generate" ? "ring-1 ring-white/30" : ""}`}
                >
                  {generateDone ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Cpu className={`h-3.5 w-3.5 ${state.mascotStage === "generate" && !state.finalRejected && !state.noFilesBlocked ? "text-[#DE7356]" : "text-zinc-400"}`} />
                  )}
                  <span className="mt-1 text-[10px] font-semibold text-zinc-100 leading-tight">Write Answer</span>
                  <span className="text-[9px] text-zinc-400 leading-tight truncate max-w-full">
                    {state.finalRejected || state.noFilesBlocked
                      ? "Skipped"
                      : state.latestGen
                        ? formatSeconds(state.latestGen.duration_ms)
                        : "AI Writing"}
                  </span>
                </button>

                {/* Bottom Loop Node: Rephrase Question */}
                <button
                  type="button"
                  onClick={() => setSelectedNode("rewrite")}
                  style={{ left: "38%", top: "79%", transform: "translate(-50%, -50%)" }}
                  className={`absolute flex items-center gap-1.5 rounded-xl border px-2.5 py-1 transition ${
                    state.mascotStage === "rewrite"
                      ? "border-amber-400 bg-amber-500/20 shadow-[0_0_16px_rgba(245,158,11,0.3)]"
                      : rewriteActive
                        ? "border-amber-500/45 bg-amber-500/10"
                        : "border-[#2A2724] bg-[#1C1B19]/60 opacity-55"
                  } ${selectedNode === "rewrite" ? "ring-1 ring-white/30" : ""}`}
                >
                  <RefreshCw className={`h-3 w-3 ${state.mascotStage === "rewrite" ? "animate-spin text-amber-300" : rewriteActive ? "text-amber-400" : "text-zinc-500"}`} />
                  <div className="text-left">
                    <div className="text-[10px] font-semibold text-zinc-200 leading-tight">
                      Rephrase Question {rewriteActive ? "(Tried again)" : "(If not found)"}
                    </div>
                  </div>
                </button>

                {/* Traveling Mascot (no border/box) */}
                <motion.div
                  className="pointer-events-none absolute z-20"
                  initial={false}
                  animate={{ left: mascotPos.left, top: mascotPos.top }}
                  transition={{ type: "spring", stiffness: 210, damping: 20 }}
                >
                  <div className="-translate-x-1/2 -translate-y-1/2 flex flex-col items-center">
                    {(streaming || state.finalRejected || state.noFilesBlocked) && (
                      <motion.div
                        key={mascotPos.bubble}
                        initial={{ opacity: 0, y: 4, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        className={`mb-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-semibold shadow ${
                          state.finalRejected || state.noFilesBlocked
                            ? "bg-rose-500 text-white"
                            : gradeDeniedActive
                              ? "bg-amber-500 text-zinc-950"
                              : "bg-[#DE7356] text-white"
                        }`}
                      >
                        {mascotPos.bubble}
                      </motion.div>
                    )}
                    <Mascot
                      size={30}
                      thinking={streaming}
                      running={streaming && (isRunning || state.mascotStage === "search" || state.mascotStage === "rewrite")}
                      direction={state.mascotStage === "rewrite" ? "left" : runDirection}
                      mood={mascotMood}
                    />
                  </div>
                </motion.div>
              </div>

              {/* Clicked / Active Stage Multi-Pass Details (Plain Language + Telemetry) */}
              {inspectedSteps.length > 0 && (
                <div className="rounded-lg bg-[#1C1B19] px-3 py-2 text-[11px] border border-[#2A2724] space-y-1.5">
                  {inspectedSteps.map((st, idx) => {
                    const m = st.meta || {};
                    const passNum = m.pass ?? idx + 1;
                    return (
                      <div
                        key={`${st.step}-${idx}`}
                        className={`flex flex-wrap items-center justify-between gap-2 ${
                          idx > 0 ? "border-t border-[#2A2724] pt-1.5" : ""
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <Sparkles className="h-3 w-3 shrink-0 text-[#DE7356]" />
                          {inspectedSteps.length > 1 && (
                            <span className="rounded bg-zinc-800 px-1.5 py-0.2 font-mono text-[10px] text-orange-300">
                              Try {passNum}
                            </span>
                          )}
                          <span className="text-zinc-200">{st.detail}</span>

                          {m.cache_hit && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.2 text-[10px] text-amber-300">
                              Instant Cache
                            </span>
                          )}
                          {typeof m.dense_hits === "number" && typeof m.bm25_hits === "number" && (
                            <span className="rounded bg-zinc-900 px-1.5 py-0.2 text-[10px] text-zinc-400">
                              Meaning: {m.dense_hits} · Words: {m.bm25_hits}
                            </span>
                          )}
                          {typeof m.ttft_ms === "number" && (
                            <span className="rounded bg-zinc-900 px-1.5 py-0.2 text-[10px] text-zinc-400">
                              First word: {formatSeconds(m.ttft_ms)}
                            </span>
                          )}
                          {typeof m.words_per_sec === "number" && (
                            <span className="rounded bg-zinc-900 px-1.5 py-0.2 text-[10px] text-zinc-400">
                              {m.words_per_sec} words/sec
                            </span>
                          )}
                        </div>
                        {st.duration_ms > 0 && (
                          <span className="shrink-0 font-mono text-[10px] text-orange-300">
                            {formatSeconds(st.duration_ms)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
