import type { OperatorSummary, RunnerSummary } from "@crane/contracts";
import { RunnerRows } from "../../components/RunnerRows";
import { SheetBody, SheetHead } from "../../components/Sheet";
import { useApp } from "../../lib/app-context";

export function OperatorContainers({ operator, onBack, onChoose }: {
  operator: OperatorSummary;
  onBack: () => void;
  onChoose: (runner: RunnerSummary) => void;
}) {
  const { overview } = useApp();
  const runners = (overview?.runners ?? []).filter((r) => r.ownerId === operator.id);
  return <>
    <SheetHead title="Containers" subtitle={operator.name} onBack={onBack} />
    <SheetBody>
      <RunnerRows runners={runners} onChoose={onChoose} />
    </SheetBody>
  </>;
}
