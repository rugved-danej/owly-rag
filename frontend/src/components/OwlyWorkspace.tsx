"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  ChatSession,
  ChatTurn,
  HardwareReport,
  LiveStage,
  SourceCitation,
  TraceStep,
} from "../types";
import {
  ChatJobStatusResponse,
  attachChatJobStream,
  clearChatHistory,
  deleteSessionApi,
  fetchChatHistory,
  getChatJobStatus,
  startChatJob,
  stopChatJob,
  upsertSessionApi,
} from "../api";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import {
  useDocumentsQuery,
  useHardwareQuery,
  useSessionsQuery,
  useWorkspaceQueryActions,
} from "../hooks/useWorkspaceQueries";
import { KnowledgeBase } from "./KnowledgeBase";
import { ChatHeader } from "./ChatHeader";
import { ChatMessageList } from "./ChatMessageList";
import { ChatComposer } from "./ChatComposer";

const HardwareModal = dynamic(
  () => import("./HardwareModal").then((m) => m.HardwareModal),
  { ssr: false }
);
const CitationDrawer = dynamic(
  () => import("./CitationDrawer").then((m) => m.CitationDrawer),
  { ssr: false }
);
const BackupModal = dynamic(
  () => import("./BackupModal").then((m) => m.BackupModal),
  { ssr: false }
);

const STORAGE_KEYS = {
  SESSIONS: "rag_sessions_v1",
  ACTIVE_SESSION: "rag_active_session_v1",
  ACTIVE_JOB: "rag_active_job_v1",
  SESSION_PREFIX: "rag_chat_session_",
  HARDWARE: "rag_hardware_v1",
} as const;

interface ActiveJobMeta {
  sessionId: string;
  botId: string;
  userTurn: ChatTurn;
}

function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota errors */
  }
}

