import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing and token digests for operator sign-in. Agents can read
 * $CRANE_HOME, so nothing here stores or logs a plaintext password or token:
 * passwords are kept as scrypt hashes and tokens only as SHA-256 digests.
 */

const COST = { N: 2 ** 15, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// Hashes we wrote never ask for more; anything above this is refused rather than allocated.
const MAX_N = 2 ** 20;

type EncodedHash = { algo: "scrypt"; N: number; r: number; p: number; salt: string; hash: string };

/** scrypt needs about 128·N·r bytes, which at N=2^15 is exactly Node's 32 MiB default. */
const maxmem = (params: { N: number; r: number }) => 128 * params.N * params.r * 2;

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: maxmem(params) };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, KEY_BYTES, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, COST);
  const encoded: EncodedHash = { algo: "scrypt", ...COST, salt: salt.toString("base64"), hash: hash.toString("base64") };
  return JSON.stringify(encoded);
}

function parseHash(encoded: string): EncodedHash | null {
  try {
    const parsed = JSON.parse(encoded) as Partial<EncodedHash>;
    const { N, r, p } = parsed;
    if (parsed.algo !== "scrypt" || typeof parsed.salt !== "string" || typeof parsed.hash !== "string") return null;
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
    if (N! < 2 || N! > MAX_N || (N! & (N! - 1)) !== 0 || r! < 1 || r! > 32 || p! < 1 || p! > 16) return null;
    return parsed as EncodedHash;
  } catch {
    return null;
  }
}

/** Compares in constant time. A malformed hash never matches. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const stored = parseHash(encoded);
  if (!stored) return false;
  const expected = Buffer.from(stored.hash, "base64");
  if (expected.length !== KEY_BYTES) return false;
  const actual = await derive(password, Buffer.from(stored.salt, "base64"), stored);
  return timingSafeEqual(actual, expected);
}

// A well-formed hash nobody's password matches, so checking it costs what checking a real one does.
const DUMMY_HASH = JSON.stringify({
  algo: "scrypt", ...COST, salt: Buffer.alloc(SALT_BYTES, 1).toString("base64"), hash: Buffer.alloc(KEY_BYTES).toString("base64"),
} satisfies EncodedHash);

/** Spends one password check's time, so an unknown username answers as slowly as a wrong password. */
export async function dummyVerify(): Promise<void> {
  await verifyPassword("not a password", DUMMY_HASH);
}

/** 32 random bytes, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the store keeps instead of a token. */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
