import { useMemo } from "react";
import { useApi } from "./use-api";
import type { PersistedModelSelection } from "../pages/chat-page-state";

interface ServicesConfigResponse {
  readonly service?: string | null;
  readonly defaultModel?: string | null;
}

export function usePersistedModelSelection(): {
  readonly persistedSelection: PersistedModelSelection | null;
  readonly ready: boolean;
} {
  const { data, loading } = useApi<ServicesConfigResponse>("/services/config");
  const persistedSelection = useMemo<PersistedModelSelection | null>(() => {
    if (!data) return null;
    return {
      service: data.service ?? null,
      defaultModel: data.defaultModel ?? null,
    };
  }, [data]);

  return {
    persistedSelection,
    ready: !loading,
  };
}
