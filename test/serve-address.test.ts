import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "@crane/storage";
import { saveServeAddress } from "../src/cli/serve.js";
import { checkExposure } from "../src/server/security.js";
import { onFixtureCleanup, testHome } from "./support/fixtures.js";

test("serve address: saves the normalized public origin and replaces a previous address", (t) => {
  testHome(t);
  const store = new Store(":memory:");
  onFixtureCleanup(t, () => store.close());
  assert.equal(store.publicUrl(), null);

  const addresses = [
    ["https://CRANE.example.com:443/", "https://crane.example.com"],
    ["https://other.example.com:8443/", "https://other.example.com:8443"],
  ];
  for (const [publicUrl, origin] of addresses) {
    const exposure = checkExposure({ host: "127.0.0.1", operators: 1, publicUrl });
    assert.equal(exposure.error, undefined);
    saveServeAddress(store, exposure);
    assert.equal(store.publicUrl(), origin);
  }
});

test("serve address: serving without a public URL clears a previous address", (t) => {
  testHome(t);
  const store = new Store(":memory:");
  onFixtureCleanup(t, () => store.close());

  for (const host of ["127.0.0.1", "0.0.0.0"]) {
    store.setPublicUrl("https://old.example.com");
    const exposure = checkExposure({ host, operators: 1, allowInsecureHttp: true });
    assert.equal(exposure.error, undefined);
    saveServeAddress(store, exposure);
    assert.equal(store.publicUrl(), null, host);
  }
});
