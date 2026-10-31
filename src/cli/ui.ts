import pc from "picocolors";
import type { Agent, BlockedTool, Task, TaskEvent, TaskStatus } from "../core/types.js";
import { KIND_LABEL, STATUS_LABEL } from "../core/types.js";

/** Crane yellow: the one accent colour, used sparingly (brand mark, the thing that needs you). */
const yellow = (s: string) => (pc.isColorSupported ? `\x1b[38;2;242;184;7m${s}\x1b[39m` : s);
export const accent = yellow;
export const dim = pc.dim;
export const bold = pc.bold;

const width = () => Math.min(process.stdout.columns || 80, 100);

export function brand(): string {
  return `${yellow("▟")} ${bold("crane")}`;
}

const STATUS_COLOR: Record<TaskStatus, (s: string) => string> = {
  queued: pc.dim,
  running: pc.cyan,
  needs_review: yellow,
  approved: pc.green,
  merging: pc.cyan,
  merged: pc.green,
  done: pc.green,
  rejected: pc.dim,
  failed: pc.red,
  cancelled: pc.dim,
};

export function statusDot(status: TaskStatus): string {
  const glyph = status === "running" || status === "merging" ? "◉" : status === "queued" ? "○" : "●";
  return STATUS_COLOR[status](glyph);
}

export function statusText(status: TaskStatus): string {
  return STATUS_COLOR[status](STATUS_LABEL[status]);
}

export function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

/** One line per task: dot, id, title, and a quiet right-hand column. */
export function taskLine(m: Task, repoName?: string): string {
  const right = [repoName, ago(m.finishedAt ?? m.startedAt ?? m.createdAt)].filter(Boolean).join(" · ");
  const room = width() - 4 - m.id.length - right.length - 4;
  return `  ${statusDot(m.status)} ${dim(m.id)}  ${truncate(m.title, Math.max(16, room)).padEnd(Math.max(16, room))}  ${dim(right)}`;
}

export function section(title: string, count?: number): string {
  return `\n${bold(title)}${count !== undefined ? dim(`  ${count}`) : ""}`;
}

export function hint(...cmds: [string, string][]): string {
  const col = Math.max(26, ...cmds.map(([c]) => c.length + 3));
  return cmds.map(([cmd, what]) => `  ${accent("›")} ${cmd.padEnd(col)}${dim(what)}`).join("\n");
}

const BARS = "▁▂▃▄▅▆▇█";
export function sparkline(values: number[]): string {
  const max = Math.max(1, ...values);
  return values.map((v) => (v === 0 ? dim("▁") : BARS[Math.min(7, Math.round((v / max) * 7))])).join("");
}

export function agentLine(a: Agent, taskTitle?: string): string {
  const state =
    a.state === "working" ? pc.cyan("working") : a.state === "paused" ? yellow("paused") : dim("idle");
  return `  ${a.state === "working" ? pc.cyan("◉") : dim("○")} ${a.name.padEnd(9)} ${state.padEnd(16)} ${
    taskTitle ? truncate(taskTitle, width() - 34) : dim(`${a.tasksCompleted} tasks done`)
  }`;
}

export function eventLine(e: TaskEvent): string {
  const t = dim(new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const body = e.message.replace(/\s+/g, " ");
  switch (e.type) {
    case "tool":
      return `${t}  ${dim("·")} ${dim(truncate(body, width() - 14))}`;
    case "note":
      return `${t}  ${truncate(body, width() - 12)}`;
    case "finding":
      return `${t}  ${accent("◆")} ${bold(body)}`;
    case "error":
      return `${t}  ${pc.red("✕")} ${pc.red(body)}`;
    case "blocked":
      return `${t}  ${accent("⊘")} ${truncate(body, width() - 14)}`;
    case "operator":
      return `${t}  ${pc.magenta("›")} ${body}`;
    case "status":
      return `${t}  ${dim("—")} ${dim(body)}`;
  }
}

/** One line per blocked command: what, where, and how often. */
export function blockedLine(b: BlockedTool): string {
  const often = b.tasks > 1 ? `in ${b.tasks} tasks` : b.times > 1 ? `${b.times} times` : "once";
  return `  ${accent("⊘")} ${bold(b.label)}  ${dim(`${b.repoName} · blocked ${often} · ${ago(b.lastAt)}`)}`;
}

export function kindLabel(m: Task): string {
  return KIND_LABEL[m.kind];
}

export function fail(message: string): never {
  console.error(`${pc.red("✕")} ${message}`);
  process.exit(1);
}

export function ok(message: string) {
  console.log(`${pc.green("✓")} ${message}`);
}

export function wrap(text: string, indent = 4): string {
  const w = width() - indent;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if ((line + " " + word).trim().length > w) {
        out.push(line);
        line = word;
      } else line = (line + " " + word).trim();
    }
    out.push(line);
  }
  return out.map((l) => " ".repeat(indent) + l).join("\n");
}
