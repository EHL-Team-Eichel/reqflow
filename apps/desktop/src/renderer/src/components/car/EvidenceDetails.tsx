import { useEffect, useRef, useState } from "react";
import type { Requirement, RequirementDetail } from "@reqflow/core";
import { api } from "@/lib/api";
import { judgeScore } from "./judge-score";

export function EvidenceDetails({ requirement: r }: { requirement: Requirement }) {
  const [detail, setDetail] = useState<RequirementDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setDetail(null);
    setError(null);
    setLoading(false);
    return () => {
      generation.current++;
    };
  }, [r.id, r.version]);
  const load = () => {
    if (detail || loading) return;
    const current = generation.current;
    setLoading(true);
    api.requirements
      .get(r.id)
      .then(
        (data) => {
          if (current === generation.current) {
            setDetail(data);
            setError(null);
          }
        },
        () => {
          if (current === generation.current)
            setError("Couldn't load evidence. Close and reopen to retry.");
        },
      )
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
  };
  const score = judgeScore(r.score);
  const titles = new Map(detail?.sources.map((s) => [s.id, s.title]));
  return (
    <>
      {score && (
        <div
          className="mt-2 grid grid-cols-2 gap-2 text-xs"
          data-testid="car-importance-confidence"
        >
          <div>
            Importance <strong>{Math.round(score.importance)}/100</strong>
          </div>
          <div title={score.explanation}>
            Solution confidence <strong>{Math.round(score.confidence)}/100</strong>
          </div>
        </div>
      )}
      <details
        className="mt-2 text-xs text-muted"
        data-testid="car-evidence"
        onToggle={(e) => {
          if (e.currentTarget.open) load();
        }}
      >
        <summary className="cursor-pointer text-ink">Why, uncertainty & evidence</summary>
        {r.priorityRationale && <p className="mt-2">{r.priorityRationale}</p>}
        {score && <p className="mt-2">{score.explanation}</p>}
        {[...r.assumptions, ...r.uncertainties].map((u, i) => (
          <p key={i} className="mt-1">
            {u}
          </p>
        ))}
        {loading && <p className="mt-2">Loading evidence…</p>}
        {error && (
          <p role="alert" className="mt-2 text-danger">
            {error}
          </p>
        )}
        {detail?.findings.map((f) => (
          <div key={f.id} className="mt-2 border-t border-line pt-2">
            <p className="text-ink">
              {f.kind === "praise" ? "Counter-evidence: " : ""}
              {f.statement}
            </p>
            {f.evidence.map((e, i) => (
              <blockquote key={i} className="mt-1 border-l border-line pl-2">
                “{e.excerpt}”
                <cite className="block not-italic">
                  {titles.get(e.sourceId) ?? e.sourceId} · {e.locator ?? "Source record"}
                </cite>
              </blockquote>
            ))}
          </div>
        ))}
      </details>
    </>
  );
}
