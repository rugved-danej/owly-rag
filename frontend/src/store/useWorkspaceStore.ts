"use client";

import { create } from "zustand";
import { ChatSettings, SourceCitation } from "../types";

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  temperature: 0.1,
  top_k: 5,
  system_persona: "default",
  query_mode: "qa",
};

function loadInitialSettings(): ChatSettings {
  if (typeof window === "undefined") return DEFAULT_CHAT_SETTINGS;
  try {
    const raw = localStorage.getItem("rag_chat_settings_v1");
    return raw ? { ...DEFAULT_CHAT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_CHAT_SETTINGS;
  } catch {
    return DEFAULT_CHAT_SETTINGS;
  }
}

function loadInitialDiagrams(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem("rag_open_diagrams_v1");
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

interface WorkspaceState {
  showHardware: boolean;
  showBackupModal: boolean;
  showMobileKB: boolean;
  showHistory: boolean;
  showControls: boolean;
  activeCitation: SourceCitation | null;
  selectedDocIds: string[];
  chatSettings: ChatSettings;
  openDiagrams: Record<string, boolean>;

  setShowHardware: (v: boolean) => void;
  setShowBackupModal: (v: boolean) => void;
  setShowMobileKB: (v: boolean) => void;
  setShowHistory: (v: boolean | ((prev: boolean) => boolean)) => void;
  setShowControls: (v: boolean | ((prev: boolean) => boolean)) => void;
  setActiveCitation: (c: SourceCitation | null) => void;
  toggleSelectDoc: (docId: string) => void;
  pruneSelectedDocs: (readyDocIds: Set<string>) => void;
  clearSelectedDocs: () => void;
  setChatSettings: (updater: ChatSettings | ((prev: ChatSettings) => ChatSettings)) => void;
  toggleDiagram: (turnId: string) => void;
  openDiagram: (turnId: string) => void;
  closeTopOverlay: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  showHardware: false,
  showBackupModal: false,
  showMobileKB: false,
  showHistory: false,
  showControls: false,
  activeCitation: null,
  selectedDocIds: [],
  chatSettings: loadInitialSettings(),
  openDiagrams: loadInitialDiagrams(),

  setShowHardware: (v) => set({ showHardware: v }),
  setShowBackupModal: (v) => set({ showBackupModal: v }),
  setShowMobileKB: (v) => set({ showMobileKB: v }),
  setShowHistory: (v) =>
    set((s) => ({ showHistory: typeof v === "function" ? v(s.showHistory) : v })),
  setShowControls: (v) =>
    set((s) => ({ showControls: typeof v === "function" ? v(s.showControls) : v })),
  setActiveCitation: (c) => set({ activeCitation: c }),
  toggleSelectDoc: (docId) =>
    set((s) => ({
      selectedDocIds: s.selectedDocIds.includes(docId)
        ? s.selectedDocIds.filter((id) => id !== docId)
        : [...s.selectedDocIds, docId],
    })),
  pruneSelectedDocs: (readyDocIds) =>
    set((s) => {
      const next = s.selectedDocIds.filter((id) => readyDocIds.has(id));
      return next.length === s.selectedDocIds.length ? s : { selectedDocIds: next };
    }),
  clearSelectedDocs: () => set({ selectedDocIds: [] }),
  setChatSettings: (updater) =>
    set((s) => {
      const next = typeof updater === "function" ? updater(s.chatSettings) : updater;
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("rag_chat_settings_v1", JSON.stringify(next));
        } catch {
          /* ignore */
        }
      }
      return { chatSettings: next };
    }),
  toggleDiagram: (turnId) =>
    set((s) => {
      const next = { ...s.openDiagrams, [turnId]: !s.openDiagrams[turnId] };
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("rag_open_diagrams_v1", JSON.stringify(next));
        } catch {
          /* ignore */
        }
      }
      return { openDiagrams: next };
    }),
  openDiagram: (turnId) =>
    set((s) => {
      if (s.openDiagrams[turnId]) return s;
      const next = { ...s.openDiagrams, [turnId]: true };
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("rag_open_diagrams_v1", JSON.stringify(next));
        } catch {
          /* ignore */
        }
      }
      return { openDiagrams: next };
    }),
  closeTopOverlay: () =>
    set((s) => {
      if (s.showHardware) return { showHardware: false };
      if (s.showBackupModal) return { showBackupModal: false };
      if (s.activeCitation) return { activeCitation: null };
      if (s.showMobileKB) return { showMobileKB: false };
      if (s.showHistory) return { showHistory: false };
      if (s.showControls) return { showControls: false };
      return s;
    }),
}));
