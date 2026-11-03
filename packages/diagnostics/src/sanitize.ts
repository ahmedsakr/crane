/** A shell word: quoted, escaped, or bare. Quoted parts may span lines. */
const SHELL_WORD = String.raw`(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|[^\s;&|"'\\])+`;
/**
 * A whole run of key characters containing a sensitive word. Tool output is unbounded, so it's
 * tried once per run: starting inside a run, or wrapping the word in `[\w.-]*` on both sides,
 * took seconds on 4 KB of `token-token-`.
 */
const SENSITIVE_KEY = String.raw`(?<![\w.-])(?=[\w.-]*(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|_auth|authorization|cookie))[\w.-]+`;
const HEADER = String.raw`(?:Authorization|Cookie|Set-Cookie)\s*:`;

const CONTROL_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** Everything but tab and newline. A lone carriage return must not end a line early for the rules below. */
const CONTROL_CHARACTER = /[\x00-\x08\x0b-\x1f\x7f]/g;
/** An unterminated block is hidden to the end of the text. */
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g;
const QUOTED_HEADER = new RegExp(String.raw`"${HEADER}(?:\\[\s\S]|[^"\\])*"|'${HEADER}[^']*'`, "gi");
const USER_OPTION = new RegExp(String.raw`((?:--user|-u)(?:\s+|=))(?:${SHELL_WORD})?\S*`, "g");
const AUTH_SCHEME = /\b(Bearer|Basic)\s+\S+/gi;
/** The value, which may be quoted across lines, then the rest of its line: prose doesn't say where a secret ends. */
const SENSITIVE_VALUE = new RegExp(String.raw`(${SENSITIVE_KEY}["']?\s*(?:[:=]|\s)\s*)(?:${SHELL_WORD})?[^\n]*`, "gi");
const URL_USERINFO = /((?:git\+)?https?:\/\/)[^\s/]*@/gi;
/** The suffix is optional so a URL without one still consumes its word, rather than each URL in minified JSON rescanning the rest. */
const URL_SUFFIX = /((?:git\+)?https?:\/\/[^\s?#]+)([?#]\S*)?/gi;

/**
 * Best-effort redaction of credentials in text about to be stored or shown. It
 * reduces accidental exposure and is not a security boundary.
 *
 * Control sequences go first, so they can't split what the rules look for, and
 * the limit applies last, so it can't cut a secret away from its key. Newlines
 * and tabs survive. Text arriving in pieces is the caller's to reassemble,
 * including tracking a private key that spans several calls.
 */
export function sanitizeDiagnosticText(raw: string, limit: number): { text: string; truncated: boolean } {
  const redacted = raw
    .replace(CONTROL_SEQUENCE, "")
    .replace(/\r\n/g, "\n")
    .replace(CONTROL_CHARACTER, " ")
    .replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]")
    .replace(QUOTED_HEADER, "'[REDACTED HEADER]'")
    .replace(USER_OPTION, "$1[REDACTED]")
    .replace(AUTH_SCHEME, "$1 [REDACTED]")
    .replace(SENSITIVE_VALUE, "$1[REDACTED]")
    .replace(URL_USERINFO, "$1[REDACTED]@")
    .replace(URL_SUFFIX, (match, url: string, suffix?: string) => (suffix === undefined ? match : `${url}?[REDACTED]`));
  return { text: redacted.slice(0, limit), truncated: redacted.length > limit };
}
