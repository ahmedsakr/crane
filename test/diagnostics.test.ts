import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDiagnosticText } from "@crane/diagnostics";
import { safeEvidenceText } from "../packages/agent-drivers/src/command-evidence.js";
import { InstallDiagnostics } from "../packages/worktree-deps/src/install-process.js";

/** Fake credentials in every form either consumer has had to hide, each marked `hide-me`. */
const CREDENTIALS = [
  // Hidden by install diagnostics, but not by command evidence, before they shared rules.
  "npm WARN _auth=hide-me",
  "//registry.npmjs.org/:_auth=hide-me",
  "fetch https://example.test/pkg#hide-me",
  "fetch https://user:p@hide-me@example.test/",
  "fetch https://example.test/?key=\"hide-me\"",
  "password: first hide-me",
  "npm WARN token=first hide-me",
  'token="hide-me',
  "Cookie: a=1; session=hide-me",
  "Set-Cookie: first=1; hide-me=2",
  "Authorization: Digest username=hide-me",
  "password=first&hide-me",
  "Bearer first;hide-me",
  "--password \"unterminated hide-me",
  'curl -H "Cookie: a=\\"first hide-me\\" b" https://example.test',
  // Hidden by command evidence, but not by install diagnostics.
  "curl --user user:hide-me https://example.test",
  "curl -u user:hide-me https://example.test",
  'curl -u "user:hide me" https://example.test',
  "curl -u user:hide-me&first https://example.test",
  // Hidden by neither.
  "curl --user=user:hide-me https://example.test",
  // Hidden by both.
  "fetch git+https://user:hide-me@example.test/repo.git",
  "fetch git+https://example.test/repo.git?key=hide-me",
  'fetch "https://a.test/x","https://b.test/y?key=hide-me"',
  "a.b.token-c=hide-me",
  "X-Api-Key: hide-me",
  "API_TOKEN=hide-me npm test",
  'curl --password "hide-me with spaces" https://example.test',
  'curl --password "prefix"hide-me https://example.test',
  "curl --password prefix\\ hide-me https://example.test",
  "npm WARN api_key='hide-me with spaces'",
  "curl -H 'Authorization: Bearer hide-me' https://example.test",
  "Authorization: Basic hide-me",
  "curl -H 'Cookie: session=hide-me' https://example.test",
  "curl https://user:hide-me@example.test/path",
  "curl https://example.test/path?key=hide-me",
  'node -e \'const x = {"api_key": "hide-me"}\'',
  "npm WARN --password hide-me",
  // Control sequences can't split what the rules look for. Install diagnostics stripped them; command evidence didn't.
  "TO\x1b[0mKEN=hide-me",
  "password\x1b[31m=\x1b[0mhide-me",
  "Bear\x1b[1mer hide-me",
  "token=first\rhide-me",
  "https://user:\x1b[0mhide-me@example.test",
];

for (const [name, sanitize] of [
  ["the shared rules", (raw: string) => sanitizeDiagnosticText(raw, 8192).text],
  ["command evidence", (raw: string) => safeEvidenceText(raw).text],
  ["install diagnostics", (raw: string) => {
    const output = new InstallDiagnostics();
    output.push(`${raw}\n`);
    return output.snapshot();
  }],
  ["install diagnostics, a byte at a time", (raw: string) => {
    const output = new InstallDiagnostics();
    for (const char of `${raw}\n`) output.push(char);
    return output.snapshot();
  }],
] as const) {
  test(`${name} hide every known credential form`, () => {
    for (const input of CREDENTIALS) {
      const text = sanitize(input);
      assert.ok(!text.includes("hide-me") && !text.includes("hide me"), `${JSON.stringify(input)} became ${JSON.stringify(text)}`);
      assert.ok(text.includes("[REDACTED"), `${JSON.stringify(input)} became ${JSON.stringify(text)}`);
    }
  });
}

test("ordinary text passes through unchanged, including line layout", () => {
  for (const text of [
    "npm run screenshot -- /tasks --size 390x844",
    "fetch https://registry.npmjs.org/@types/node/-/node-20.0.0.tgz",
    "fetch https://example.test/pkg.tgz done",
    "--user-agent npm/10",
    "first\n\tsecond\n",
    "",
  ]) {
    assert.deepEqual(sanitizeDiagnosticText(text, 8192), { text, truncated: false });
  }
});

test("control sequences are removed and control characters blanked, keeping newlines and tabs", () => {
  assert.equal(sanitizeDiagnosticText("\x1b[31mred\x1b[0m\tnext\r\nlast\rline\x07\n", 100).text, "red\tnext\nlast line \n");
});

test("redaction is limited to the value's line, even when a quoted value spans lines", () => {
  assert.equal(sanitizeDiagnosticText("token=hide-me first\nsecond", 100).text, "token=[REDACTED]\nsecond");
  assert.equal(sanitizeDiagnosticText('token="hide-me\nhide-me" first\nsecond', 100).text, "token=[REDACTED]\nsecond");
});

