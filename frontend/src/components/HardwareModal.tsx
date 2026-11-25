"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Cpu, Download, HardDrive, CheckCircle2, AlertTriangle,
  X, RefreshCw, Zap, Sparkles, Database, Layers, Trash2,
} from "lucide-react";
import { HardwareReport, ModelInventoryItem } from "../types";
import {
  fetchHardware,
  installModel,
  selectLlm,
  selectTier,
  smartDetectHardware,
  uninstallModel,
} from "../api";
import { AcceleratorIcon, ModelBrandIcon } from "./BrandIcons";

interface Props {
  report: HardwareReport;
  onClose: () => void;
  onUpdated: (report: HardwareReport) => void;
}

interface InstallProgress {
  status: string;
  percent: number | null;
}

export const HardwareModal: React.FC<Props> = ({
  report,
  onClose,
  onUpdated,
}) => {
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [batchInstalling, setBatchInstalling] = useState<"required" | "all" | null>(null);
  const [installMap, setInstallMap] = useState<Record<string, InstallProgress>>({});
  const [uninstallingKey, setUninstallingKey] = useState<string | null>(null);
  const [switchingLlm, setSwitchingLlm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { profile, active_tier, selected_llm, all_tiers, ollama, models = [] } = report;
  const activeLlmId = selected_llm || active_tier.llm_model;

  // Show only the models belonging to the currently selected tier
  const tierModels = models.filter((m) => m.tier_ids.includes(active_tier.tier_id));
  const readyCount = tierModels.filter((m) => m.installed).length;
  const missingTierModels = tierModels.filter((m) => !m.installed);
  const isAnyBusy =
    Object.keys(installMap).length > 0 ||
    batchInstalling !== null ||
    uninstallingKey !== null;

  const handleSelectTier = async (tierId: string) => {
    setBusyTier(tierId);
    setError(null);
    try {
      onUpdated(await selectTier(tierId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to select tier.");
    } finally {
      setBusyTier(null);
    }
  };

  const handleSmartDetect = async () => {
    setDetecting(true);
    setError(null);
    try {
      onUpdated(await smartDetectHardware());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Smart detection failed.");
    } finally {
      setDetecting(false);
    }
  };

  const installSingle = async (item: ModelInventoryItem): Promise<boolean> => {
    const key = `${item.kind}:${item.model_id}`;
    setInstallMap((prev) => ({
      ...prev,
      [key]: {
        status:
          item.kind === "llm"
            ? "Connecting to Ollama…"
            : "Checking HuggingFace cache…",
        percent: 0,
      },
    }));
    try {
      await installModel(item.model_id, item.kind, (status, percent) => {
        setInstallMap((prev) => ({ ...prev, [key]: { status, percent } }));
      });
      return true;
    } catch (err: unknown) {
      setError(`${item.model_id}: ${err instanceof Error ? err.message : "Install failed"}`);
      return false;
    } finally {
      setInstallMap((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleInstallSingle = async (item: ModelInventoryItem) => {
    setError(null);
    await installSingle(item);
    try {
      onUpdated(await fetchHardware());
    } catch {
      /* ignore refresh failure */
    }
  };

  const handleUninstallSingle = async (item: ModelInventoryItem) => {
    const key = `${item.kind}:${item.model_id}`;
    setError(null);
    setUninstallingKey(key);
    try {
      const updated = await uninstallModel(item.model_id, item.kind);
      onUpdated(updated);
    } catch (err: unknown) {
      setError(`${item.model_id}: ${err instanceof Error ? err.message : "Uninstall failed"}`);
    } finally {
      setUninstallingKey(null);
    }
  };

  const handleSelectLlm = async (modelId: string) => {
    setError(null);
    setSwitchingLlm(modelId);
    try {
      onUpdated(await selectLlm(modelId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to switch LLM.");
    } finally {
      setSwitchingLlm(null);
    }
  };

  const handleBatchInstall = async () => {
    if (missingTierModels.length === 0) return;
    setError(null);
    setBatchInstalling("required");
    try {
      for (const item of missingTierModels) {
        if (item.kind === "llm" && !ollama.reachable) continue;
        await installSingle(item);
        try {
          onUpdated(await fetchHardware());
        } catch {
          /* ignore intermediate refresh error */
        }
      }
      if (!ollama.reachable && missingTierModels.some((t) => t.kind === "llm")) {
        setError("HuggingFace models installed, but Ollama is offline for LLM installs.");
      }
    } finally {
      setBatchInstalling(null);
    }
  };

  const renderKindIcon = (kind: ModelInventoryItem["kind"]) => {
    if (kind === "embedding") return <Database className="h-3 w-3 text-sky-400" />;
    if (kind === "reranker") return <Layers className="h-3 w-3 text-amber-400" />;
    return <Zap className="h-3 w-3 text-orange-400" />;
  };

  const renderKindLabel = (kind: ModelInventoryItem["kind"]) => {
    if (kind === "embedding") return "Embedding";
    if (kind === "reranker") return "Reranker";
    return "Generator LLM";
  };

  const renderFitBadge = (fit: ModelInventoryItem["fit"]) => {
    if (fit === "optimal") {
      return (
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          Optimal Fit
        </span>
      );
    }
    if (fit === "compatible") {
      return (
        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          Compatible
        </span>
      );
    }
    return (
      <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-300">
        Heavy
      </span>
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 24 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-orange-500/20">
              <Cpu className="h-5 w-5 text-orange-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Smart Hardware &amp; Model Manager</h2>
              <p className="text-[11px] text-zinc-400">
                Automatic hardware profiling, model installation, and uninstall control
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              disabled={detecting || isAnyBusy}
              onClick={handleSmartDetect}
              className="inline-flex items-center gap-1.5 rounded-xl border border-orange-500/40 bg-orange-500/15 px-3 py-1.5 text-xs font-semibold text-orange-300 transition hover:bg-orange-500/25 disabled:opacity-40"
            >
              {detecting ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {detecting ? "Scanning…" : "Smart Auto-Detect"}
            </motion.button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 transition">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* System hardware summary cards */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: "CPU",
              value: profile.cpu_model,
              sub: `${profile.os_name} · ${profile.cpu_cores_logical} threads`,
              icon: <AcceleratorIcon accelerator={profile.cpu_model} size={15} className="shrink-0" />,
            },
            {
              label: "RAM",
              value: `${profile.total_ram_gb} GB total`,
              sub: `${profile.available_ram_gb} GB free`,
              icon: null,
            },
            {
              label: `Accelerator (${profile.accelerator.toUpperCase()})`,
              value: profile.gpu_name,
              sub: profile.gpu_vram_total_gb > 0
                ? `${profile.gpu_vram_total_gb} GB VRAM`
                : `~${profile.effective_memory_gb} GB budget`,
              icon: <AcceleratorIcon accelerator={`${profile.accelerator} ${profile.gpu_name}`} size={15} className="shrink-0" />,
            },
            {
              label: "Disk Space",
              value: `${profile.disk_free_gb ?? 0} GB free`,
              sub: `${readyCount}/${tierModels.length} tier models installed`,
              icon: null,
            },
          ].map((card) => (
            <div key={card.label} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3.5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">{card.label}</div>
              <div className="mt-1 flex items-center gap-1.5">
                {card.icon}
                <span className="truncate text-sm font-medium text-zinc-100" title={card.value}>{card.value}</span>
              </div>
              <div className="text-xs text-zinc-400">{card.sub}</div>
            </div>
          ))}
        </div>

        {/* Smart Detection Notes */}
        {profile.smart_notes && profile.smart_notes.length > 0 && (
          <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-orange-300 mb-1">
              <Sparkles className="h-3.5 w-3.5" />
              Smart Detection Insights
            </div>
            <ul className="space-y-0.5 text-xs text-zinc-300">
              {profile.smart_notes.map((note, idx) => (
                <li key={idx} className="flex items-center gap-1.5">
                  <span className="h-1 w-1 rounded-full bg-orange-400 shrink-0" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Alerts */}
        {profile.fallback_triggered && profile.fallback_reason && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{profile.fallback_reason}</span>
          </div>
        )}
        {!ollama.reachable && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {ollama.error} — Install Ollama at{" "}
              <a href="https://ollama.com" target="_blank" rel="noreferrer" className="underline">ollama.com</a>{" "}
              and run <code className="font-mono">ollama serve</code> to install local LLMs.
            </span>
          </div>
        )}

        {/* Capability Tiers */}
        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-100">Capability Tiers</h3>
            <span className="text-[11px] text-zinc-400">
              Smart Recommended: <span className="text-orange-400 font-medium">{profile.recommended_tier}</span>
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {all_tiers.map((tier) => {
              const active = tier.tier_id === active_tier.tier_id;
              const rec = tier.tier_id === profile.recommended_tier;
              return (
                <motion.button
                  key={tier.tier_id}
                  whileHover={{ scale: active ? 1 : 1.015 }}
                  whileTap={{ scale: 0.98 }}
                  disabled={busyTier !== null}
                  onClick={() => handleSelectTier(tier.tier_id)}
                  className={`rounded-xl border p-4 text-left transition ${
                    active
                      ? "border-orange-500/70 bg-orange-500/10 ring-1 ring-orange-500/40"
                      : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-zinc-100">{tier.tier_name}</span>
                    <div className="flex items-center gap-1.5">
                      {rec && (
                        <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-medium text-orange-300">
                          Recommended
                        </span>
                      )}
                      {busyTier === tier.tier_id && <RefreshCw className="h-3.5 w-3.5 animate-spin text-orange-400" />}
                    </div>
                  </div>
                  <p className="mt-1.5 text-xs text-zinc-400 leading-relaxed">{tier.rationale}</p>
                  <div className="mt-3 space-y-1.5 font-mono text-[11px] text-zinc-300">
                    <div className="flex items-center gap-1.5">
                      <ModelBrandIcon modelId={tier.llm_model} size={13} className="shrink-0" />
                      <span className="truncate">LLM: {tier.llm_model}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <ModelBrandIcon modelId={tier.embedding_model} size={13} className="shrink-0" />
                      <span className="truncate">Emb: {tier.embedding_model} ({tier.embedding_dim}d)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <ModelBrandIcon modelId={tier.reranker_model} size={13} className="shrink-0" />
                      <span className="truncate">Rerank: {tier.reranker_model}</span>
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center justify-between text-[11px] text-zinc-500">
                    <span className="flex items-center gap-1"><HardDrive className="h-3 w-3" />~{tier.estimated_memory_gb} GB</span>
                    <span>{Object.entries(tier.licenses).map(([, v]) => v).join(" · ")}</span>
                  </div>
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* Selected Tier Models */}
        <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">
                {active_tier.tier_name} Models
              </h3>
              <p className="text-[11px] text-zinc-400">
                {readyCount}/{tierModels.length} installed for the selected tier
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {missingTierModels.length > 0 && (
                <button
                  type="button"
                  disabled={isAnyBusy}
                  onClick={handleBatchInstall}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-[#DE7356] to-[#C15F3C] px-3 py-1.5 text-xs font-semibold text-white shadow-[0_0_16px_rgba(193,95,60,0.3)] transition hover:brightness-110 disabled:opacity-40"
                >
                  {batchInstalling !== null ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  Install Missing ({missingTierModels.length})
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {tierModels.map((item) => {
              const key = `${item.kind}:${item.model_id}`;
              const installState = installMap[key];
              const isUninstalling = uninstallingKey === key;
              const llmBlocked = item.kind === "llm" && !ollama.reachable;

              return (
                <div
                  key={key}
                  className="rounded-xl border border-orange-500/30 bg-zinc-900/70 p-3 transition"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950">
                        <ModelBrandIcon modelId={item.model_id} provider={item.provider} size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-xs font-semibold text-zinc-100 truncate">
                            {item.model_id}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                            {renderKindIcon(item.kind)}
                            {renderKindLabel(item.kind)}
                          </span>
                          {item.required ? (
                            <span className="rounded-full bg-orange-500/20 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                              Required
                            </span>
                          ) : (
                            <span className="rounded-full border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                              Optional
                            </span>
                          )}
                          {item.recommended && (
                            <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300">
                              Smart Pick
                            </span>
                          )}
                          {renderFitBadge(item.fit)}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                          <span>{item.role_desc}</span>
                          <span>·</span>
                          <span>{item.size_label}</span>
                          <span>·</span>
                          <span>{item.license}</span>
                          {item.installed ? (
                            <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                              <CheckCircle2 className="h-3 w-3" />
                              {item.loaded ? "Installed (Warm)" : "Installed"}
                            </span>
                          ) : (
                            <span className="text-zinc-500">Not installed</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {item.kind === "llm" && item.installed && (
                        <button
                          type="button"
                          disabled={isAnyBusy || switchingLlm !== null || activeLlmId === item.model_id}
                          onClick={() => handleSelectLlm(item.model_id)}
                          className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                            activeLlmId === item.model_id
                              ? "border border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                              : "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-orange-500/50 hover:text-orange-300 disabled:opacity-40"
                          }`}
                        >
                          {activeLlmId === item.model_id
                            ? "Active"
                            : switchingLlm === item.model_id
                              ? "Switching…"
                              : "Use Model"}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={Boolean(installState) || isAnyBusy || llmBlocked}
                        onClick={() => handleInstallSingle(item)}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
                          item.installed
                            ? "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-orange-500/50 hover:text-orange-300"
                            : item.required
                              ? "bg-gradient-to-br from-[#DE7356] to-[#C15F3C] text-white hover:brightness-110"
                              : "border border-zinc-700 bg-zinc-800/80 text-zinc-200 hover:border-orange-500/50 hover:text-orange-300"
                        }`}
                      >
                        {installState ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {installState ? "Installing…" : item.installed ? "Reinstall" : "Install"}
                      </button>

                      {item.installed && (
                        <button
                          type="button"
                          disabled={isAnyBusy || llmBlocked}
                          onClick={() => handleUninstallSingle(item)}
                          title={`Uninstall ${item.model_id}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-40"
                        >
                          {isUninstalling ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                          {isUninstalling ? "Uninstalling…" : "Uninstall"}
                        </button>
                      )}
                    </div>
                  </div>

                  <AnimatePresence>
                    {installState && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-2.5 overflow-hidden"
                      >
                        <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                          <span className="truncate">{installState.status}</span>
                          <span className="shrink-0 font-mono">
                            {installState.percent !== null ? `${installState.percent}%` : ""}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                          <motion.div
                            className="h-full rounded-full bg-gradient-to-r from-[#C15F3C] to-[#DE7356]"
                            initial={{ width: 0 }}
                            animate={{ width: `${installState.percent ?? 15}%` }}
                            transition={{ duration: 0.35 }}
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </div>

        {error && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 rounded-lg bg-rose-500/10 p-2.5 text-xs text-rose-400">
            {error}
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
};
