import { useState, useEffect, useMemo } from "react";
import { fetchJson } from "../hooks/use-api";
import { useServiceStore } from "../store/service";
import { useServicesConfig } from "../hooks/use-services-config";
import { Eye, EyeOff, Loader2, ArrowLeft } from "lucide-react";
import { ServiceConfigSourceCard } from "../components/ServiceConfigSourceCard";
import {
  probeServiceForDetail,
  rehydrateServiceConnectionStatus,
  saveServiceConfigWithValidation,
  testServiceModelForDetail,
  type ServiceDetailConnectionStatus as ConnectionStatus,
  type ServiceDetailDetectedConfig as DetectedConfig,
  type ServiceDetailModelInfo as ModelInfo,
} from "./service-detail-state";

interface Nav {
  toServices: () => void;
}

interface ModelHealth {
  readonly state: "idle" | "testing" | "ok" | "fail";
  readonly elapsedMs?: number;
  readonly lastTestAt?: string;
  readonly error?: string;
}

interface EditableModel {
  readonly id: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly source?: "manual" | "detected";
}

type UnifiedModelSource = "manual" | "detected" | "available" | "both";

interface UnifiedModel {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly source: UnifiedModelSource;
  readonly available: boolean;
}

function DetailSkeleton() {
  return (
    <div className="max-w-xl mx-auto space-y-6 animate-pulse">
      <div className="h-4 w-16 bg-muted rounded" />
      <div className="h-7 w-40 bg-muted rounded" />
      <div className="space-y-2"><div className="h-3 w-16 bg-muted/60 rounded" /><div className="h-10 w-full bg-muted/40 rounded-lg" /></div>
      <div className="h-9 w-24 bg-muted/40 rounded-lg" />
    </div>
  );
}

