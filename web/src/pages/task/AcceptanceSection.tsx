import { acceptanceFor, type AcceptanceResult, type Task } from "@crane/contracts";
import { AcceptanceChecks } from "../../components/AcceptanceChecks";
import { Section } from "../../components/Section";

function AcceptanceChip({ reported, said, index }: { reported: boolean; said: AcceptanceResult | undefined; index: number }) {
  if (!reported) return <span className="chip">{index + 1}</span>;
  if (said?.met) return <span className="chip chip-ok">Met</span>;
  return <span className="chip chip-bad">{said ? "Not met" : "Not reported"}</span>;
}

export function AcceptanceSection({ task, acceptance, acceptanceChecks, unmet }: {
  task: Task;
  acceptance: string[];
  acceptanceChecks: string[];
  unmet: number;
}) {
  const required = acceptance.length + acceptanceChecks.length;
  if (required === 0) return null;
  const { report } = task;
  return (
    <Section id="acceptance" title={<>
      Acceptance criteria{" "}
      <span className="count">{report ? `${required - unmet} of ${required} met` : required}</span>
    </>}>
      <div className="card card-pad" style={{ paddingBlock: 0 }}>
        {acceptance.map((criterion, i) => {
          const said = report ? acceptanceFor(report, criterion) : undefined;
          return (
            <div className="acceptance-item" key={i}>
              <AcceptanceChip reported={!!report} said={said} index={i} />
              <p>{criterion}</p>
              {said?.evidence && <p className="evidence">{said.evidence}</p>}
            </div>
          );
        })}
        <AcceptanceChecks task={task} commands={acceptanceChecks} />
      </div>
    </Section>
  );
}
