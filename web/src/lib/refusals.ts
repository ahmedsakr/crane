import { isReasonedRefusal, type BlockedCall, type TaskEvent } from "@crane/contracts";

const REFUSED_BY = { "crane.guard": "Crane's guard", "claude.auto-mode": "Auto mode" } as const;

/** Lower a sentence's capital so it reads after a colon, leaving acronyms and names like "Crane" alone. */
function afterColon(text: string): string {
  const name = /^(Crane|Claude|Codex|Git)\b/.test(text);
  return /^[A-Z][a-z]/.test(text) && !name ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/**
 * Who refused a call and why, for refusals that say: "Crane's guard blocked
 * this: …" or "Auto mode blocked this: …". Null for allowlist refusals.
 */
export function refusalLine(refusal: { source: string; reason: string | null } | undefined): string | null {
  if (!refusal || !isReasonedRefusal(refusal.source)) return null;
  const reason = refusal.reason?.trim();
  const who = REFUSED_BY[refusal.source];
  return reason ? `${who} blocked this: ${afterColon(reason)}` : `${who} blocked this.`;
}

/** A call Crane's guard refused for good: there's no rule that would allow it. */
export interface HardRefusal {
  /** What the agent tried, as the timeline names it. */
  what: string;
  reason: string | null;
  times: number;
  lastAt: string;
}

function hardRefusal(e: TaskEvent): (BlockedCall & { refusal: NonNullable<BlockedCall["refusal"]> }) | null {
  if (e.type !== "blocked" || !e.data) return null;
  const call = e.data as unknown as BlockedCall;
  return call.refusal?.source === "crane.guard" && call.guard?.overridable === false ? call as never : null;
}

/** The task's hard guard refusals, one per refused call, most recent first. */
export function hardGuardRefusals(events: TaskEvent[]): HardRefusal[] {
  const byCall = new Map<string, HardRefusal>();
  for (const e of events) {
    const call = hardRefusal(e);
    if (!call) continue;
    const what = e.message.replace(/^Blocked: /, "");
    const key = call.command ?? what;
    byCall.set(key, { what, reason: call.refusal.reason, times: (byCall.get(key)?.times ?? 0) + 1, lastAt: e.ts });
  }
  return [...byCall.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
