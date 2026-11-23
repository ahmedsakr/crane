import type { Overview } from "@crane/contracts";
import { Section } from "../../components/Section";
import { api } from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { runnerStatus } from "../../lib/runners";
import { useAuth } from "../../lib/use-auth";
import { useSubmit } from "../../lib/use-submit";

const getPolicy = () => api.runnerPreference().then((preference) => preference.required);

function RequireContainers() {
  const policy = usePoll(getPolicy, 10_000);
  const { submit, busy, error } = useSubmit();
  return <div className="card card-pad">
    <label>
      <input type="checkbox" checked={policy.data === true} disabled={busy || policy.data === null}
        onChange={(e) => {
          const value = e.target.checked ? "on" : "off";
          void submit(async () => { await api.setRunnersRequired(value); await policy.refresh(); });
        }} />
      {" "}Require containers for operators
    </label>
    {(policy.error || error) && <p className="error-text" role="alert">{policy.error || error}</p>}
  </div>;
}

export function ContainerLanes({ runners }: { runners: Overview["runners"] }) {
  const { operator } = useAuth();
  return <Section id="crew-containers" className="crew-section" title="Container lanes">
    {runners.length > 0 && <ul className="rows card crew-list">
      {runners.map((runner) => <li key={runner.id}>
        <div className="crew-row crew-row-plain">
          <span className="crew-who">
            <span className="agent-name">{runner.label}</span>
            <span className="row-meta">{runnerStatus(runner)}</span>
          </span>
        </div>
      </li>)}
    </ul>}
    {runners.length === 0 && <p className="muted">No containers yet.</p>}
    {operator?.role === "admin" && <RequireContainers />}
  </Section>;
}