function removeStorage(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function createSessionId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function initSessions(preferredSessionId?: string): { sessions: ChatSession[]; activeId: string } {
  const savedSessions = readStorage<ChatSession[]>(STORAGE_KEYS.SESSIONS, []);
  const savedActive = preferredSessionId || readStorage<string>(STORAGE_KEYS.ACTIVE_SESSION, "");

  if (preferredSessionId) {
    if (savedSessions.some((s) => s.id === preferredSessionId)) {
      return { sessions: savedSessions, activeId: preferredSessionId };
    }
    return {
      sessions: [
        {
          id: preferredSessionId,
          title: "New Conversation",
          updatedAt: new Date().toISOString(),
          messageCount: 0,
        },
        ...savedSessions,
      ],
      activeId: preferredSessionId,
    };
  }

  if (savedSessions.length > 0) {
    const activeId = savedSessions.some((s) => s.id === savedActive)
      ? savedActive
      : savedSessions[0].id;
    return { sessions: savedSessions, activeId };
  }

  return {
    sessions: [
      {
        id: "default",
        title: "New Conversation",
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      },
    ],
    activeId: "default",
  };
}

export default function OwlyWorkspace({ initialSessionId }: { initialSessionId?: string }) {
  const router = useRouter();
  const initialRef = useRef<{ sessions: ChatSession[]; activeId: string } | null>(null);
  if (!initialRef.current) {
    initialRef.current = initSessions(initialSessionId);
  }

  const {
    showHardware,
    showBackupModal,
    showMobileKB,
    showHistory,
    showControls,
    activeCitation,
    selectedDocIds,
    chatSettings,
    openDiagrams,
    setShowHardware,
    setShowBackupModal,
    setShowMobileKB,
    setShowHistory,
    setShowControls,
    setActiveCitation,
    toggleSelectDoc,
    pruneSelectedDocs,
    clearSelectedDocs,
    setChatSettings,
    toggleDiagram,
    openDiagram,
    closeTopOverlay,
  } = useWorkspaceStore();

  const hardwareQuery = useHardwareQuery();
  const documentsQuery = useDocumentsQuery();
  const sessionsQuery = useSessionsQuery();
  const { setHardwareData, setDocumentsData, invalidateDocuments, invalidateSessions } =
    useWorkspaceQueryActions();

  const cachedHardware = useMemo(
    () => readStorage<HardwareReport | null>(STORAGE_KEYS.HARDWARE, null),
    []
  );
  const hardware = hardwareQuery.data ?? cachedHardware;
  const documents = useMemo(() => documentsQuery.data ?? [], [documentsQuery.data]);

  const [sessions, setSessions] = useState<ChatSession[]>(initialRef.current.sessions);
  const [activeSessionId, setActiveSessionId] = useState<string>(initialRef.current.activeId);
  const [messages, setMessages] = useState<ChatTurn[]>(() =>
    readStorage<ChatTurn[]>(
      `${STORAGE_KEYS.SESSION_PREFIX}${initialRef.current!.activeId}`,
      []
    ).map((m) => ({ ...m, streaming: false }))
  );

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  // Global keyboard shortcuts: Ctrl/Cmd+K focuses KB search; Escape closes top overlay
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const searchEl = document.getElementById("kb-search-input") as HTMLInputElement | null;
        searchEl?.focus();
      } else if (e.key === "Escape") {
        closeTopOverlay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeTopOverlay]);

  // Merge server-synced sessions into local state
  useEffect(() => {
    const remote = sessionsQuery.data;
    if (!remote || remote.length === 0) return;
    setSessions((prev) => {
      const merged = new Map<string, ChatSession>();
      for (const s of remote) merged.set(s.id, s);
      for (const s of prev) {
        if (!merged.has(s.id)) merged.set(s.id, s);
      }
      return Array.from(merged.values()).sort((a, b) =>
        (b.updatedAt || "").localeCompare(a.updatedAt || "")
      );
    });
  }, [sessionsQuery.data]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.SESSIONS, sessions);
  }, [sessions]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.ACTIVE_SESSION, activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    const serializable = messages.filter((m) => !m.streaming);
    writeStorage(`${STORAGE_KEYS.SESSION_PREFIX}${activeSessionId}`, serializable);
    const firstUser = serializable.find((m) => m.role === "user")?.content;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSessionId
          ? {
              ...s,
              title: firstUser ? firstUser.slice(0, 42) + (firstUser.length > 42 ? "…" : "") : s.title,
              messageCount: serializable.length,
              updatedAt: serializable.length > 0 ? new Date().toISOString() : s.updatedAt,
            }
          : s
      )
    );
  }, [messages, activeSessionId]);

  useEffect(() => {
    const readyIds = new Set(documents.filter((d) => d.status === "ready").map((d) => d.doc_id));
    pruneSelectedDocs(readyIds);
  }, [documents, pruneSelectedDocs]);

  useEffect(() => {
    if (hardwareQuery.data) writeStorage(STORAGE_KEYS.HARDWARE, hardwareQuery.data);
  }, [hardwareQuery.data]);

  useEffect(() => {
    let cancelled = false;
    const cached = readStorage<ChatTurn[]>(`${STORAGE_KEYS.SESSION_PREFIX}${activeSessionId}`, []);
    const pending = readStorage<ActiveJobMeta | null>(STORAGE_KEYS.ACTIVE_JOB, null);

    const makeHandlers = (botId: string) => ({
      onStage: (stage: LiveStage) =>
        setMessages((p) => p.map((m) => (m.id === botId ? { ...m, liveStage: stage } : m))),
      onTrace: (step: TraceStep) =>
        setMessages((p) => p.map((m) => (m.id === botId ? { ...m, trace: [...m.trace, step] } : m))),
      onSources: (sources: SourceCitation[]) =>
        setMessages((p) => p.map((m) => (m.id === botId ? { ...m, citations: sources } : m))),
      onToken: (token: string) =>
        setMessages((p) => p.map((m) => (m.id === botId ? { ...m, content: m.content + token } : m))),
      onFollowups: (followups: string[]) =>
        setMessages((p) => p.map((m) => (m.id === botId ? { ...m, followups } : m))),
      onError: (msg: string) => {
        removeStorage(STORAGE_KEYS.ACTIVE_JOB);
        setMessages((p) =>
          p.map((m) =>
            m.id === botId ? { ...m, content: msg, liveStage: null, streaming: false, isError: true } : m
          )
        );
        setStreaming(false);
      },
      onDone: () => {
        removeStorage(STORAGE_KEYS.ACTIVE_JOB);
        setMessages((p) => p.map((m) => (m.id === botId ? { ...m, liveStage: null, streaming: false } : m)));
        setStreaming(false);
        invalidateSessions();
      },
    });

    (async () => {
      const job: ChatJobStatusResponse = await getChatJobStatus(activeSessionId).catch(
        (): ChatJobStatusResponse => ({ exists: false, session_id: activeSessionId })
      );
      if (cancelled) return;

      if (job.exists && job.status === "running") {
        const botId = pending?.sessionId === activeSessionId ? pending.botId : `a-${job.job_id || Date.now()}`;
        setMessages((prev) => {
          const next = [...prev];
          if (pending?.userTurn && !next.some((m) => m.id === pending.userTurn.id)) {
            next.push(pending.userTurn);
          }
          const existingIdx = next.findIndex((m) => m.id === botId);
          const hydratedBot: ChatTurn = {
            id: botId,
            role: "assistant",
            content: job.content || "",
            citations: job.citations || [],
            trace: job.trace || [],
            followups: job.followups || [],
            liveStage: job.live_stage || null,
            streaming: true,
          };
          if (existingIdx >= 0) next[existingIdx] = hydratedBot;
          else next.push(hydratedBot);
          return next;
        });

        const controller = new AbortController();
        abortRef.current = controller;
        setStreaming(true);
        openDiagram(botId);
        await attachChatJobStream(activeSessionId, job.event_count || 0, makeHandlers(botId), controller.signal);
        return;
      }

      if (job.exists && pending?.sessionId === activeSessionId) {
        const botId = pending.botId;
        setMessages((prev) => {
          const next = [...prev];
          if (!next.some((m) => m.id === pending.userTurn.id)) {
            next.push(pending.userTurn);
          }
          const finishedBot: ChatTurn = {
            id: botId,
            role: "assistant",
            content: job.error || job.content || "",
            citations: job.citations || [],
            trace: job.trace || [],
            followups: job.followups || [],
            liveStage: null,
            streaming: false,
            isError: job.status === "error",
          };
          const idx = next.findIndex((m) => m.id === botId);
          if (idx >= 0) next[idx] = finishedBot;
          else next.push(finishedBot);
          return next;
        });
        openDiagram(botId);
        removeStorage(STORAGE_KEYS.ACTIVE_JOB);
        return;
      }

      if (cached.length === 0) {
        const hist: Array<{
          role: "user" | "assistant";
          content: string;
          citations?: SourceCitation[];
          trace?: TraceStep[];
        }> = await fetchChatHistory(activeSessionId).catch(() => []);
        if (!cancelled && hist.length > 0) {
          setMessages((prev) =>
            prev.length > 0
              ? prev
              : hist.map((m, idx) => ({
                  id: `hist-${activeSessionId}-${idx}`,
                  role: m.role,
                  content: m.content,
                  citations: m.citations || [],
                  trace: m.trace || [],
                }))
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, invalidateSessions, openDiagram]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const navigateToSession = useCallback(
    (sessionId: string) => {
      router.replace(`/chat/${encodeURIComponent(sessionId)}`, { scroll: false });
    },
    [router]
  );

  const switchSession = (sessionId: string) => {
    if (streaming) {
      abortRef.current?.abort();
      setStreaming(false);
    }
    setActiveCitation(null);
    setActiveSessionId(sessionId);
    const cached = readStorage<ChatTurn[]>(`${STORAGE_KEYS.SESSION_PREFIX}${sessionId}`, []);
    setMessages(cached.map((m) => ({ ...m, streaming: false })));
    setShowHistory(false);
    navigateToSession(sessionId);
  };

  const handleNewChat = () => {
    if (streaming) {
      abortRef.current?.abort();
      setStreaming(false);
    }
    const newId = createSessionId();
    setSessions((prev) => [
      { id: newId, title: "New Conversation", updatedAt: new Date().toISOString(), messageCount: 0 },
      ...prev,
    ]);
    upsertSessionApi(newId, "New Conversation").catch(() => {});
    setActiveSessionId(newId);
    setMessages([]);
    setActiveCitation(null);
    setShowHistory(false);
    navigateToSession(newId);
  };

  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeStorage(`${STORAGE_KEYS.SESSION_PREFIX}${sessionId}`);
    deleteSessionApi(sessionId).catch(() => {});

    const remaining = sessions.filter((s) => s.id !== sessionId);
    if (remaining.length === 0) {
      const freshId = createSessionId();
      setSessions([{ id: freshId, title: "New Conversation", updatedAt: new Date().toISOString(), messageCount: 0 }]);
      upsertSessionApi(freshId, "New Conversation").catch(() => {});
      setActiveSessionId(freshId);
      setMessages([]);
      setActiveCitation(null);
      navigateToSession(freshId);
      return;
    }

    setSessions(remaining);
    if (activeSessionId === sessionId) switchSession(remaining[0].id);
  };

  const handleClearChat = () => {
    if (streaming) {
      abortRef.current?.abort();
      setStreaming(false);
    }
    setMessages([]);
    setActiveCitation(null);
    writeStorage(`${STORAGE_KEYS.SESSION_PREFIX}${activeSessionId}`, []);
    clearChatHistory(activeSessionId).catch(() => {});
  };

  const handleExportMarkdown = () => {
    if (messages.length === 0) return;
    const activeSess = sessions.find((s) => s.id === activeSessionId);
    const mdLines = [
      `# ${activeSess?.title || "Conversation"}`,
      `_Exported on ${new Date().toLocaleString()}_`,
      "",
    ];
    for (const m of messages) {
      mdLines.push(`## ${m.role === "user" ? "User" : "Assistant"}`, m.content);
      if (m.citations.length > 0) {
        mdLines.push("", `**Sources:** ${m.citations.map((c) => `${c.filename} (p.${c.page_number})`).join(", ")}`);
      }
      mdLines.push("");
    }
    const blob = new Blob([mdLines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${activeSessionId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStopGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    removeStorage(STORAGE_KEYS.ACTIVE_JOB);
    stopChatJob(activeSessionId).catch(() => {});
    setStreaming(false);
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  };

  const handleCopyAnswer = async (turn: ChatTurn) => {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopiedId(turn.id);
      setTimeout(() => setCopiedId((prev) => (prev === turn.id ? null : prev)), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const pickFemaleRoboticVoice = (voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null => {
    const enVoices = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
    const pool = enVoices.length > 0 ? enVoices : voices;
    const maleNames = /\b(david|mark|george|ravi|richard|james|daniel|guy|ryan|andrew|brian|christopher|eric|roger|steffan|male)\b/i;
    const femaleRoboticHints = [
      /microsoft\s+zira/i,
      /google\s+uk\s+english\s+female/i,
      /google\s+us\s+english/i,
      /microsoft\s+hazel/i,
      /microsoft\s+aria/i,
      /microsoft\s+jenny/i,
      /microsoft\s+libby/i,
      /microsoft\s+sonia/i,
      /microsoft\s+neerja/i,
      /microsoft\s+ava/i,
      /samantha|victoria|karen|moira|tessa|serena|veena|female/i,
    ];
    for (const pattern of femaleRoboticHints) {
      const hit = pool.find((v) => pattern.test(v.name));
      if (hit) return hit;
    }
    return pool.find((v) => !maleNames.test(v.name)) || pool[0] || null;
  };

  const handleSpeakAnswer = (turn: ChatTurn) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    if (speakingId === turn.id) {
      synth.cancel();
      setSpeakingId(null);
      return;
    }
    synth.cancel();
    const clean = turn.content.replace(/\[[^\]]+\]/g, "").replace(/[*#`]/g, "");

    const speakWithVoices = (voices: SpeechSynthesisVoice[]) => {
      const utter = new SpeechSynthesisUtterance(clean);
      const selected = pickFemaleRoboticVoice(voices);
      if (selected) utter.voice = selected;
      utter.pitch = 1.24;
      utter.rate = 1.04;
      utter.onend = () => setSpeakingId(null);
      utter.onerror = () => setSpeakingId(null);
      setSpeakingId(turn.id);
      synth.speak(utter);
    };

    const existing = synth.getVoices();
    if (existing.length > 0) {
      speakWithVoices(existing);
    } else {
      let spoken = false;
      const runOnce = (voices: SpeechSynthesisVoice[]) => {
        if (spoken) return;
        spoken = true;
        synth.removeEventListener("voiceschanged", onVoicesChanged);
        speakWithVoices(voices);
      };
      const onVoicesChanged = () => runOnce(synth.getVoices());
      synth.addEventListener("voiceschanged", onVoicesChanged);
      setTimeout(() => runOnce(synth.getVoices()), 300);
    }
  };

  const submitQuery = async (queryText: string) => {
    const query = queryText.trim();
    if (!query || streaming) return;

    if (query.toLowerCase() === "/clear") {
      handleClearChat();
      return;
    }

    const userTurn: ChatTurn = { id: `u-${Date.now()}`, role: "user", content: query, citations: [], trace: [] };
    const botId = `a-${Date.now()}`;

    if (query.toLowerCase() === "/help") {
      setMessages((p) => [
        ...p,
        userTurn,
        {
          id: botId,
          role: "assistant",
          content:
            "### Commands & Shortcuts\n" +
            "- `/clear` — Clear active conversation instantly\n" +
            "- `/help` — Show this quick reference\n" +
            "- `Ctrl/Cmd + K` — Focus Knowledge Base file search\n" +
            "- `Esc` — Close open modals or drawers\n" +
            "- **Document Scope:** Check files in the Knowledge Base to filter answers\n" +
            "- **Query Modes:** Smart Auto (Docs + Chat), Normal Chat, Summarize, Compare, Extract Facts, and Study Quiz in Settings",
          citations: [],
          trace: [],
        },
      ]);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    writeStorage(STORAGE_KEYS.ACTIVE_JOB, {
      sessionId: activeSessionId,
      botId,
      userTurn,
    } satisfies ActiveJobMeta);

    setMessages((p) => [
      ...p,
      userTurn,
      { id: botId, role: "assistant", content: "", citations: [], trace: [], streaming: true },
    ]);
    openDiagram(botId);

    try {
      await startChatJob(activeSessionId, query, {
        docIds: selectedDocIds,
        settings: chatSettings,
      });

      await attachChatJobStream(
        activeSessionId,
        0,
        {
          onStage: (stage) => setMessages((p) => p.map((m) => (m.id === botId ? { ...m, liveStage: stage } : m))),
          onTrace: (step) => setMessages((p) => p.map((m) => (m.id === botId ? { ...m, trace: [...m.trace, step] } : m))),
          onSources: (sources) => setMessages((p) => p.map((m) => (m.id === botId ? { ...m, citations: sources } : m))),
          onToken: (token) => setMessages((p) => p.map((m) => (m.id === botId ? { ...m, content: m.content + token } : m))),
          onFollowups: (followups) => setMessages((p) => p.map((m) => (m.id === botId ? { ...m, followups } : m))),
          onError: (msg) => {
            removeStorage(STORAGE_KEYS.ACTIVE_JOB);
            setMessages((p) => p.map((m) => (m.id === botId ? { ...m, content: msg, liveStage: null, streaming: false, isError: true } : m)));
          },
          onDone: () => {
            removeStorage(STORAGE_KEYS.ACTIVE_JOB);
            setMessages((p) => p.map((m) => (m.id === botId ? { ...m, liveStage: null, streaming: false } : m)));
            invalidateSessions();
          },
        },
        controller.signal
      );
    } catch (err: unknown) {
      removeStorage(STORAGE_KEYS.ACTIVE_JOB);
      setMessages((p) =>
        p.map((m) =>
          m.id === botId
            ? {
                ...m,
                content: err instanceof Error ? err.message : "Failed to start query.",
                streaming: false,
                isError: true,
              }
            : m
        )
      );
    }

    abortRef.current = null;
    setStreaming(false);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || streaming) return;
    setInput("");
    await submitQuery(q);
  };

  const handleRegenerate = async (assistantIndex: number) => {
    if (streaming) return;
    let userQuery = "";
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userQuery = messages[i].content;
        setMessages((prev) => prev.slice(0, i));
        break;
      }
    }
    if (userQuery) await submitQuery(userQuery);
  };

  const handleEditUserMessage = (userIndex: number) => {
    if (streaming) return;
    const text = messages[userIndex].content;
    setMessages((prev) => prev.slice(0, userIndex));
    setInput(text);
  };

  const readyDocsCount = documents.filter((d) => d.status === "ready").length;
  const scopedDocs = documents.filter((d) => selectedDocIds.includes(d.doc_id));

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#141413] text-pampas">
      <ChatHeader
        streaming={streaming}
        readyDocsCount={readyDocsCount}
        sessions={sessions}
        activeSessionId={activeSessionId}
        showHistory={showHistory}
        setShowHistory={setShowHistory}
        onOpenMobileKB={() => setShowMobileKB(true)}
        onNewChat={handleNewChat}
        onSwitchSession={switchSession}
        onDeleteSession={handleDeleteSession}
        onOpenBackup={() => setShowBackupModal(true)}
        hasMessages={messages.length > 0}
        onExportMarkdown={handleExportMarkdown}
        hardware={hardware}
        onOpenHardware={() => setShowHardware(true)}
        onClearChat={handleClearChat}
      />

      <div className="flex flex-1 overflow-hidden">
        <aside className="hidden w-72 shrink-0 border-r border-[#2E2C29] bg-[#1C1B19]/60 md:block">
          <KnowledgeBase
            documents={documents}
            onRefresh={() => invalidateDocuments()}
            onUploaded={(created) => setDocumentsData((prev) => [...created, ...prev])}
            onOptimisticDelete={(docId) =>
              setDocumentsData((prev) => prev.filter((d) => d.doc_id !== docId))
            }
            selectedDocIds={selectedDocIds}
            onToggleSelectDoc={toggleSelectDoc}
            onClearSelection={clearSelectedDocs}
          />
        </aside>

        <AnimatePresence>
          {showMobileKB && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={(e) => e.target === e.currentTarget && setShowMobileKB(false)}
              className="fixed inset-0 z-40 flex bg-black/75 backdrop-blur-sm md:hidden"
            >
              <motion.aside
                initial={{ x: -300 }}
                animate={{ x: 0 }}
                exit={{ x: -300 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="h-full w-80 max-w-[85vw] border-r border-[#2E2C29] bg-[#1C1B19] shadow-2xl"
              >
                <KnowledgeBase
                  documents={documents}
                  onRefresh={() => invalidateDocuments()}
                  onUploaded={(created) => setDocumentsData((prev) => [...created, ...prev])}
                  onOptimisticDelete={(docId) =>
                    setDocumentsData((prev) => prev.filter((d) => d.doc_id !== docId))
                  }
                  selectedDocIds={selectedDocIds}
                  onToggleSelectDoc={toggleSelectDoc}
                  onClearSelection={clearSelectedDocs}
                  onCloseMobile={() => setShowMobileKB(false)}
                />
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>

        <main className="flex flex-1 flex-col overflow-hidden">
          <ChatMessageList
            messages={messages}
            streaming={streaming}
            userTyping={input.trim().length > 0}
            hasReadyDocs={readyDocsCount > 0}
            openDiagrams={openDiagrams}
            copiedId={copiedId}
            speakingId={speakingId}
            scrollRef={scrollRef}
            onToggleDiagram={toggleDiagram}
            onCite={setActiveCitation}
            onSubmitQuery={submitQuery}
            onEditUserMessage={handleEditUserMessage}
            onRegenerate={handleRegenerate}
            onCopyAnswer={handleCopyAnswer}
            onSpeakAnswer={handleSpeakAnswer}
            onCloseHistory={() => showHistory && setShowHistory(false)}
          />

          <ChatComposer
            input={input}
            setInput={setInput}
            streaming={streaming}
            showControls={showControls}
            setShowControls={setShowControls}
            chatSettings={chatSettings}
            setChatSettings={setChatSettings}
            scopedDocs={scopedDocs}
            onToggleSelectDoc={toggleSelectDoc}
            onStopGeneration={handleStopGeneration}
            onSend={handleSend}
          />
        </main>

        <CitationDrawer citation={activeCitation} onClose={() => setActiveCitation(null)} />
      </div>

      <AnimatePresence>
        {showHardware && hardware && (
          <HardwareModal
            report={hardware}
            onClose={() => setShowHardware(false)}
            onUpdated={(updated) => setHardwareData(updated)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showBackupModal && (
          <BackupModal
            onClose={() => setShowBackupModal(false)}
            onRestored={() => {
              invalidateDocuments();
              invalidateSessions();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
