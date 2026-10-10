import { useCallback, useEffect, useMemo, useState } from "react";
import type { Requirement } from "@reqflow/core";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import { api, ReqflowError } from "@/lib/api";
import { groupByPart, type ClassifiedRequirement } from "./classify";

export type RequirementSource = "app" | "sample";

/**
 * The requirements shown on the car: what Add to Car produced (`requirements.list`), reloaded
 * whenever a run changes, or the synthetic fixtures when the user asks for the sample explicitly.
 */
export function useCarRequirements(source: RequirementSource) {
  const [loaded, setLoaded] = useState<Requirement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoaded(await api.requirements.list());
      setError(null);
    } catch (e) {
      setLoaded([]);
      setError(
        e instanceof ReqflowError && e.code === "not_implemented"
          ? "The requirement store isn't available in this build yet."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
  }, []);

  useEffect(() => {
    void reload();
    return api.runs.onUpdate(() => void reload());
  }, [reload]);

  const requirements = source === "sample" ? fixtureRequirements : (loaded ?? []);
  const byPart = useMemo(() => groupByPart(requirements), [requirements]);
  const counts = useMemo(
    () => new Map([...byPart.entries()].map(([id, list]) => [id, list.length])),
    [byPart],
  );
  return {
    loading: source === "app" && loaded === null,
    error: source === "app" ? error : null,
    total: requirements.length,
    byPart: byPart as ReadonlyMap<string, ClassifiedRequirement[]>,
    counts: counts as ReadonlyMap<string, number>,
  };
}
