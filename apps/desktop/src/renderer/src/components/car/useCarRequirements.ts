import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Requirement } from "@reqflow/core";
import { api, ReqflowError } from "@/lib/api";
import { groupByPart, type ClassifiedRequirement } from "./classify";

/**
 * The requirements shown on the car: what Add to Car produced (`requirements.list`), reloaded
 * whenever a run changes and after a reset.
 */
export function useCarRequirements() {
  const [loaded, setLoaded] = useState<Requirement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const reload = useCallback(async () => {
    const current = ++request.current;
    try {
      const requirements = Requirement.array().parse(await api.requirements.list());
      if (current !== request.current) return;
      setLoaded(requirements);
      setError(null);
    } catch (e) {
      if (current !== request.current) return;
      setLoaded((previous) => previous ?? []);
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
    const unsubscribe = api.runs.onUpdate(() => void reload());
    return () => {
      ++request.current;
      unsubscribe();
    };
  }, [reload]);

  const requirements = useMemo(() => loaded ?? [], [loaded]);
  const byPart = useMemo(() => groupByPart(requirements), [requirements]);
  const counts = useMemo(
    () => new Map([...byPart.entries()].map(([id, list]) => [id, list.length])),
    [byPart],
  );
  return {
    loading: loaded === null,
    error,
    total: requirements.length,
    requirements,
    byPart: byPart as ReadonlyMap<string, ClassifiedRequirement[]>,
    counts: counts as ReadonlyMap<string, number>,
    reload,
  };
}
