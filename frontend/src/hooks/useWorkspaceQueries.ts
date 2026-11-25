"use client";

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchDocuments, fetchHardware, fetchSessions } from "../api";
import { ChatSession, DocumentItem, HardwareReport } from "../types";

export const QUERY_KEYS = {
  hardware: ["hardware"] as const,
  documents: ["documents"] as const,
  sessions: ["sessions"] as const,
};

export function useHardwareQuery() {
  return useQuery<HardwareReport>({
    queryKey: QUERY_KEYS.hardware,
    queryFn: fetchHardware,
    staleTime: 30_000,
  });
}

export function useDocumentsQuery() {
  return useQuery<DocumentItem[]>({
    queryKey: QUERY_KEYS.documents,
    queryFn: fetchDocuments,
    refetchInterval: (query) =>
      query.state.data?.some((d) => d.status === "processing") ? 1500 : false,
  });
}

export function useSessionsQuery() {
  return useQuery<ChatSession[]>({
    queryKey: QUERY_KEYS.sessions,
    queryFn: fetchSessions,
    staleTime: 10_000,
  });
}

export function useWorkspaceQueryActions() {
  const queryClient = useQueryClient();
  return useMemo(
    () => ({
      setHardwareData: (report: HardwareReport) =>
        queryClient.setQueryData(QUERY_KEYS.hardware, report),
      setDocumentsData: (updater: DocumentItem[] | ((prev: DocumentItem[]) => DocumentItem[])) =>
        queryClient.setQueryData<DocumentItem[]>(QUERY_KEYS.documents, (old = []) =>
          typeof updater === "function" ? updater(old) : updater
        ),
      invalidateDocuments: () =>
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents }),
      invalidateSessions: () =>
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sessions }),
    }),
    [queryClient]
  );
}