export function ServiceDetailPage({ serviceId, nav }: { serviceId: string; nav: Nav }) {
  const services = useServiceStore((s) => s.services);
  const loading = useServiceStore((s) => s.servicesLoading);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const refreshServices = useServiceStore((s) => s.refreshServices);
  const setStoreModels = useServiceStore((s) => s.setModels);
  const clearStoreModels = useServiceStore((s) => s.clearModels);
  const { data: servicesConfig } = useServicesConfig();

  useEffect(() => { void fetchServices(); }, [fetchServices]);

  const svc = services.find((s) => s.service === serviceId);
  const isCustom = serviceId === "custom" || serviceId.startsWith("custom:");
  const persistedCustomName = serviceId.startsWith("custom:")
    ? decodeURIComponent(serviceId.slice("custom:".length))
    : "";

  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [customName, setCustomName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [temperature, setTemperature] = useState("0.7");
  const [maxTokens, setMaxTokens] = useState("4096");
  const [apiFormat, setApiFormat] = useState<"chat" | "responses">("chat");
  const [stream, setStream] = useState(true);
  const [detectedModel, setDetectedModel] = useState<string>("");
  const [detectedConfig, setDetectedConfig] = useState<DetectedConfig | null>(null);
  const [modelHealthById, setModelHealthById] = useState<Record<string, ModelHealth>>({});
  const [batchTesting, setBatchTesting] = useState(false);
  const [sortByLatency, setSortByLatency] = useState(false);
  const [modelMode, setModelMode] = useState<"auto" | "manual" | "hybrid">("hybrid");
  const [preferredModel, setPreferredModel] = useState("");
  const [editableModels, setEditableModels] = useState<EditableModel[]>([]);
  const [selectedUnifiedModelIds, setSelectedUnifiedModelIds] = useState<string[]>([]);
  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");

  const [status, setStatus] = useState<ConnectionStatus>({ state: "idle" });

  useEffect(() => {
    const matched = (servicesConfig?.services ?? []).find((entry) => {
      if (typeof entry.service !== "string") return false;
      if (serviceId.startsWith("custom:")) {
        return entry.service === "custom" && `custom:${String(entry.name ?? "")}` === serviceId;
      }
      return entry.service === serviceId;
    });
    if (!matched) return;
    if (isCustom) {
      setCustomName(String(matched.name ?? persistedCustomName));
      setBaseUrl(String(matched.baseUrl ?? ""));
    }
    if (typeof matched.temperature === "number") setTemperature(String(matched.temperature));
    if (typeof matched.maxTokens === "number") setMaxTokens(String(matched.maxTokens));
    if (matched.apiFormat === "chat" || matched.apiFormat === "responses") setApiFormat(matched.apiFormat);
    if (typeof matched.stream === "boolean") setStream(matched.stream);
    if (matched.modelMode === "auto" || matched.modelMode === "manual" || matched.modelMode === "hybrid") {
      setModelMode(matched.modelMode);
    }
    if (typeof matched.preferredModel === "string") {
      setPreferredModel(matched.preferredModel);
    } else if (typeof servicesConfig?.defaultModel === "string") {
      setPreferredModel(servicesConfig.defaultModel);
    }
    if (Array.isArray(matched.models)) {
      const normalized = matched.models
        .filter((model): model is Record<string, unknown> => Boolean(model) && typeof model === "object")
        .map((model) => ({
          id: typeof model.id === "string" ? model.id.trim() : "",
          ...(typeof model.name === "string" && model.name.trim().length > 0 ? { name: model.name.trim() } : {}),
          ...(typeof model.enabled === "boolean" ? { enabled: model.enabled } : { enabled: true }),
          ...(model.source === "manual" || model.source === "detected"
            ? { source: model.source as "manual" | "detected" }
            : { source: "manual" as const }),
        }))
        .filter((model) => model.id.length > 0);
      setEditableModels(normalized);
    }
  }, [isCustom, persistedCustomName, serviceId, servicesConfig]);

  const resolvedCustomName = persistedCustomName || customName.trim() || "Custom";
  const effectiveServiceId = isCustom ? `custom:${resolvedCustomName}` : serviceId;
  const label = isCustom ? (customName || persistedCustomName || "自定义服务") : (svc?.label ?? serviceId);

  const fetchEffectiveModels = async (args?: { readonly apiKey?: string; readonly refresh?: boolean }) => {
    const query = [
      args?.refresh ? "refresh=1" : "",
      args?.apiKey?.trim() ? `apiKey=${encodeURIComponent(args.apiKey.trim())}` : "",
    ].filter(Boolean).join("&");
    const path = `/services/${encodeURIComponent(effectiveServiceId)}/models${query ? `?${query}` : ""}`;
    const result = await fetchJson<{ models?: ModelInfo[] }>(path);
    return result.models ?? [];
  };

  useEffect(() => {
    let cancelled = false;
    if (svc?.connected) setStatus({ state: "testing" });
    void rehydrateServiceConnectionStatus({
      effectiveServiceId,
      shouldVerify: Boolean(svc?.connected),
      isCustom,
      baseUrl,
      apiFormat,
      stream,
    })
      .then((result) => {
        if (cancelled) return;
        setApiKey(result.apiKey);
        setDetectedModel(result.detectedModel);
        setDetectedConfig(result.detectedConfig);
        if (result.status.state === "connected") {
          const connectedStatus = result.status;
          void fetchEffectiveModels({ apiKey: result.apiKey })
            .then((models) => {
              if (cancelled) return;
              setStatus({ state: "connected", models });
              setStoreModels(effectiveServiceId, models);
            })
            .catch(() => {
              if (cancelled) return;
              setStatus(connectedStatus);
              setStoreModels(effectiveServiceId, connectedStatus.models);
            });
        } else {
          setStatus(result.status);
          clearStoreModels(effectiveServiceId);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setStatus({ state: "idle" });
      });
    return () => { cancelled = true; };
  }, [
    apiFormat,
    baseUrl,
    clearStoreModels,
    effectiveServiceId,
    isCustom,
    setStoreModels,
    stream,
    svc?.connected,
  ]);

  const isConnected = status.state === "connected";
  const availableModels = status.state === "connected" ? status.models : [];
  const availableModelNameById = useMemo(
    () => new Map(availableModels.map((model) => [model.id, model.name ?? model.id] as const)),
    [availableModels],
  );
  const unifiedModels = useMemo<UnifiedModel[]>(() => {
    const editableMap = new Map(editableModels.map((model) => [model.id, model] as const));
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const model of editableModels) {
      // 隐藏“自动来源且已禁用”的模型：它们通常来自删除动作，避免看起来“删不掉”。
      if (model.source === "detected" && model.enabled === false) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      ids.push(model.id);
    }
    for (const model of availableModels) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      ids.push(model.id);
    }

    return ids.map((id) => {
      const editable = editableMap.get(id);
      const available = availableModelNameById.get(id);
      const availableFlag = Boolean(available);
      let source: UnifiedModelSource;
      if (editable?.source === "manual" && availableFlag) source = "both";
      else if (editable?.source === "manual") source = "manual";
      else if (editable?.source === "detected") source = editable.enabled === false && availableFlag ? "available" : "detected";
      else if (availableFlag) source = "available";
      else source = "manual";
      return {
        id,
        name: editable?.name ?? available ?? id,
        enabled: editable ? editable.enabled !== false : true,
        source,
        available: availableFlag,
      };
    });
  }, [editableModels, availableModelNameById, availableModels]);
  const visibleUnifiedModels = useMemo(() => {
    if (!sortByLatency) return unifiedModels;
    return [...unifiedModels].sort((a, b) => {
      const aLatency = modelHealthById[a.id]?.state === "ok" ? (modelHealthById[a.id]?.elapsedMs ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const bLatency = modelHealthById[b.id]?.state === "ok" ? (modelHealthById[b.id]?.elapsedMs ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (aLatency === bLatency) return a.id.localeCompare(b.id);
      return aLatency - bLatency;
    });
  }, [modelHealthById, sortByLatency, unifiedModels]);
  const isBusy = status.state === "testing" || status.state === "saving";
  const allUnifiedSelected = unifiedModels.length > 0 && selectedUnifiedModelIds.length === unifiedModels.length;

  useEffect(() => {
    const currentIds = new Set(unifiedModels.map((model) => model.id));
    setSelectedUnifiedModelIds((prev) => prev.filter((id) => currentIds.has(id)));
  }, [unifiedModels]);

  useEffect(() => {
    const currentIds = new Set(unifiedModels.map((model) => model.id));
    setModelHealthById((prev) => {
      const next: Record<string, ModelHealth> = {};
      for (const [id, health] of Object.entries(prev)) {
        if (currentIds.has(id)) next[id] = health;
      }
      return next;
    });
  }, [unifiedModels]);

  const upsertEditableModel = (modelId: string, patch: Partial<EditableModel>): void => {
    const fallbackName = availableModelNameById.get(modelId);
    setEditableModels((prev) => {
      const next = [...prev];
      const index = next.findIndex((model) => model.id === modelId);
      if (index >= 0) {
        next[index] = {
          ...next[index]!,
          ...patch,
          ...(next[index]!.name || fallbackName ? { name: patch.name ?? next[index]!.name ?? fallbackName } : {}),
        };
      } else {
        next.push({
          id: modelId,
          ...(fallbackName ? { name: fallbackName } : {}),
          source: "detected",
          enabled: true,
          ...patch,
        });
      }
      return next;
    });
  };

  const applySmartDelete = (targetIds: readonly string[]) => {
    if (targetIds.length === 0) return;
    const targetSet = new Set(targetIds);
    setEditableModels((prev) => {
      const next = [...prev];
      for (const targetId of targetIds) {
        const index = next.findIndex((model) => model.id === targetId);
        const isAvailableNow = availableModelNameById.has(targetId);
        if (index >= 0) {
          const existing = next[index]!;
          if (existing.source === "manual") {
            if (isAvailableNow) {
              next[index] = {
                id: targetId,
                name: existing.name ?? availableModelNameById.get(targetId) ?? targetId,
                source: "detected",
                enabled: false,
              };
            } else {
              next.splice(index, 1);
            }
          } else {
            next[index] = {
              ...existing,
              source: "detected",
              enabled: false,
            };
          }
          continue;
        }

        next.push({
          id: targetId,
          ...(availableModelNameById.get(targetId) ? { name: availableModelNameById.get(targetId) } : {}),
          source: "detected",
          enabled: false,
        });
      }
      return next;
    });

    if (targetSet.has(preferredModel)) setPreferredModel("");
    setSelectedUnifiedModelIds((prev) => prev.filter((id) => !targetSet.has(id)));
  };

  const handleTest = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setStatus({ state: "error", message: "请先输入 API Key" });
      return;
    }
    if (isCustom && !baseUrl.trim()) {
      setStatus({ state: "error", message: "请先填写 Base URL" });
      return;
    }
    setApiKey(trimmedKey);
    setStatus({ state: "testing" });
    try {
      const result = await probeServiceForDetail(effectiveServiceId, {
        apiKey: trimmedKey,
        apiFormat,
        stream,
        ...(isCustom ? { baseUrl: baseUrl.trim() } : {}),
      });
      if (result.ok) {
        const models = await fetchEffectiveModels({ apiKey: trimmedKey, refresh: true }).catch(() => result.models ?? []);
        if (result.detected?.apiFormat) setApiFormat(result.detected.apiFormat);
        if (typeof result.detected?.stream === "boolean") setStream(result.detected.stream);
        if (isCustom && result.detected?.baseUrl) setBaseUrl(result.detected.baseUrl);
        setDetectedModel(result.selectedModel ?? "");
        setDetectedConfig(result.detected ?? null);
        setStatus({ state: "connected", models });
        setStoreModels(effectiveServiceId, models);
      } else {
        setStatus({ state: "error", message: result.error ?? "连接失败" });
        clearStoreModels(effectiveServiceId);
      }
    } catch (e) {
      setStatus({ state: "error", message: e instanceof Error ? e.message : "连接失败" });
    }
  };

  const handleSave = async () => {
    const trimmedKey = apiKey.trim();
    setApiKey(trimmedKey);
    if (isCustom && !baseUrl.trim()) {
      setStatus({ state: "error", message: "请先填写 Base URL" });
      return;
    }
    setStatus({ state: "saving" });
    try {
      const result = await saveServiceConfigWithValidation({
        effectiveServiceId,
        serviceId,
        isCustom,
        resolvedCustomName,
        apiKey: trimmedKey,
        baseUrl,
        apiFormat,
        stream,
        modelMode,
        preferredModel,
        models: editableModels,
        temperature,
        maxTokens,
        detectedModel,
      });
      if (result.status.state === "connected") {
        const connectedStatus = result.status;
        const models = await fetchEffectiveModels({ apiKey: trimmedKey, refresh: true }).catch(() => connectedStatus.models);
        if (result.detectedConfig?.apiFormat) setApiFormat(result.detectedConfig.apiFormat);
        if (typeof result.detectedConfig?.stream === "boolean") setStream(result.detectedConfig.stream);
        if (isCustom && result.detectedConfig?.baseUrl) setBaseUrl(result.detectedConfig.baseUrl);
        setDetectedModel(result.detectedModel);
        setDetectedConfig(result.detectedConfig);
        setStoreModels(effectiveServiceId, models);
        setStatus({ state: "connected", models });
      } else {
        clearStoreModels(effectiveServiceId);
        setDetectedModel("");
        setDetectedConfig(null);
        setStatus(result.status);
      }
      await refreshServices();
      nav.toServices();
    } catch (e) {
      setStatus({ state: "error", message: e instanceof Error ? e.message : "保存失败" });
    }
  };

  const runSingleModelTest = async (modelId: string): Promise<void> => {
    const trimmedKey = apiKey.trim();
    if (isCustom && !baseUrl.trim()) {
      setStatus({ state: "error", message: "请先填写 Base URL" });
      throw new Error("请先填写 Base URL");
    }
    if (!trimmedKey && !svc?.connected) {
      setStatus({ state: "error", message: "请先输入 API Key" });
      throw new Error("请先输入 API Key");
    }
    setModelHealthById((prev) => ({ ...prev, [modelId]: { state: "testing" } }));
    try {
      const result = await testServiceModelForDetail({
        serviceId: effectiveServiceId,
        modelId,
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
        ...(isCustom ? { baseUrl } : {}),
        apiFormat,
        stream,
      });
      setModelHealthById((prev) => ({
        ...prev,
        [modelId]: {
          state: result.ok ? "ok" : "fail",
          elapsedMs: result.elapsedMs,
          lastTestAt: new Date().toISOString(),
          ...(result.error ? { error: result.error } : {}),
        },
      }));
    } catch (e) {
      setModelHealthById((prev) => ({
        ...prev,
        [modelId]: {
          state: "fail",
          lastTestAt: new Date().toISOString(),
          error: e instanceof Error ? e.message : "连接失败",
        },
      }));
    }
  };

  const handleBatchModelTest = async () => {
    const testableModelIds = unifiedModels.filter((model) => model.enabled).map((model) => model.id);
    if (testableModelIds.length === 0 || batchTesting || isBusy) return;
    const trimmedKey = apiKey.trim();
    if (isCustom && !baseUrl.trim()) {
      setStatus({ state: "error", message: "请先填写 Base URL" });
      return;
    }
    if (!trimmedKey && !svc?.connected) {
      setStatus({ state: "error", message: "请先输入 API Key" });
      return;
    }
    setBatchTesting(true);
    try {
      let cursor = 0;
      const concurrency = Math.min(3, testableModelIds.length);
      const worker = async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          const modelId = testableModelIds[index];
          if (!modelId) return;
          try {
            await runSingleModelTest(modelId);
          } catch {
            // continue
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
      setBatchTesting(false);
    }
  };

  const handleGenerateModels = async () => {
    const trimmedKey = apiKey.trim();
    if (isCustom && !baseUrl.trim()) {
      setStatus({ state: "error", message: "请先填写 Base URL" });
      return;
    }
    if (!trimmedKey && !svc?.connected) {
      setStatus({ state: "error", message: "请先输入 API Key" });
      return;
    }
    try {
      const result = await fetchJson<{ models?: ModelInfo[] }>(
        `/services/${encodeURIComponent(effectiveServiceId)}/models?refresh=1&source=auto${trimmedKey ? `&apiKey=${encodeURIComponent(trimmedKey)}` : ""}`,
      );
      const generated = (result.models ?? []).map((model) => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        source: "detected" as const,
        enabled: true,
      }));
      setEditableModels((prev) => {
        const next = [...prev];
        for (const model of generated) {
          const index = next.findIndex((entry) => entry.id === model.id);
          if (index >= 0) {
            const existing = next[index]!;
            if (existing.source === "manual") continue;
            next[index] = {
              ...existing,
              source: "detected",
              enabled: true,
              name: model.name ?? existing.name,
            };
            continue;
          }
          next.push(model);
        }
        return next;
      });
      if (!preferredModel && generated.length > 0) setPreferredModel(generated[0]!.id);
    } catch (e) {
      setStatus({ state: "error", message: e instanceof Error ? e.message : "自动生成失败" });
    }
  };

  const handleAddModel = () => {
    const id = newModelId.trim();
    const name = newModelName.trim();
    if (!id) return;
    setEditableModels((prev) => {
      const next = [...prev];
      const index = next.findIndex((model) => model.id === id);
      if (index >= 0) {
        next[index] = {
          ...next[index]!,
          source: "manual",
          enabled: true,
          ...(name ? { name } : {}),
        };
      } else {
        next.push({
          id,
          source: "manual",
          enabled: true,
          ...(name ? { name } : {}),
        });
      }
      return next;
    });
    if (!preferredModel) setPreferredModel(id);
    setNewModelId("");
    setNewModelName("");
  };

  const handleToggleModelEnabled = (modelId: string, enabled: boolean) => {
    upsertEditableModel(modelId, { enabled });
  };

  const handleToggleUnifiedSelection = (modelId: string, checked: boolean) => {
    setSelectedUnifiedModelIds((prev) => {
      if (checked) {
        if (prev.includes(modelId)) return prev;
        return [...prev, modelId];
      }
      return prev.filter((id) => id !== modelId);
    });
  };

  const handleBatchSetEnabled = (enabled: boolean) => {
    if (selectedUnifiedModelIds.length === 0) return;
    const targetIds = selectedUnifiedModelIds;
    setEditableModels((prev) => {
      const next = [...prev];
      for (const modelId of targetIds) {
        const index = next.findIndex((model) => model.id === modelId);
        if (index >= 0) {
          next[index] = {
            ...next[index]!,
            enabled,
          };
        } else {
          next.push({
            id: modelId,
            ...(availableModelNameById.get(modelId) ? { name: availableModelNameById.get(modelId) } : {}),
            source: "detected",
            enabled,
          });
        }
      }
      return next;
    });
    if (!enabled && targetIds.includes(preferredModel)) setPreferredModel("");
  };

  if (loading) return <DetailSkeleton />;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <button
        onClick={nav.toServices}
        className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-card/60 px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary/50 transition-colors"
      >
        <ArrowLeft size={14} />
        返回服务商管理
      </button>

      <div className="flex items-center gap-3">
        <h1 className="font-serif text-2xl">{label}</h1>
        {isConnected && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 font-medium">
            已连接
          </span>
        )}
      </div>

      <ServiceConfigSourceCard onChange={() => { void refreshServices(); }} />

      <div className="space-y-5">
        {isCustom && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="服务名称">
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="例如：本地 Ollama"
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Base URL">
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
              />
            </Field>
          </div>
        )}

        <Field label="API Key">
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 pr-10 text-sm font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>

        <div className="space-y-3 rounded-lg border border-border/40 bg-card/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-muted-foreground/80">模型总览</div>
            <button
              onClick={() => { void handleGenerateModels(); }}
              className="px-2.5 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors"
            >
              自动生成
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="模型模式">
              <select
                value={modelMode}
                onChange={(e) => setModelMode(e.target.value as "auto" | "manual" | "hybrid")}
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
              >
                <option value="hybrid">hybrid（手工+自动）</option>
                <option value="manual">manual（仅手工）</option>
                <option value="auto">auto（仅自动）</option>
              </select>
            </Field>
            <Field label="默认模型">
              <input
                type="text"
                value={preferredModel}
                onChange={(e) => setPreferredModel(e.target.value)}
                placeholder="例如 gpt-5.4"
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
              />
            </Field>
          </div>

          <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <input
              type="text"
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder="模型ID"
              className="rounded-lg border border-border/60 bg-background px-3 py-2 text-sm font-mono"
            />
            <input
              type="text"
              value={newModelName}
              onChange={(e) => setNewModelName(e.target.value)}
              placeholder="显示名称（可选）"
              className="rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
            />
            <button
              onClick={handleAddModel}
              className="px-3 py-2 text-xs rounded-lg border border-border/60 hover:bg-secondary/50 transition-colors"
            >
              新增
            </button>
          </div>

          {unifiedModels.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setSelectedUnifiedModelIds(unifiedModels.map((model) => model.id))}
                  className="px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors"
                >
                  全选
                </button>
                <button
                  onClick={() => setSelectedUnifiedModelIds([])}
                  className="px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors"
                >
                  全不选
                </button>
                <button
                  onClick={() => applySmartDelete(selectedUnifiedModelIds)}
                  disabled={selectedUnifiedModelIds.length === 0}
                  className="px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors disabled:opacity-50"
                >
                  批量删除（{selectedUnifiedModelIds.length}）
                </button>
                <button
                  onClick={() => handleBatchSetEnabled(true)}
                  disabled={selectedUnifiedModelIds.length === 0}
                  className="px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors disabled:opacity-50"
                >
                  批量启用
                </button>
                <button
                  onClick={() => handleBatchSetEnabled(false)}
                  disabled={selectedUnifiedModelIds.length === 0}
                  className="px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors disabled:opacity-50"
                >
                  批量停用
                </button>
                <button
                  onClick={() => setSortByLatency((prev) => !prev)}
                  className="px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors"
                >
                  {sortByLatency ? "原顺序" : "按耗时排序"}
                </button>
                <button
                  onClick={() => { void handleBatchModelTest(); }}
                  disabled={isBusy || batchTesting}
                  className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors disabled:opacity-50"
                >
                  {batchTesting && <Loader2 size={11} className="animate-spin" />}
                  测试全部
                </button>
                <span className="text-[11px] text-muted-foreground/70">
                  {allUnifiedSelected ? "已全选" : `已选 ${selectedUnifiedModelIds.length}/${unifiedModels.length}`}
                </span>
              </div>

              {visibleUnifiedModels.map((model) => (
                <div
                  key={model.id}
                  className="rounded-md border border-border/40 bg-background/40 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="block truncate text-xs font-medium">{model.name}</span>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="truncate text-[11px] text-muted-foreground/70">{model.id}{preferredModel === model.id ? " · 默认" : ""}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${sourceBadgeClass(model.source)}`}>
                          {sourceBadgeLabel(model.source)}
                        </span>
                        {!model.available && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-border/50 text-muted-foreground/70">
                            未在当前可用列表
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80">
                        <input
                          type="checkbox"
                          checked={selectedUnifiedModelIds.includes(model.id)}
                          onChange={(e) => handleToggleUnifiedSelection(model.id, e.target.checked)}
                        />
                        选中
                      </label>
                      <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80">
                        <input
                          type="checkbox"
                          checked={model.enabled}
                          onChange={(e) => handleToggleModelEnabled(model.id, e.target.checked)}
                        />
                        启用
                      </label>
                      <button
                        onClick={() => setPreferredModel(model.id)}
                        className="px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors"
                      >
                        设默认
                      </button>
                      <button
                        onClick={() => { void runSingleModelTest(model.id); }}
                        disabled={isBusy || batchTesting || modelHealthById[model.id]?.state === "testing" || !model.enabled}
                        className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors disabled:opacity-50"
                      >
                        {modelHealthById[model.id]?.state === "testing" && <Loader2 size={11} className="animate-spin" />}
                        测试
                      </button>
                      <button
                        onClick={() => applySmartDelete([model.id])}
                        className="px-2 py-1 text-[11px] rounded-md border border-border/60 hover:bg-secondary/50 transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${modelHealthStateClass(modelHealthById[model.id])}`}>
                      {modelHealthById[model.id]?.state === "testing" && <Loader2 size={10} className="animate-spin" />}
                      {modelHealthStateLabel(modelHealthById[model.id])}
                    </span>
                    {typeof modelHealthById[model.id]?.elapsedMs === "number" && modelHealthById[model.id]?.state !== "testing" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-border/50 text-muted-foreground/80">
                        {modelHealthById[model.id]!.elapsedMs}ms
                      </span>
                    )}
                    {modelHealthById[model.id]?.state === "fail" && modelHealthById[model.id]?.error && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded border border-destructive/30 text-destructive/80 max-w-[220px] truncate"
                        title={modelHealthById[model.id]?.error}
                      >
                        {modelHealthById[model.id]?.error}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleTest}
            disabled={isBusy}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs rounded-lg border border-border/60 hover:bg-secondary/50 transition-colors disabled:opacity-50"
          >
            {status.state === "testing" && <Loader2 size={12} className="animate-spin" />}
            测试连接
          </button>
          <button
            onClick={handleSave}
            disabled={isBusy}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {status.state === "saving" && <Loader2 size={12} className="animate-spin" />}
            保存
          </button>
          {status.state === "connected" && (
            <span className="text-xs text-emerald-500">
              连接成功，{availableModels.length} 个模型
              {detectedModel ? `，已自动匹配 ${detectedModel}${detectedConfig ? ` / ${detectedConfig.apiFormat === "responses" ? "Responses" : "Chat"} / ${detectedConfig.stream ? "流式" : "非流式"}` : ""}` : ""}
            </span>
          )}
          {status.state === "error" && (
            <span className="text-xs text-destructive">{status.message}</span>
          )}
          {status.state === "saved" && (
            <span className="text-xs text-emerald-500">已保存</span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="协议类型">
            <select
              value={apiFormat}
              onChange={(e) => setApiFormat(e.target.value as "chat" | "responses")}
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
            >
              <option value="chat">Chat / Completions</option>
              <option value="responses">Responses</option>
            </select>
          </Field>

          <Field label="流式响应">
            <label className="flex h-10 items-center gap-2 rounded-lg border border-border/60 bg-background px-3 text-sm">
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
              />
              <span>{stream ? "开启" : "关闭"}</span>
            </label>
          </Field>
        </div>

        <details className="group pt-2 border-t border-border/20">
          <summary className="text-xs text-muted-foreground/60 cursor-pointer select-none hover:text-muted-foreground transition-colors py-2">
            高级参数
          </summary>
          <div className="space-y-4 pt-2">
            <Field label="temperature">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  className="flex-1 accent-primary h-1"
                />
                <input
                  type="number"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  min="0"
                  max="2"
                  step="0.05"
                  className="w-16 rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-right font-mono"
                />
              </div>
            </Field>
            <Field label="maxTokens">
              <input
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                min="256"
                max="200000"
                step="256"
                className="w-full rounded-md border border-border/60 bg-background px-3 py-1.5 text-xs font-mono"
              />
            </Field>
          </div>
        </details>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs text-muted-foreground/70 font-medium">{label}</label>
      {children}
    </div>
  );
}

function modelHealthStateLabel(health: ModelHealth | undefined): string {
  if (!health || health.state === "idle") return "未测试";
  if (health.state === "testing") return "测试中";
  if (health.state === "ok") return "可联通";
  return "不可联通";
}

function modelHealthStateClass(health: ModelHealth | undefined): string {
  if (!health || health.state === "idle") return "border-border/50 text-muted-foreground/70";
  if (health.state === "testing") return "border-amber-500/25 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400";
  if (health.state === "ok") return "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400";
  return "border-destructive/25 bg-destructive/[0.08] text-destructive";
}

function sourceBadgeLabel(source: UnifiedModelSource): string {
  if (source === "manual") return "手工";
  if (source === "both") return "手工+可用";
  if (source === "detected") return "自动已添加";
  return "可用未添加";
}

function sourceBadgeClass(source: UnifiedModelSource): string {
  if (source === "manual") return "border-sky-500/25 bg-sky-500/[0.08] text-sky-600 dark:text-sky-400";
  if (source === "both") return "border-amber-500/25 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400";
  if (source === "detected") return "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400";
  return "border-zinc-500/25 bg-zinc-500/[0.08] text-zinc-600 dark:text-zinc-400";
}
