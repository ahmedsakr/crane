import { test } from "node:test";
import assert from "node:assert/strict";
import { CommanderError, type Command } from "commander";
import { readFileSync } from "node:fs";
import { buildProgram } from "../src/cli/program.js";
import { createCliContext, hostActor } from "../src/cli/context.js";
import { Store } from "../src/core/store.js";
import { dbPath } from "../src/core/paths.js";
import { OperatorActions } from "../src/factory/actions.js";
import { checkExposure } from "../src/server/security.js";
import { onFixtureCleanup, testHome } from "./support/fixtures.js";
import { PASSWORD, PUBLIC_URL, assertSecretFree, hostCommand } from "./support/auth-e2e.js";

test("auth runbook: serve, start, operators and auth help cover every documented command and flag", async () => {
  const store = new Store(":memory:");
  const help = async (...args: string[]) => {
    const out: string[] = [];
    const program = buildProgram(createCliContext(store));
    const configure = (command: Command) => {
      command.exitOverride().configureOutput({ writeOut: (line) => out.push(line) });
      for (const child of command.commands) configure(child);
    };
    configure(program);
    await assert.rejects(program.parseAsync(["node", "crane", ...args, "--help"]),
      (err: unknown) => err instanceof CommanderError && err.code === "commander.helpDisplayed" && err.exitCode === 0);
    return out.join("");
  };
  try {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const sections = readme.split("### Operators and sign-in\n")[1]!.split("## Configuration\n")[0]!;
    const serve = await help("serve");
    const start = await help("start");
    for (const flag of ["--host", "--public-url", "--trust-proxy", "--allow-insecure-http", "--tls-cert", "--tls-key"]) {
      assert.ok(sections.includes(flag), flag);
      for (const output of [serve, start]) assert.ok(output.includes(flag), flag);
    }
    const commands = {
      operators: ["add", "invite", "invites", "revoke-invite", "reset-password", "role", "sign-out", "remove"],
      auth: ["status", "devices", "sign-out", "off"],
    };
    for (const [group, names] of Object.entries(commands)) {
      const output = await help(group);
      for (const name of names) {
        assert.ok(sections.includes(`crane ${group} ${name}`), `${group} ${name} is documented`);
        assert.match(output, new RegExp(`^\\s+${name}(?:\\s|\\[|\\()`, "m"));
      }
    }
    const flags: [string, string, string[]][] = [
      ["operators", "add", ["--admin", "--name", "--password-stdin", "--generate"]],
      ["operators", "invite", ["--admin", "--name"]],
      ["operators", "reset-password", ["--password-stdin", "--generate"]],
      ["auth", "devices", ["--operator"]], ["auth", "sign-out", ["--all"]],
    ];
    for (const [group, command, options] of flags) {
      const output = await help(group, command);
      for (const option of options) assert.ok(output.includes(option), `${group} ${command} ${option}`);
    }
    assert.match(await help("operators", "invite"), /7 days/);
    assert.match(await help("operators", "reset-password"), /24-hour/);
    assert.match(await help("auth", "off"), /remove every operator, invite and signed-in device/);
    assert.equal(checkExposure({ host: "127.0.0.1", publicUrl: PUBLIC_URL, operators: 1 }).error, undefined);
    assert.match(checkExposure({ host: "0.0.0.0", operators: 0, allowInsecureHttp: true }).error ?? "", /Nobody can sign in/);
    assert.ok(checkExposure({ host: "0.0.0.0", operators: 1, allowInsecureHttp: true }).warning);
  } finally { store.close(); }
});

test("auth persistence: CLI bootstrap and access actions leave no plaintext secrets in any home file or output", async (t) => {
  testHome(t);
  const log: string[] = [];
  await hostCommand(log, ["operators", "add", "robin", "--admin", "--password-stdin"], PASSWORD);
  const store = new Store(dbPath());
  const close = onFixtureCleanup(t, () => store.close());
  const actions = new OperatorActions(store);
  const signed = await actions.signIn("robin", PASSWORD);
  const invited = actions.inviteOperator(hostActor(), { role: "operator", name: "Kai" });
  const reset = actions.createPasswordReset(hostActor(), signed.operator.id);
  const secrets = [PASSWORD, signed.token, invited.token, reset.token];
  assertSecretFree(log, secrets);
  await hostCommand(log, ["auth", "sign-out", "--all"]);
  assert.equal(actions.authenticate(signed.token), null);
  assertSecretFree(log, secrets);
  await close(); // Also scan the checkpointed crane.db after the last connection closes.
  assertSecretFree(log, secrets);
});
