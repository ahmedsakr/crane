import type { BlockedTool, TaskEvent } from "@crane/contracts";
import { BlockedItem, GuardBlockedItem } from "../../components/BlockedItem";
import { Section } from "../../components/Section";
import { hardGuardRefusals } from "../../lib/refusals";

/**
 * What this task's agents were refused: commands the operator can allow first,
 * then the ones Crane's guard refused for good, which need no decision.
 */
export function BlockedSection({ blocked, events, taskId, repoName, onDone }: {
  blocked: BlockedTool[]; events: TaskEvent[]; taskId: string; repoName: string | undefined; onDone: () => void;
}) {
  const hard = hardGuardRefusals(events);
  if (blocked.length === 0 && hard.length === 0) return null;
  return (
    <Section id="blocked" title={<>Blocked <span className="count">{blocked.length + hard.length}</span></>}>
      <div className="card">
        {blocked.map((b) => <BlockedItem key={b.rule} b={b} taskId={taskId} onDone={onDone} />)}
        {hard.map((r) => <GuardBlockedItem key={r.what} r={r} />)}
      </div>
      {blocked.length > 0 && <p className="muted section-note">Allowing applies to every agent in {repoName ?? "this repo"} from its next run.</p>}
    </Section>
  );
}
