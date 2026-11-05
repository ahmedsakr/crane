import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent, TaskSummary } from "@crane/contracts";
import { MAINTENANCE_ROLE } from "@crane/contracts";
import { crewChangeText, crewRoster, isOnCall, memberStatus, type CrewOverview, type Member } from "../web/src/lib/crew.ts";

const agent = (id: string, over: Partial<Agent> = {}): Agent =>
  ({ id, name: id.toUpperCase(), state: "idle", active: true, role: null, taskId: null, driver: "simulated", defaultDriver: null, runsPostmortems: false, ...over }) as Agent;

const task = (id: string, over: Partial<TaskSummary> = {}): TaskSummary =>
  ({ id, status: "running", assignee: null, postmortemOf: null, ...over }) as TaskSummary;

const roster = (agents: Agent[], over: Partial<CrewOverview> = {}) =>
  crewRoster({ agents, inFlight: [], queuedForAnyone: 0, factory: { running: true, paused: false }, ...over });

const ids = (members: Member[]) => members.map((m) => m.a.id);

test("crewRoster: a member's own task is what they're doing, and nothing waits behind it", () => {
  const doing = task("t-1");
  const queued = task("t-2", { status: "queued", assignee: "a" });
  const [member] = roster([agent("a", { state: "working", taskId: "t-1" })], { inFlight: [doing, queued] }).members;
  assert.equal(member!.doing, doing);
  assert.equal(member!.waiting, null);
});

test("crewRoster: only a queued task assigned to the member is waiting for them", () => {
  const running = task("t-1", { status: "running", assignee: "a" });
  const other = task("t-2", { status: "queued", assignee: "b" });
  const mine = task("t-3", { status: "queued", assignee: "a" });
  assert.equal(roster([agent("a")], { inFlight: [running, other] }).members[0]!.waiting, null);
  assert.equal(roster([agent("a")], { inFlight: [running, other, mine] }).members[0]!.waiting, mine);
});

test("crewRoster: a task that has left the in-flight list is neither doing nor waiting", () => {
  const [member] = roster([agent("a", { taskId: "t-gone" })]).members;
  assert.equal(member!.doing, null);
  assert.equal(member!.waiting, null);
});

test("crewRoster: a member's role resolves to its details", () => {
  const { members } = roster([agent("a", { role: "security" }), agent("b")]);
  assert.equal(members[0]!.role, MAINTENANCE_ROLE.security);
  assert.equal(members[1]!.role, null);
});

test("crewRoster: active lists working members, then those with a run waiting, then the rest, keeping order within each", () => {
  const agents = [
    agent("free-1"),
    agent("waiting", { role: "security" }),
    agent("busy", { state: "working", taskId: "t-1" }),
    agent("free-2"),
  ];
  const { active, members } = roster(agents, { inFlight: [task("t-1"), task("t-2", { status: "queued", assignee: "waiting" })] });
  assert.deepEqual(ids(active), ["busy", "waiting", "free-1", "free-2"]);
  assert.deepEqual(ids(members), ["free-1", "waiting", "busy", "free-2"], "members keep the overview's order");
});

test("crewRoster: a member finishing a task stays active until it's done", () => {
  const agents = [agent("finishing", { active: false, state: "working", taskId: "t-1" }), agent("bench", { active: false })];
  const { active, onCall, working } = roster(agents, { inFlight: [task("t-1")] });
  assert.deepEqual(ids(active), ["finishing"]);
  assert.deepEqual(ids(onCall), ["bench"]);
  assert.equal(working, 1);
  assert.equal(isOnCall(agents[0]!), false);
  assert.equal(isOnCall(agents[1]!), true);
});

test("crewRoster: free counts idle active members with no role and nothing waiting", () => {
  const agents = [
    agent("free"),
    agent("role", { role: "security" }),
    agent("waiting"),
    agent("paused", { state: "paused" }),
    agent("finishing", { active: false, state: "working", taskId: "t-1" }),
    agent("bench", { active: false }),
  ];
  const { free } = roster(agents, { inFlight: [task("t-1"), task("t-2", { status: "queued", assignee: "waiting" })] });
  assert.equal(free, 1);
});

test("crewRoster: offers the first on-call member without a role when queued work has no one free", () => {
  const agents = [agent("specialist", { active: false, role: "security" }), agent("spare", { active: false }), agent("later", { active: false })];
  const { spare, queuedForAnyone } = roster(agents, { queuedForAnyone: 2 });
  assert.equal(spare?.a.id, "spare");
  assert.equal(queuedForAnyone, 2);
});

test("crewRoster: offers no one when nothing needs fixing or the factory can't use them", () => {
  const bench = agent("spare", { active: false });
  const running = { running: true, paused: false };
  assert.equal(roster([bench], { queuedForAnyone: 0, factory: running }).spare, null, "nothing queued");
  assert.equal(roster([bench, agent("free")], { queuedForAnyone: 1, factory: running }).spare, null, "someone is free");
  assert.equal(roster([bench], { queuedForAnyone: 1, factory: { running: false, paused: false } }).spare, null, "factory off");
  assert.equal(roster([bench], { queuedForAnyone: 1, factory: { running: true, paused: true } }).spare, null, "factory paused");
  assert.equal(roster([agent("specialist", { active: false, role: "security" })], { queuedForAnyone: 1, factory: running }).spare, null, "only specialists on-call");
});

test("crewRoster: an overview from an older factory with no queued count reads as zero", () => {
  const overview = { agents: [], inFlight: [], factory: { running: true, paused: false } } as unknown as CrewOverview;
  assert.equal(crewRoster(overview).queuedForAnyone, 0);
});

test("memberStatus: says what a member is doing, in the operator's words", () => {
  const status = (a: Agent, over: Partial<Member> = {}) => memberStatus({ a, role: null, doing: null, waiting: null, ...over });
  const role = MAINTENANCE_ROLE.security;
  assert.equal(status(agent("a", { state: "working" })), "Working on Simulated");
  assert.equal(status(agent("a", { state: "working", active: false })), "Finishing current work, then on-call");
  assert.equal(status(agent("a", { state: "working", active: false }), { doing: task("t", { postmortemOf: "t-0" }) }), "Called in for a post-mortem on Simulated");
  assert.equal(status(agent("a", { active: false, runsPostmortems: true }), { role }), `On-call · Runs post-mortems · ${role.label}`);
  assert.equal(status(agent("a", { state: "paused" })), "Paused");
  assert.equal(status(agent("a"), { role, waiting: task("t") }), `${role.label} · run queued`);
  assert.equal(status(agent("a")), "Free");
});

test("crewChangeText: names the change, and says nothing for a change it doesn't know", () => {
  const a = agent("a");
  assert.equal(crewChangeText(a, { active: true }), "A is active");
  assert.equal(crewChangeText(a, { active: false }), "A is on-call");
  assert.equal(crewChangeText(agent("a", { state: "working" }), { active: false }), "A goes on-call after this task");
  assert.equal(crewChangeText(a, { role: "security" }), `A now handles ${MAINTENANCE_ROLE.security.label.toLowerCase()}`);
  assert.equal(crewChangeText(a, { role: null }), "A takes any queued task");
  assert.equal(crewChangeText(a, { defaultDriver: "simulated" }), "A runs on Simulated");
  assert.equal(crewChangeText(a, { defaultDriver: null }), "A follows the factory default");
  assert.equal(crewChangeText(a, {}), undefined);
});
