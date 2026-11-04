import { useId } from "react";
import { driverLabel, type DriverInfo, type TaskRunOptions } from "../lib/api";

/** What the fields hold while editing. Empty text means no choice: the default agent, model or effort. */
export interface AgentChoice {
  driver: string;
  model: string;
  effort: string;
}

export const NO_AGENT_CHOICE: AgentChoice = { driver: "", model: "", effort: "" };

export const agentChoice = (run: TaskRunOptions): AgentChoice =>
  ({ driver: run.driver ?? "", model: run.model ?? "", effort: run.effort ?? "" });

export const chosenAgent = (drivers: DriverInfo[], driver: string): DriverInfo | undefined =>
  driver ? drivers.find((d) => d.name === driver) : drivers.find((d) => d.isDefault);

/**
 * What to send for a choice. Pins the agent when tuning it, so a later default
 * change cannot apply this agent's model or effort to a different one.
 */
export function agentRunOptions(choice: AgentChoice, drivers: DriverInfo[]): Required<TaskRunOptions> {
  const selected = chosenAgent(drivers, choice.driver);
  if (!selected?.efforts.length) return { driver: choice.driver || null, model: null, effort: null };
  const model = choice.model.trim() || null;
  const effort = choice.effort || null;
  return { driver: model || effort ? selected.name : choice.driver || null, model, effort };
}

/** Agent, model and effort. Changing the agent clears the other two, which belong to it. */
export function AgentFields({ value, onChange, drivers, disabled, allowDefault = true, autoFocus }: {
  value: AgentChoice;
  onChange: (choice: AgentChoice) => void;
  drivers: DriverInfo[];
  disabled?: boolean;
  /** Off where the work must name an agent, like a task in a plan. */
  allowDefault?: boolean;
  autoFocus?: boolean;
}) {
  const listId = useId();
  const defaultAgent = drivers.find((d) => d.isDefault);
  const selected = chosenAgent(drivers, value.driver);
  return <>
    <label className="tuning-field">
      <span>Agent</span>
      <select className="input" autoFocus={autoFocus} value={value.driver} disabled={disabled}
        onChange={(e) => onChange({ driver: e.target.value, model: "", effort: "" })}>
        {allowDefault && <option value="">Factory default{defaultAgent ? ` · ${defaultAgent.label}` : ""}</option>}
        {value.driver && !drivers.some((d) => d.name === value.driver) && <option value={value.driver}>{driverLabel(value.driver)} · unavailable</option>}
        {drivers.map((d) => <option key={d.name} value={d.name} disabled={!d.available}>
          {d.label}{d.available ? "" : " · not installed"}
        </option>)}
      </select>
    </label>
    {!!selected?.efforts.length && <>
      <label className="tuning-field">
        <span>Model</span>
        <input className="input" list={listId} value={value.model} disabled={disabled} maxLength={120}
          placeholder={selected.model ?? "Agent default"} onChange={(e) => onChange({ ...value, model: e.target.value })} />
        {selected.models.length > 0 && <datalist id={listId}>
          {selected.models.map((m) => <option key={m} value={m} />)}
        </datalist>}
      </label>
      <label className="tuning-field">
        <span>Model effort</span>
        <select className="input" value={value.effort} disabled={disabled} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
          <option value="">Agent default{selected.effort ? ` · ${selected.effort}` : ""}</option>
          {selected.efforts.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
    </>}
  </>;
}
