import type { Task } from "@crane/contracts";
import { acceptanceCheckRun } from "../lib/api";

const CHIP = { passed: "chip chip-ok", failed: "chip chip-bad", blocked: "chip chip-bad", unconfigured: "chip chip-bad" } as const;
const LABEL = { passed: "Passed", failed: "Failed", blocked: "Blocked", unconfigured: "Not configured" } as const;

/** One required check on the task page: what Crane itself saw on this candidate, never what the agent said. */
function AcceptanceCheck({ task, command, index }: { task: Task; command: string; index: number }) {
  const run = acceptanceCheckRun(task, command);
  const empty = task.report ? <span className="chip chip-bad">Not run</span> : <span className="chip">{index + 1}</span>;
  return (
    <div className="acceptance-item">
      {run ? <span className={CHIP[run.status]}>{LABEL[run.status]}</span> : empty}
      <p className="mono">{command}</p>
      {run && <p className="evidence">Crane ran it on {run.commit.slice(0, 7)}{run.exitCode === null ? "" : `: exit ${run.exitCode}`}</p>}
    </div>
  );
}

export function AcceptanceChecks({ task, commands }: { task: Task; commands: string[] }) {
  return <>{commands.map((command, i) => <AcceptanceCheck key={command} task={task} command={command} index={i} />)}</>;
}
