import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:https";
import { loadTls } from "../src/cli/tls.js";
import { checkExposure } from "../src/server/security.js";
import { temporaryRoot } from "./support/fixtures.js";
import { TLS_CERT, TLS_KEY } from "./support/tls.js";

test("TLS is optional and both file options are required together", () => {
  assert.equal(loadTls({}), undefined);
  for (const options of [{ tlsCert: "cert.pem" }, { tlsKey: "key.pem" }]) {
    assert.throws(() => loadTls(options), /--tls-cert <file> and --tls-key <file> must be given together/);
  }
});

test("direct TLS exposure still needs an operator and an HTTPS public URL", () => {
  const options = { host: "0.0.0.0", operators: 1, tlsCert: "cert.pem", tlsKey: "key.pem" };
  assert.equal(checkExposure({ ...options, publicUrl: "https://crane.example.com" }).error, undefined);
  assert.equal(checkExposure({ ...options, publicUrl: "https://crane.example.com" }).warning, undefined);
  assert.match(checkExposure(options).error ?? "", /without an https --public-url/);
  assert.match(checkExposure({ ...options, publicUrl: "http://crane.example.com" }).error ?? "", /without an https --public-url/);
  assert.match(checkExposure({ ...options, publicUrl: "https://crane.example.com", operators: 0 }).error ?? "", /Nobody can sign in/);
});

test("TLS loads a matching PEM pair for Node HTTPS and names missing, unreadable and invalid files", t => {
  const root = temporaryRoot(t, "crane-tls-");
  const tlsCert = join(root, "cert.pem");
  const tlsKey = join(root, "key.pem");
  const options = { tlsCert, tlsKey };
  assert.throws(() => loadTls(options), error => String(error).includes(tlsCert) && /--tls-cert.*ENOENT/.test(String(error)));
  writeFileSync(tlsCert, TLS_CERT);
  assert.throws(() => loadTls(options), error => String(error).includes(tlsKey) && /--tls-key.*ENOENT/.test(String(error)));
  // A directory reliably produces a read error even when tests run as root.
  assert.throws(() => loadTls({ tlsCert: root, tlsKey }), /Couldn't read --tls-cert file/);
  assert.throws(() => loadTls({ tlsCert, tlsKey: root }), /Couldn't read --tls-key file/);
  writeFileSync(tlsKey, TLS_KEY);
  const loaded = loadTls(options)!;
  assert.equal(loaded.createServer, createServer);
  assert.equal(loaded.serverOptions.cert?.toString(), TLS_CERT);
  assert.equal(loaded.serverOptions.key?.toString(), TLS_KEY);
  writeFileSync(tlsKey, "");
  assert.throws(() => loadTls(options), /Invalid TLS certificate/);
  writeFileSync(tlsKey, TLS_KEY);
  writeFileSync(tlsCert, "");
  assert.throws(() => loadTls(options), /Invalid TLS certificate/);
  writeFileSync(tlsCert, TLS_CERT);
  writeFileSync(tlsKey, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }));
  assert.throws(() => loadTls(options), error => String(error).includes(tlsCert) && String(error).includes(tlsKey) && /key values mismatch/.test(String(error)));
  writeFileSync(tlsCert, "invalid certificate");
  assert.throws(() => loadTls(options), error => String(error).includes(tlsCert) && /Invalid TLS certificate/.test(String(error)));
});
