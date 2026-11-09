import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { loadTls } from "../src/cli/tls.js";
import { createApp } from "../src/server/app.js";
import { checkExposure } from "../src/server/security.js";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";
import { onFixtureCleanup, temporaryRoot, testHome } from "./support/fixtures.js";
import { TLS_CERT, TLS_KEY } from "./support/tls.js";

test("direct TLS: Hono serves HTTPS on the selected port with Secure cookies and HSTS", async t => {
  testHome(t);
  const root = temporaryRoot(t, "crane-tls-socket-");
  const options = { tlsCert: join(root, "cert.pem"), tlsKey: join(root, "key.pem") };
  writeFileSync(options.tlsCert, TLS_CERT);
  writeFileSync(options.tlsKey, TLS_KEY);
  const store = new Store(":memory:");
  onFixtureCleanup(t, () => store.close());
  const password = "disposable TLS password";
  await new OperatorActions(store).addOperator({ kind: "host", name: "test" }, { username: "sam", name: "Sam", password, role: "admin" });
  const exposure = checkExposure({ host: "0.0.0.0", publicUrl: "https://crane.example.com", operators: 1, ...options });
  assert.equal(exposure.error, undefined);
  assert.equal(exposure.warning, undefined);
  const app = createApp(store, { exposed: exposure.exposed, publicUrl: exposure.publicUrl!.origin });
  const server = createAdaptorServer({ fetch: app.fetch, ...loadTls(options) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onFixtureCleanup(t, () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const { port } = server.address() as AddressInfo;
  const response = await new Promise<{ status?: number; cookie: string; hsts?: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/api/auth/sign-in", method: "POST", rejectUnauthorized: false,
      headers: { "content-type": "application/json" } }, res => {
      res.resume();
      res.once("end", () => resolve({ status: res.statusCode, cookie: res.headers["set-cookie"]?.join(";") ?? "", hsts: res.headers["strict-transport-security"] }));
    });
    req.once("error", reject);
    req.end(JSON.stringify({ username: "sam", password }));
  });
  assert.equal(response.status, 200);
  assert.match(response.cookie, /; Secure/);
  assert.equal(response.hsts, "max-age=31536000");
});
