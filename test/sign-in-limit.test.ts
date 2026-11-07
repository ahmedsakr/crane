import { test } from "node:test";
import assert from "node:assert/strict";
import { AttemptLimiter, TooManyAttempts, clientAddressKey } from "../src/server/sign-in-limit.js";

test("client keys: an IPv6 address counts under its /64, however it is written", () => {
  for (const address of ["2001:db8:0:1::5", "2001:0db8:0000:0001:ffff:ffff:ffff:ffff", "2001:DB8:0:1:a:b:c:d", "2001:db8::1:0:0:0:7"]) {
    assert.equal(clientAddressKey(address), "2001:db8:0:1::/64", address);
  }
  assert.equal(clientAddressKey("2001:db8:0:2::5"), "2001:db8:0:2::/64");
  assert.equal(clientAddressKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(clientAddressKey("::1"), "0:0:0:0::/64");
  assert.equal(clientAddressKey("64:ff9b::192.0.2.1"), "64:ff9b:0:0::/64");
});

test("client keys: IPv4 addresses, mapped into IPv6 or not, count on their own", () => {
  assert.equal(clientAddressKey("192.0.2.1"), "192.0.2.1");
  assert.equal(clientAddressKey("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(clientAddressKey("::ffff:c000:201"), "192.0.2.1");
  assert.equal(clientAddressKey("::ffff:198.51.100.7"), "198.51.100.7");
});

test("client keys: no address is 'unknown', and anything else is kept as given", () => {
  assert.equal(clientAddressKey(""), "unknown");
  assert.equal(clientAddressKey("not an address"), "not an address");
});

test("client keys: rotating addresses within one /64 shares one client limit", async () => {
  const limiter = new AttemptLimiter(() => 0);
  const fail = (address: string) =>
    limiter.attempt([limiter.limit("client", clientAddressKey(address))], () => Promise.reject(new Error("wrong password")));
  for (let i = 1; i <= 5; i++) await assert.rejects(fail(`2001:db8:0:1::${i}`), /wrong password/);
  await assert.rejects(fail("2001:db8:0:1::99"), TooManyAttempts);
  await assert.rejects(fail("2001:db8:0:2::1"), /wrong password/);
  await assert.rejects(fail("::ffff:192.0.2.1"), /wrong password/);
});
