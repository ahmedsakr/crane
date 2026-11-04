import type { BlockedTool } from "@crane/contracts";
import { BlockedItem } from "../../components/BlockedItem";
import { Section } from "../../components/Section";

export function BlockedSection({ blocked, taskId, repoName, onDone }: { blocked: BlockedTool[]; taskId: string; repoName: string | undefined; onDone: () => void }) {
  if (blocked.length === 0) return null;
  return (
    <Section id="blocked" title={<>Blocked <span className="count">{blocked.length}</span></>}>
      <div className="card">
        {blocked.map((b) => <BlockedItem key={b.rule} b={b} taskId={taskId} onDone={onDone} />)}
      </div>
      <p className="muted section-note">Allowing applies to every agent in {repoName ?? "this repo"} from its next run.</p>
    </Section>
  );
}
