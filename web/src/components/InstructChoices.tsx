import { AUTONOMY_LABEL, KIND_LABEL, choosableDrivers, type Autonomy, type DriverInfo, type Repo, type TaskDraft, type TaskKind } from "../lib/api";
import type { DraftOverrides } from "../lib/instruct-draft";
import { Choice } from "./Choice";

const AUTONOMY_HINT: Record<Autonomy, string> = {
  observe: "Reads and reports back. Never changes a file.",
  propose: "Works on its own branch, then waits for you.",
  act: "Works on its own branch and finishes on its own.",
};

const KIND_HINT: Record<TaskKind, string> = {
  maintenance: "Fixes, upgrades, flaky tests, cleanup",
  repo_feature: "Something new for one of your repos",
  factory_feature: "Something new for Crane itself",
};

function repoLabel(repoId: string | null, repos: Repo[]): string {
  if (!repoId) return "Choose a repo";
  return repos.find((r) => r.id === repoId)?.name ?? "—";
}

/** Null is "the default agent". Only asked about when more than one agent is installed. */
function AgentChoice({ drivers, driver, remote, onChange }: {
  drivers: DriverInfo[];
  driver: string | null;
  remote: boolean;
  onChange: (driver: string | null) => void;
}) {
  const agents = remote ? drivers : choosableDrivers(drivers);
  const defaultAgent = drivers.find((d) => d.isDefault);
  if (remote ? agents.length === 0 : agents.length <= 1) return null;
  const defaultLabel = remote ? "Container default" : defaultAgent?.label ?? "Default";
  const options: { value: string | null; label: string; hint?: string }[] = agents.map((a) => ({
    value: a.name,
    label: a.label,
    hint: a.hint,
  }));
  if (remote) options.unshift({ value: null, label: defaultLabel, hint: defaultAgent?.label });
  const isDefault = (v: string | null) => !remote && v === defaultAgent?.name;
  return (
    <Choice
      k="Agent"
      value={remote ? driver : driver ?? defaultAgent?.name ?? null}
      label={agents.find((a) => a.name === driver)?.label ?? defaultLabel}
      why={driver ? "You chose this" : remoteDefaultHint(remote)}
      options={options}
      onChange={(v) => onChange(isDefault(v) ? null : v)}
    />
  );
}

function remoteDefaultHint(remote: boolean): string {
  return remote ? "The container's default agent" : "Your default agent";
}

/** The factory's reading of the instruction, one button per thing the operator can change. */
export function InstructChoices({ final, repos, override, drivers, driver, remote = false, onDriver }: {
  final: TaskDraft;
  repos: Repo[];
  override: (change: DraftOverrides) => void;
  drivers: DriverInfo[];
  driver: string | null;
  remote?: boolean;
  onDriver: (driver: string | null) => void;
}) {
  return (
    <div className="choices">
      <Choice
        k="Repo"
        value={final.repoId}
        unset={!final.repoId}
        label={repoLabel(final.repoId, repos)}
        why={final.why.repo}
        options={repos.map((r) => ({ value: r.id, label: r.name, hint: r.isFactory ? "Crane itself" : r.path }))}
        onChange={(v) => override({ repoId: v })}
      />
      <Choice
        k="Type"
        value={final.kind}
        label={KIND_LABEL[final.kind]}
        why={final.why.kind}
        options={(Object.keys(KIND_LABEL) as TaskKind[]).map((k) => ({ value: k, label: KIND_LABEL[k], hint: KIND_HINT[k] }))}
        onChange={(v) => override({ kind: v })}
      />
      <Choice
        k="Freedom"
        value={final.autonomy}
        label={AUTONOMY_LABEL[final.autonomy]}
        why={final.why.autonomy}
        options={(Object.keys(AUTONOMY_LABEL) as Autonomy[]).map((a) => ({
          value: a,
          label: AUTONOMY_LABEL[a],
          hint: AUTONOMY_HINT[a],
        }))}
        onChange={(v) => override({ autonomy: v })}
      />
      <AgentChoice drivers={drivers} driver={driver} remote={remote} onChange={onDriver} />
    </div>
  );
}