test("the limit applies after redaction", () => {
  // A secret that would have fit around the limit, or been cut in two, never shows.
  for (const limit of [6, 8, 10, 12, 20]) {
    const { text } = sanitizeDiagnosticText(`token=${"hide-me".repeat(4)}`, limit);
    assert.equal(text, "token=[REDACTED]".slice(0, limit));
  }
  assert.deepEqual(sanitizeDiagnosticText(`token=${"hide-me".repeat(4)}`, 16), { text: "token=[REDACTED]", truncated: false });
  assert.deepEqual(sanitizeDiagnosticText(`token=${"hide-me".repeat(4)}`, 15), { text: "token=[REDACTED", truncated: true });
  assert.deepEqual(sanitizeDiagnosticText("x".repeat(9), 8), { text: "x".repeat(8), truncated: true });
  assert.deepEqual(sanitizeDiagnosticText("x".repeat(8), 8), { text: "x".repeat(8), truncated: false });
});

test("awkward text stays cheap, because tool output has no size limit", () => {
  // The sizes are where backtracking rules took from seconds to minutes. Linear rules take milliseconds.
  for (const [name, text] of [
    ["hyphenated keywords", "token-".repeat(1_500)],
    ["a dotted run", "a.".repeat(32_000)],
    ["a base64url blob", "abcdefghijklmnop-".repeat(4_000)],
    ["minified JSON URLs", `"https://example.test/a",`.repeat(16_000)],
  ] as const) {
    const started = performance.now();
    sanitizeDiagnosticText(text, 8192);
    assert.ok(performance.now() - started < 1000, name);
  }
});

test("whole-text private keys are hidden, and an unterminated one hides everything after it", () => {
  for (const kind of ["", "RSA ", "OPENSSH ", "ENCRYPTED "]) {
    assert.equal(
      sanitizeDiagnosticText(`before\n-----BEGIN ${kind}PRIVATE KEY-----\nhide-me\n-----END ${kind}PRIVATE KEY-----\nafter`, 200).text,
      "before\n[REDACTED PRIVATE KEY]\nafter",
    );
  }
  assert.equal(sanitizeDiagnosticText("before\n-----BEGIN PRIVATE KEY-----\nhide-me\nhide-me", 200).text, "before\n[REDACTED PRIVATE KEY]");
  assert.equal(sanitizeDiagnosticText("-----BEGIN\x1b[0m PRIVATE KEY-----\nhide-me", 200).text, "[REDACTED PRIVATE KEY]");
});

/** Every way of splitting the text in two, so a marker gets cut at each position in turn. */
function* splitsOf(text: string) {
  for (let i = 1; i < text.length; i++) yield [text.slice(0, i), text.slice(i)] as const;
}

test("a streamed private key stays hidden wherever its chunks split", () => {
  const stream = "-----BEGIN RSA PRIVATE KEY-----\nhide-me\n-----END RSA PRIVATE KEY-----\nafter\n";
  for (const chunks of [...splitsOf(stream), [...stream]]) {
    const output = new InstallDiagnostics();
    for (const chunk of chunks) output.push(chunk);
    const text = output.snapshot();
    assert.ok(!text.includes("hide-me"), text);
    assert.match(text, /\[REDACTED PRIVATE KEY\] \| \[REDACTED PRIVATE KEY\] \| \[REDACTED PRIVATE KEY\] \| after$/, "output after the key shows again");
  }
});

test("a streamed private key whose marker is split by a control sequence stays hidden", () => {
  const output = new InstallDiagnostics();
  output.push("-----BEGIN\x1b[0m PRIVATE KEY-----\nhide-me\n-----END PRIVATE KEY-----\n");
  assert.ok(!output.snapshot().includes("hide-me"), output.snapshot());
});

test("a streamed private key stays hidden until its end, even across a flush", () => {
  const output = new InstallDiagnostics();
  output.push("-----BEGIN PRIVATE KEY-----\nhide-me");
  output.flush();
  output.push("hide-me\n");
  assert.ok(!output.snapshot().includes("hide-me"), output.snapshot());
  output.push("-----END PRIVATE KEY-----\nafter\n");
  assert.match(output.snapshot(), /after$/);
});

test("the last marker on a line decides whether the next line is key material", () => {
  const reopened = new InstallDiagnostics();
  reopened.push("-----BEGIN PRIVATE KEY-----\nhide-me\n-----END PRIVATE KEY----- -----BEGIN PRIVATE KEY-----\nhide-me\n");
  assert.ok(!reopened.snapshot().includes("hide-me"), reopened.snapshot());
  const closed = new InstallDiagnostics();
  closed.push("-----BEGIN PRIVATE KEY----- hide-me -----END PRIVATE KEY-----\nafter\n");
  assert.ok(!closed.snapshot().includes("hide-me"), closed.snapshot());
  assert.match(closed.snapshot(), /after$/);
});

test("install diagnostics bound each line after redacting it, and mark what they cut", () => {
  const short = new InstallDiagnostics();
  short.push(`token=${"hide-me".repeat(100)}\n`);
  assert.ok(!short.snapshot().includes("truncated"), "the redacted line fits");
  assert.ok(!short.snapshot().includes("hide-me"));
  const long = new InstallDiagnostics();
  long.push(`${"x".repeat(600)} token=hide-me\n`);
  assert.match(long.snapshot(), /\[output truncated\]/);
  assert.ok(long.snapshot().endsWith(`] [output truncated] ${"x".repeat(512)}`), long.snapshot());
});
