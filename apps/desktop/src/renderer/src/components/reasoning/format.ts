import { ConfidenceLevel } from "@reqflow/core";
import { AGENT_ROLE_INFO, type AgentRole, type CritiqueVerdict } from "@reqflow/core";

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)} %`;
}

export function levelLabel(level: ConfidenceLevel): string {
  switch (level) {
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
  }
}

export function levelColorClass(level: ConfidenceLevel): string {
  switch (level) {
    case "high":
      return "text-ok";
    case "medium":
      return "text-warn";
    case "low":
      return "text-danger";
  }
}

export function levelBgClass(level: ConfidenceLevel): string {
  switch (level) {
    case "high":
      return "bg-ok";
    case "medium":
      return "bg-warn";
    case "low":
      return "bg-danger";
  }
}

export function formatVerdict(verdict: CritiqueVerdict): string {
  switch (verdict) {
    case "accepted":
      return "Accepted";
    case "revised":
      return "Revised after review";
    case "flagged":
      return "Open issues";
  }
}

export function roleLabel(role: AgentRole): string {
  return AGENT_ROLE_INFO[role]?.label ?? role;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  if (s < 60) {
    return `${s} s`;
  }
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m} min ${rem} s`;
}
