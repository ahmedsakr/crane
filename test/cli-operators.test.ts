import "../src/application.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { actorSnapshot } from "@crane/backend-runtime";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";
import { buildProgram, runCli } from "../src/cli/program.js";
import { createCliContext, hostActor } from "../src/cli/context.js";
import type { EventActor, RunnerSummary } from "@crane/contracts";

/**
 * `crane operators` and `crane auth` against an in-memory store, the host's
 * path for onboarding and recovering operators. Same harness as cli.test.ts;
 * calls stay sequential because it swaps console methods and process.exit.
 */

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const PASSWORD = "correct horse battery";

async function crane(store: Store, args: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const exit = process.exit;
  console.log = (...a: unknown[]) => void out.push(plain(a.join(" ")));
  console.error = (...a: unknown[]) => void err.push(plain(a.join(" ")));
  process.exit = ((code?: number) => {
    throw new Exit(code ?? 0);
  }) as typeof process.exit;
  let code = 0;
  try {
    await runCli(["node", "crane", ...args], store, { readLine: async () => stdin });
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A store with the admin `sam`, added the way the host adds the first one. */
async function withAdmin() {
  const store = new Store(":memory:");
  const added = await crane(store, ["operators", "add", "sam", "--name", "Sam", "--admin", "--password-stdin"], PASSWORD);
  assert.equal(added.code, 0, added.err);
  return { store, actions: new OperatorActions(store) };
}

const operator = (store: Store, username: string) => new OperatorActions(store).listOperators().find((o) => o.username === username);
const tokenIn = (out: string) => /\/join#([A-Za-z0-9_-]+)/.exec(out)?.[1] ?? assert.fail(`no link in ${out}`);

/** Every value in every table, to look for secrets the store must never keep. */
function everything(store: Store): string {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.map(({ name }) => JSON.stringify(store.db.prepare(`SELECT * FROM "${name}"`).all())).join("\n");
}

test("cli operators: add --password-stdin makes an admin who can sign in", async () => {
  const { store, actions } = await withAdmin();
  const sam = operator(store, "sam")!;
  assert.equal(sam.role, "admin");
  assert.equal(sam.name, "Sam");
  const signedIn = await actions.signIn("sam", PASSWORD);
  assert.equal(signedIn.operator.username, "sam");
  await assert.rejects(actions.signIn("sam", "not the password"), /isn't right/);
  assert.doesNotMatch(everything(store), new RegExp(PASSWORD));
  assert.doesNotMatch(everything(store), new RegExp(signedIn.token));
});

test("cli operators: the first operator must be an admin, and usernames and passwords are checked", async () => {
  const store = new Store(":memory:");
  const notAdmin = await crane(store, ["operators", "add", "sam", "--password-stdin"], PASSWORD);
  assert.equal(notAdmin.code, 1);
  assert.match(notAdmin.err, /Make the first operator an admin/);
  const short = await crane(store, ["operators", "add", "sam", "--admin", "--password-stdin"], "short");
  assert.match(short.err, /at least 12 characters/);
  const badName = await crane(store, ["operators", "add", "x!", "--admin", "--password-stdin"], PASSWORD);
  assert.match(badName.err, /Choose a username of 3 to 32/);
  const both = await crane(store, ["operators", "add", "sam", "--admin", "--password-stdin", "--generate"]);
  assert.match(both.err, /Choose --password-stdin or --generate/);
  assert.equal(new OperatorActions(store).listOperators().length, 0);

  assert.equal((await crane(store, ["operators", "add", "Sam", "--admin", "--password-stdin"], PASSWORD)).code, 0);
  const taken = await crane(store, ["operators", "add", "SAM", "--password-stdin"], PASSWORD);
  assert.match(taken.err, /That username is taken/);
});

test("cli operators: add --generate prints a 24-character password once and keeps only its hash", async () => {
  const { store, actions } = await withAdmin();
  const result = await crane(store, ["operators", "add", "riley", "--generate"]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Added riley as an operator/);
  const password = /Password for riley\s+(\S+)/.exec(result.out)?.[1] ?? assert.fail(result.out);
  assert.equal(password.length, 24);
  assert.equal(result.out.split(password).length - 1, 1, "shown exactly once");
  assert.equal((await actions.signIn("riley", password)).operator.role, "operator");
  assert.doesNotMatch(everything(store), new RegExp(password));
  const listed = await crane(store, ["operators", "list", "--json"]);
  assert.deepEqual((JSON.parse(listed.out) as { username: string }[]).map((o) => o.username), ["sam", "riley"]);
});

test("cli operators: invite prints a single-use /join# link that signs the new operator in", async () => {
  const { store, actions } = await withAdmin();
  const invited = await crane(store, ["operators", "invite", "--name", "Jo"]);
  assert.equal(invited.code, 0, invited.err);
  assert.match(invited.out, /Invite link for an operator \(expires in 7 days\)/);
  assert.match(invited.out, /for example https:\/\/crane\.example\.com\/join#…/);
  const token = tokenIn(invited.out);
  assert.doesNotMatch(everything(store), new RegExp(token));
  const pending = await crane(store, ["operators", "invites", "--json"]);
  const [invite] = JSON.parse(pending.out) as { invitedBy: string; name: string }[];
  assert.equal(invite!.name, "Jo");
  assert.equal(invite!.invitedBy, `${hostActor().name} on the host`);

  const joined = await actions.acceptInvite(token, { username: "jordan", password: PASSWORD });
  assert.equal(joined.operator.name, "Jo");
  assert.ok(actions.authenticate(joined.token));
  await assert.rejects(actions.acceptInvite(token, { username: "jordan2", password: PASSWORD }), /expired or was already used/);

  const second = tokenIn((await crane(store, ["operators", "invite", "--admin"])).out);
  const id = (JSON.parse((await crane(store, ["operators", "invites", "--json"])).out) as { id: string }[])[0]!.id;
  assert.match((await crane(store, ["operators", "revoke-invite", id])).out, /Revoked link/);
  await assert.rejects(actions.acceptInvite(second, { username: "kim", password: PASSWORD }), /expired or was already used/);
});

test("cli operators: invite and reset links are full https links once served with --public-url", async () => {
  const { store, actions } = await withAdmin();
  store.setPublicUrl("https://crane.example.com");
  const invited = await crane(store, ["operators", "invite", "--name", "Jo"]);
  assert.equal(invited.code, 0, invited.err);
  const link = /^\s+(https:\/\/crane\.example\.com\/join#[A-Za-z0-9_-]+)$/m.exec(invited.out)?.[1] ?? assert.fail(invited.out);
  assert.doesNotMatch(invited.out, /Open it at your dashboard's address/);
  const joined = await actions.acceptInvite(new URL(link).hash.slice(1), { username: "jordan", password: PASSWORD });
  assert.equal(joined.operator.username, "jordan");

  const reset = await crane(store, ["operators", "reset-password", "jordan", "--link"]);
  assert.match(reset.out, /^\s+https:\/\/crane\.example\.com\/join#[A-Za-z0-9_-]+$/m);

  // Served again without one: the setting is cleared, and links go back to a path to open at the dashboard.
  store.setPublicUrl(null);
  assert.equal(store.publicUrl(), null);
  const bare = await crane(store, ["operators", "invite"]);
  assert.match(bare.out, /^\s+\/join#[A-Za-z0-9_-]+$/m);
  assert.match(bare.out, /Open it at your dashboard's address/);
});

test("cli operators: role changes, and the last admin can't be demoted or removed", async () => {
  const { store } = await withAdmin();
  const demote = await crane(store, ["operators", "role", "sam", "operator"]);
  assert.equal(demote.code, 1);
  assert.match(demote.err, /Keep at least one admin/);
  const remove = await crane(store, ["operators", "remove", "sam", "--yes"]);
  assert.match(remove.err, /Keep at least one admin/);
  assert.equal(operator(store, "sam")?.role, "admin");

  await crane(store, ["operators", "add", "riley", "--password-stdin"], PASSWORD);
  assert.match((await crane(store, ["operators", "role", "riley", "admin"])).out, /riley is now an admin/);
  assert.match((await crane(store, ["operators", "role", "sam", "operator"])).out, /sam is now an operator/);
  assert.equal(operator(store, "sam")?.role, "operator");
  assert.match((await crane(store, ["operators", "role", "sam", "owner"])).err, /Choose the role admin or operator/);
  assert.match((await crane(store, ["operators", "role", "nobody", "admin"])).err, /No operator nobody/);

  assert.match((await crane(store, ["operators", "remove", "sam", "--yes"])).out, /Removed sam/);
  assert.equal(operator(store, "sam"), undefined);
});

test("cli operators: reset-password makes a link, or sets the password and signs them out", async () => {
  const { store, actions } = await withAdmin();
  const before = await actions.signIn("sam", PASSWORD);
  const link = await crane(store, ["operators", "reset-password", "sam"]);
  assert.match(link.out, /Reset link for sam \(expires in 24 hours\)/);
  const token = tokenIn(link.out);
  assert.equal(actions.checkInvite(token).username, "sam");
  assert.ok(actions.authenticate(before.token), "a link alone signs nobody out");

  const next = "another long password";
  const direct = await crane(store, ["operators", "reset-password", "sam", "--password-stdin"], next);
  assert.match(direct.out, /Set sam's password and signed them out everywhere/);
  assert.equal(actions.authenticate(before.token), null);
  await actions.signIn("sam", next);
  assert.match((await crane(store, ["operators", "reset-password", "sam", "--link", "--generate"])).err, /Choose --link/);
});

test("cli auth: devices, sign-out by device, operator and --all", async () => {
  const { store, actions } = await withAdmin();
  await crane(store, ["operators", "add", "riley", "--password-stdin"], PASSWORD);
  const phone = await actions.signIn("sam", PASSWORD, { client: "Safari on iOS" });
  await actions.signIn("sam", PASSWORD, { client: "Firefox on macOS" });
  await actions.signIn("riley", PASSWORD);

  const all = JSON.parse((await crane(store, ["auth", "devices", "--json"])).out) as Record<string, unknown>[];
  assert.equal(all.length, 3);
  assert.deepEqual(Object.keys(all[0]!).sort(), ["client", "createdAt", "expiresAt", "id", "lastSeenAt", "operator", "operatorName"]);
  const sams = JSON.parse((await crane(store, ["auth", "devices", "--operator", "sam", "--json"])).out) as { id: string; client: string }[];
  assert.deepEqual(sams.map((s) => s.client).sort(), ["Firefox on macOS", "Safari on iOS"]);
  assert.match((await crane(store, ["auth", "devices"])).out, /Signed-in devices\s+3/);

  assert.match((await crane(store, ["auth", "sign-out", phone.session.id])).out, /Signed out/);
  assert.equal(actions.authenticate(phone.token), null);
  assert.match((await crane(store, ["auth", "sign-out", phone.session.id])).err, /No signed-in device/);
  assert.match((await crane(store, ["auth", "sign-out"])).err, /or --all/);
  assert.match((await crane(store, ["operators", "sign-out", "sam"])).out, /Signed out 1 device for sam/);
  assert.match((await crane(store, ["auth", "sign-out", "--all"])).out, /Signed out 1 device$/m);
  assert.equal(actions.listAllSessions(hostActor()).length, 0);
});

test("cli auth: status before and after setup, and off --yes removes everything with a warning", async () => {
  const store = new Store(":memory:");
  const off = await crane(store, ["auth", "status"]);
  assert.match(off.out, /Sign-in isn't set up/);
  assert.match(off.out, /crane operators add <username> --admin/);

  await crane(store, ["operators", "add", "sam", "--admin", "--password-stdin"], PASSWORD);
  await crane(store, ["operators", "add", "riley", "--password-stdin"], PASSWORD);
  await crane(store, ["operators", "invite"]);
  const actions = new OperatorActions(store);
  await actions.signIn("sam", PASSWORD);
  const on = await crane(store, ["auth"]);
  assert.match(on.out, /Sign-in is set up/);
  assert.match(on.out, /2 operators · 1 admin · 1 device signed in/);

  const cleared = await crane(store, ["auth", "off", "--yes"]);
  assert.equal(cleared.code, 0, cleared.err);
  assert.match(cleared.out, /Turned sign-in off\s+removed 2 operators, 1 pending link and 1 device/);
  assert.match(cleared.out, /refuses every API call until you add an operator again/);
  assert.equal(actions.listOperators().length, 0);
  assert.equal(actions.listInvites(hostActor()).length, 0);
  assert.equal(actions.listAllSessions(hostActor()).length, 0);
});

test("cli: commands run as the host, so the operator events they write carry a host actor", async () => {
  const store = new Store(":memory:");
  const repo = store.addRepo({ path: "/repo", name: "app" });
  const task = store.createTask({ kind: "maintenance", title: "Queued", brief: "", repoId: repo.id, autonomy: "propose" });
  const actors: { type: string; actor: EventActor | null }[] = [];
  const addEvent = store.addEvent.bind(store);
  store.addEvent = (taskId, type, message, data) => {
    actors.push({ type, actor: actorSnapshot() });
    return addEvent(taskId, type, message, data);
  };
  assert.equal((await crane(store, ["cancel", task.id])).code, 0);
  const written = actors.filter((a) => a.type === "operator");
  assert.ok(written.length > 0, "cancel writes an operator event");
  for (const { actor } of written) assert.deepEqual(actor, hostActor());
  assert.equal(hostActor().kind, "host");
  assert.equal(actorSnapshot(), null, "the actor doesn't outlive the command");
});

test("cli: --help lists the operators and auth groups", () => {
  const help = buildProgram(createCliContext(new Store(":memory:"))).helpInformation();
  assert.match(help, /^\s+operators\b.*Who can sign in/m);
  assert.match(help, /^\s+auth\b.*Dashboard sign-in/m);
});

async function withRunnerOperators(t: TestContext) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const repo = store.addRepo({ path: "/repo", name: "app", isFactory: true });
  const actions = new OperatorActions(store);
  await actions.addOperator(hostActor(), { username: "sam", name: "Sam", role: "admin", password: PASSWORD });
  await actions.addOperator(hostActor(), { username: "robin", name: "Robin", role: "operator", password: PASSWORD });
  return { store, repo, actions };
}

function issuedToken(output: string, url: string): string {
  const token = /printf '%s\\n' '([\w-]{43})' \| crane runner start/.exec(output)?.[1];
  assert.ok(token, "the setup command contains a token");
  assert.ok(output.includes(`crane runner start --url '${url}' --token-stdin`));
  assert.equal(output.split(token).length, 2, "the token is printed once");
  return token;
}

test("cli runners: the host and the owner can manage containers, and only issuance prints a token", async (t) => {
  const { store, actions } = await withRunnerOperators(t);
  store.setPublicUrl("https://crane.example.com");
  const hosted = await crane(store, ["runners", "add", "desktop", "--operator", "sam", "--capacity", "2"]);
  const owned = await crane(store, ["runners", "add", "laptop", "--as-operator", "robin"], PASSWORD);
  assert.equal(hosted.code, 0, hosted.err);
  assert.equal(owned.code, 0, owned.err);
  const hostedToken = issuedToken(hosted.out, "https://crane.example.com");
  const ownedToken = issuedToken(owned.out, "https://crane.example.com");
  const refused = await crane(store, ["runners", "add", "spare", "--operator", "sam", "--as-operator", "robin"], PASSWORD);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /on the host/);

  const listed = await crane(store, ["runners", "list", "--json"]);
  const list = JSON.parse(listed.out) as RunnerSummary[];
  assert.deepEqual(list.map((r) => [r.ownerName, r.name, r.capacity]).sort(), [["Robin", "laptop", 1], ["Sam", "desktop", 2]]);
  assert.deepEqual(Object.keys(list[0]!).sort(), ["busy", "capacity", "createdAt", "drivers", "id", "lastSeenAt", "name", "online", "ownerId", "ownerName"]);
  const laptop = list.find((r) => r.name === "laptop")!;
  const desktop = list.find((r) => r.name === "desktop")!;
  const ownList = await crane(store, ["runners", "--as-operator", "robin", "list", "--json"], PASSWORD);
  assert.deepEqual(JSON.parse(ownList.out), [laptop]);
  const textList = await crane(store, ["runners", "list"]);
  assert.match(textList.out, /Robin's container 'laptop'\s+offline\s+0\/1 jobs/);

  const rename = await crane(store, ["runners", "rename", laptop.id, "travel", "--as-operator", "robin"], PASSWORD);
  const capacity = await crane(store, ["runners", "capacity", laptop.id, "3"]);
  assert.match(rename.out, /Renamed Robin's container 'travel'/);
  assert.match(capacity.out, /Set capacity to 3/);
  assert.match((await crane(store, ["runners", "capacity", laptop.id, "2.5"])).err, /Choose a container capacity from 1 to 8/);
  const rotatedOwned = issuedToken((await crane(store, ["runners", "rotate", laptop.id, "--as-operator", "robin"], PASSWORD)).out, "https://crane.example.com");
  const rotatedHosted = issuedToken((await crane(store, ["runners", "rotate", desktop.id])).out, "https://crane.example.com");
  assert.equal(actions.authenticateRunner(ownedToken), null);
  assert.equal(actions.authenticateRunner(hostedToken), null);
  assert.equal(actions.authenticateRunner(rotatedOwned)?.id, laptop.id);
  assert.equal(actions.authenticateRunner(rotatedHosted)?.id, desktop.id);
  const removeOwned = await crane(store, ["runners", "remove", laptop.id, "--as-operator", "robin"], PASSWORD);
  const removeHosted = await crane(store, ["runners", "remove", desktop.id]);
  assert.equal(removeOwned.code, 0, removeOwned.err);
  assert.equal(removeHosted.code, 0, removeHosted.err);
  assert.equal(actions.authenticateRunner(rotatedOwned), null);
  assert.equal(actions.authenticateRunner(rotatedHosted), null);
  const empty = await crane(store, ["runners", "list", "--json"]);
  assert.deepEqual(JSON.parse(empty.out), []);
  for (const { out, err } of [listed, ownList, textList, rename, capacity, removeOwned, removeHosted, empty, refused]) {
    assert.doesNotMatch(out + err, /[\w-]{43}|token_hash/i);
  }
  assert.deepEqual(actions.listAllSessions(hostActor()), []);
});

test("cli routing: do and change-agent use the operator's container and show names the route", async (t) => {
  const { store, repo, actions } = await withRunnerOperators(t);
  const laptop = actions.addRunner(hostActor(), { name: "laptop", operator: "robin" }).runner;
  const desktop = actions.addRunner(hostActor(), { name: "desktop", operator: "robin" }).runner;
  const taskArgs = ["do", "Investigate checkout", "--repo", repo.id, "--yes", "--runner", laptop.id, "--agent", "codex"];
  const host = await crane(store, taskArgs);
  assert.equal(host.code, 1);
  assert.match(host.err, /Only the container's owner can route work to it/);
  const signedOut = await crane(store, [...taskArgs, "--as-operator", "robin"], "wrong password");
  assert.equal(signedOut.code, 1);
  assert.match(signedOut.err, /isn't right/);
  assert.deepEqual(store.listTasks(), []);
  const created = await crane(store, [...taskArgs, "--as-operator", "robin"], PASSWORD);
  assert.equal(created.code, 0, created.err);
  const [task] = store.listTasks();
  assert.equal(task?.runnerId, laptop.id);
  assert.equal(task?.driver, "codex");
  assert.equal(task?.createdBy?.name, "Robin");
  const id = task!.id;
  assert.match((await crane(store, ["show", id])).out, /Runs on Robin's container 'laptop'/);
  const shown = JSON.parse((await crane(store, ["show", id, "--json"])).out);
  assert.equal(shown.task.runnerId, laptop.id);
  assert.deepEqual(Object.keys(shown).sort(), ["blocked", "events", "goal", "prerequisites", "runs", "task"]);

  const change = (runner: string, username = "robin") => crane(store, ["change-agent", id, "--runner", runner, "--as-operator", username], PASSWORD);
  assert.match((await change("c-missing")).err, /Choose a registered container/);
  assert.match((await change("none", "sam")).err, /Only the container's owner can route work to it/);
  const changed = await change(desktop.id);
  assert.equal(changed.code, 0, changed.err);
  assert.equal(store.getTask(id)?.runnerId, desktop.id);
  await crane(store, ["runners", "remove", desktop.id]);
  assert.match((await crane(store, ["show", id])).out, /Runs on Robin's container 'desktop'/);
  const cleared = await change("none");
  assert.equal(cleared.code, 0, cleared.err);
  assert.equal(store.getTask(id)?.runnerId, null);
  assert.doesNotMatch((await crane(store, ["show", id])).out, /Runs on/);
});

test("cli runners required: reads the policy, changes it as admin, and surfaces action refusals", async (t) => {
  const { store, repo } = await withRunnerOperators(t);
  const required = (args: string[] = []) => crane(store, ["runners", "required", ...args], PASSWORD);
  assert.equal((await required()).out, "off");
  const refused = await required(["on", "--as-operator", "robin"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Only admins can change whether containers are required/);
  assert.equal((await required(["on"])).out, "on");
  assert.equal((await required(["--as-operator", "robin"])).out, "on");
  const work = await crane(store, ["do", "Investigate checkout", "--repo", repo.id, "--yes", "--as-operator", "robin"], PASSWORD);
  assert.equal(work.code, 1);
  assert.match(work.err, /Add a container from Account → Containers, then try again/);
  assert.match((await required(["sometimes"])).err, /Choose whether containers are required, on or off/);
  assert.equal((await required(["off", "--as-operator", "sam"])).out, "off");
  assert.equal((await required()).out, "off");
});
