import type { RunnerSummary } from "@crane/contracts";
import { api } from "../../lib/api";
import { useApp } from "../../lib/app-context";
import { runnerStatus } from "../../lib/runners";
import { useRunnerRouting } from "../../lib/use-runner-routing";
import { useSubmit } from "../../lib/use-submit";
import { RemoveRunner } from "../RemoveRunner";
import { RunnerRows } from "../RunnerRows";
import { SheetBody, SheetFoot, SheetHead } from "../Sheet";
import { RunnerForm } from "./RunnerForm";
import { RunnerToken } from "./RunnerToken";

export type ContainerView =
  | { kind: "list" | "add" }
  | { kind: "manage" | "rename" | "rotate" | "remove"; runner: RunnerSummary }
  | { kind: "token"; runner: RunnerSummary; token: string };

export function containerBack(view: ContainerView): ContainerView {
  if (view.kind === "rename" || view.kind === "rotate" || view.kind === "remove") {
    return { kind: "manage", runner: view.runner };
  }
  return { kind: "list" };
}

function ManageRunner({ runner, onBack, onChoose, onDefault, routing }: {
  runner: RunnerSummary;
  onBack: () => void;
  onChoose: (kind: "rename" | "rotate" | "remove") => void;
  onDefault: () => void;
  routing: ReturnType<typeof useRunnerRouting>;
}) {
  const { busy, error, submit } = useSubmit();
  const isDefault = routing.preference?.runnerId === runner.id;
  return <>
    <SheetHead title={runner.name} subtitle={runnerStatus(runner)} onBack={onBack} />
    <SheetBody>
      <div className="account-links">
        <button type="button" className="sheet-link" disabled={!routing.preference || busy} onClick={() => void submit(async () => {
          await api.setDefaultRunner(isDefault ? null : runner.id);
          await routing.refresh();
          onDefault();
        })}>{isDefault ? "Clear default container" : "Send my tasks here by default"}</button>
        <button type="button" className="sheet-link" onClick={() => onChoose("rename")}>Rename container</button>
        <button type="button" className="sheet-link" onClick={() => onChoose("rotate")}>Rotate token</button>
        <button type="button" className="sheet-link" onClick={() => onChoose("remove")}>Remove container</button>
      </div>
      {(error || routing.error) && <p className="error-text" role="alert">{error || routing.error}</p>}
    </SheetBody>
  </>;
}

function RotateRunner({ runner, onBack, onRotate }: {
  runner: RunnerSummary;
  onBack: () => void;
  onRotate: (issued: { runner: RunnerSummary; token: string }) => void;
}) {
  const { busy, error, submit } = useSubmit();
  return <>
    <SheetHead title="Rotate token?" subtitle={runner.name} onBack={onBack} />
    <SheetBody><p>Crane will revoke the old token. Restart the container with the new one.</p></SheetBody>
    <SheetFoot note={error && <span className="error-text" role="alert">{error}</span>}>
      <button type="button" className="btn btn-primary" disabled={busy}
        onClick={() => void submit(async () => onRotate(await api.rotateRunner(runner.id)))}>
        {busy ? "Rotating…" : "Rotate token"}
      </button>
    </SheetFoot>
  </>;
}

export function AccountContainers({ view, onBack, onChange }: {
  view: ContainerView;
  onBack: () => void;
  onChange: (next: ContainerView, expected?: ContainerView) => void;
}) {
  const routing = useRunnerRouting();
  const { refresh } = useApp();
  const list = () => onChange({ kind: "list" }, view);
  const issued = (result: { runner: RunnerSummary; token: string }) => {
    refresh();
    onChange({ kind: "token", ...result }, view);
  };
  if (view.kind === "list") return <>
    <SheetHead title="Containers" onBack={onBack} />
    <SheetBody>
      <RunnerRows runners={routing.runners} defaultId={routing.preference?.runnerId}
        onChoose={(runner) => onChange({ kind: "manage", runner })} />
    </SheetBody>
    <SheetFoot>
      <button type="button" className="btn btn-primary" onClick={() => onChange({ kind: "add" })}>Add a container</button>
    </SheetFoot>
  </>;
  if (view.kind === "add") return <RunnerForm onBack={onBack} onSave={async (input) => issued(await api.addRunner(input))} />;
  if (view.kind === "token") return <RunnerToken name={view.runner.name} token={view.token} onDone={list} />;
  if (!("runner" in view)) return null;
  const runner = routing.runners.find((r) => r.id === view.runner.id) ?? view.runner;
  if (view.kind === "rename") return <RunnerForm runner={runner} onBack={onBack} onSave={async ({ name }) => {
    const updated = await api.renameRunner(runner.id, name);
    refresh();
    onChange({ kind: "manage", runner: updated }, view);
  }} />;
  if (view.kind === "rotate") return <RotateRunner runner={runner} onBack={onBack} onRotate={issued} />;
  if (view.kind === "remove") return <RemoveRunner id={runner.id} name={runner.name} onBack={onBack} onRemoved={() => {
    void routing.refresh();
    list();
  }} />;
  return <ManageRunner runner={runner} routing={routing} onBack={onBack} onDefault={list}
    onChoose={(kind) => onChange({ kind, runner })} />;
}
