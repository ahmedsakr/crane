import { Store } from "@crane/storage";
import type { CrewScheduleInput } from "@crane/contracts";
import { OperatorActions } from "@crane/factory/actions";

export const policy: CrewScheduleInput = {
  repoId: "r-test", daysMask: 62, localTime: "09:00", timezone: "America/Toronto", preApprove: true, enabled: true,
};
export const monday = Date.parse("2030-06-17T13:00:00Z");

export function setupCrewSchedule(file = ":memory:") {
  const store = new Store(file);
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: process.cwd(), name: "crane", isFactory: true });
  store.upsertAgent({ id: "a-tests", name: "Tests", driver: "simulated" });
  store.setSetting("crew_role_a-tests", "tests");
  const input = { ...policy, repoId: repo.id };
  return { store, actions, repo, input };
}
