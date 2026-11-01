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
  const block = reportBlock(finalText);
  if (block) {
    try {
      const raw = block.raw as Record<string, unknown>;
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
        summary: String(raw.summary ?? "").trim() || firstParagraph(block.rest),
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

/**
 * The JSON inside the `crane-report` block, and the message without it. A
 * finding's Markdown can hold its own code fences, so the block ends at the
 * first closing fence that leaves valid JSON, not simply the first fence.
 */
function reportBlock(text: string): { raw: unknown; rest: string } | null {
  const open = new RegExp("```" + REPORT_FENCE + "\\s*\\n").exec(text);
  if (!open) return null;
  const start = open.index + open[0].length;
  for (let end = text.indexOf("```", start); end !== -1; end = text.indexOf("```", end + 3)) {
    try {
      return { raw: JSON.parse(text.slice(start, end)), rest: text.slice(0, open.index) + text.slice(end + 3) };
    } catch {
      // That fence was inside a JSON string, or the JSON is broken. Try the next one.
    }
  }
  return null;
}

function firstParagraph(text: string): string {
  const para = text
    .trim()
    .split(/\n\s*\n/)
    .find((p) => p.trim().length > 0);
  return (para ?? "").trim().slice(0, 600);
}
