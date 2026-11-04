import { STATUS_LABEL, type TaskStatus } from "../lib/api";

export function Dot({ status }: { status: TaskStatus | "on" | "paused" | "off" }) {
  return <span className={`dot dot-${status}`} aria-hidden />;
}

function chipClass(status: TaskStatus): string {
  if (status === "needs_review") return "chip chip-crane";
  if (status === "done" || status === "approved" || status === "merged") return "chip chip-ok";
  if (status === "failed") return "chip chip-bad";
  return "chip";
}

export function StatusChip({ status }: { status: TaskStatus }) {
  return (
    <span className={chipClass(status)}>
      <Dot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}
