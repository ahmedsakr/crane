import type { Task, TaskDiff } from "@crane/contracts";
import { Changes } from "../../components/Changes";

/** Live changes while an agent works; once it's done, the files it reported, with the branch's diff a tap away. */
export function TaskChanges({ task, working, changes, open, onOpenChange }: {
  task: Task;
  working: boolean;
  changes: { diff: TaskDiff | null; error: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (working) {
    if (!changes.diff) return null;
    return (
      <Changes key="live" title="Changes so far" diff={changes.diff} error={changes.error} canOpen open={open} onOpenChange={onOpenChange}
        empty="No changes yet."
        note={changes.diff.live && <p className="muted section-note">Includes work it hasn't committed yet, and updates as it goes.</p>} />
    );
  }
  const reported = task.report?.changedFiles ?? [];
  if (reported.length === 0) return null;
  return (
    // A diff left over from while it ran isn't the branch's; list what the agent reported until the branch's loads.
    <Changes key="branch" title="Changed files" reported={reported} diff={changes.diff?.live ? null : changes.diff} error={changes.error}
      canOpen={!!task.branch} open={open} onOpenChange={onOpenChange} empty="No changes on the branch." />
  );
}
