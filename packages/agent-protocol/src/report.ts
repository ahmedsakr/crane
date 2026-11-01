import type { AcceptanceResult, Finding, Report, Screenshot } from "@crane/contracts";

/** The fence tag agents put on the JSON block that ends their final message. Prompts ask for it; parseReport reads it. */
export const REPORT_FENCE = "crane-report";

const IMPACTS = ["low", "medium", "high"] as const;
const EFFORTS = ["small", "medium", "large"] as const;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Pull the structured report out of an agent's final message. Agents are asked to
 * end with a fenced `crane-report` JSON block; if it's missing or malformed we
 * still return something useful built from the raw text.
 *
 * Only the fields agents own are read. `validation` is factory-owned evidence
 * Crane records itself, so an agent that supplies it is ignored.
 */
export function parseReport(finalText: string): Report {
  const fence = new RegExp("```" + REPORT_FENCE + "\\s*\\n([\\s\\S]*?)```", "m");
  const match = finalText.match(fence);
  if (match?.[1]) {
    try {
      const raw = JSON.parse(match[1]) as Record<string, unknown>;
      const findings: Finding[] = Array.isArray(raw.findings)
        ? raw.findings
            .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
            .map((f) => ({
              title: String(f.title ?? "Untitled finding"),
              detail: String(f.detail ?? ""),
              impact: pick(f.impact, IMPACTS, "medium"),
              effort: pick(f.effort, EFFORTS, "medium"),
            }))
        : [];
      return {
        summary: String(raw.summary ?? "").trim() || firstParagraph(finalText.replace(fence, "")),
        findings,
        changedFiles: Array.isArray(raw.changedFiles) ? raw.changedFiles.map(String) : [],
        ...(Array.isArray(raw.screenshots) ? { screenshots: raw.screenshots
          .filter((s): s is Screenshot => !!s && typeof s === "object" && typeof s.path === "string" && typeof s.caption === "string")
          .map(s => ({ path: s.path, caption: s.caption.slice(0, 300) })) } : {}),
        ...(Array.isArray(raw.acceptance) ? { acceptance: raw.acceptance
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof a.criterion === "string")
          // Only a literal true counts as met; anything vaguer leaves it for the operator.
          .map((a): AcceptanceResult => ({ criterion: a.criterion as string, met: a.met === true, evidence: String(a.evidence ?? "").slice(0, 2000) })) } : {}),
      };
    } catch {
      // fall through to the plain-text report
    }
  }
  return { summary: firstParagraph(finalText) || "The agent finished without a summary.", findings: [], changedFiles: [] };
}

function firstParagraph(text: string): string {
  const para = text
    .trim()
    .split(/\n\s*\n/)
    .find((p) => p.trim().length > 0);
  return (para ?? "").trim().slice(0, 600);
}
