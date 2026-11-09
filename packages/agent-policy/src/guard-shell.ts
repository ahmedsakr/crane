import { resolvePath } from "./guard-paths.js";
import { maskCommitMessages, type ShellToken } from "./guard-messages.js";
import type { GuardCommand, GuardContext } from "./guard-types.js";

const SEPARATORS = new Set([";", "\n", "|", "||", "&", "&&", "(", ")", "`"]);
const OPERATORS = new Set(["&&", "||", ">>", ">&", "&>", "<>", ">|", "<<", "<&"]);
// Keep every detected executable here; scanning other words needs no suffix allocation.
const PROGRAMS = new Set([
  "git", "crane", "npm", "npx", "node", "tsx", "curl", "wget", "http", "https",
  "rm", "rmdir", "mv", "cp", "install", "tee", "truncate", "chmod", "chown", "ln", "touch", "mkdir", "sed",
  "sudo", "su", "doas", "pkexec", "dd", "shutdown", "reboot", "halt", "poweroff", "systemctl", "service",
  "launchctl", "crontab", "mount", "umount", "iptables", "nft", "kill", "killall", "pkill",
  "pnpm", "yarn", "bun", "cargo", "twine", "gem", "docker", "gh", "vercel", "netlify", "fly", "terraform",
  "kubectl", "aws", "gcloud", "az", "pip", "pip3", "apt", "apt-get", "yum", "dnf", "pacman", "brew",
  "ssh", "scp", "sftp", "rsync", "nc", "ncat", "socat",
]);

export function executable(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

interface Lexer {
  tokens: ShellToken[];
  word: string;
  started: boolean;
  quote: string | null;
  start: number;
}

function flush(state: Lexer, end: number): void {
  if (state.started) state.tokens.push({ value: state.word, start: state.start, end, operator: false });
  state.word = "";
  state.started = false;
}

function punctuation(raw: string, index: number, state: Lexer): number {
  let descriptor = "";
  if (/[<>]/.test(raw[index]!) && /^\d+$/.test(state.word)) {
    descriptor = state.word;
    state.word = "";
    state.started = false;
  }
  flush(state, index);
  if (raw.slice(index, index + 3) === "<<<") {
    state.tokens.push({ value: descriptor + "<<<", start: index, end: index + 3, operator: true });
    return index + 2;
  }
  const pair = raw.slice(index, index + 2);
  if (OPERATORS.has(pair)) {
    state.tokens.push({ value: descriptor + pair, start: index, end: index + 2, operator: true });
    return index + 1;
  }
  state.tokens.push({ value: descriptor + raw[index]!, start: index, end: index + 1, operator: true });
  return index;
}

/** Two views retain real path arguments and also inspect quoted text as commands. */
function tokens(raw: string, quoted: boolean): ShellToken[] {
  const state: Lexer = { tokens: [], word: "", started: false, quote: null, start: 0 };
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (!state.started) state.start = i;
    if (char === "\\" && state.quote !== "'" && i + 1 < raw.length) {
      const next = raw[++i]!;
      if (next !== "\n") state.word += next;
      state.started = true;
    } else if (state.quote) {
      if (char === state.quote) state.quote = null;
      else state.word += char;
    } else if (char === "'" || char === '"') {
      if (quoted) state.quote = char;
      state.started = true;
    } else if (/[;|&()<>\n`]/.test(char)) {
      i = punctuation(raw, i, state);
    } else if (/\s/.test(char)) {
      flush(state, i);
    } else {
      state.word += char;
      state.started = true;
    }
  }
  flush(state, raw.length);
  return state.tokens;
}

/** Only proven literal arguments to a direct git commit are data in both views. */
export function shellInspectionText(raw: string): string {
  return maskCommitMessages(raw, tokens(raw, true));
}

function nextDirectory(words: string[], cwd: string | null, ctx: GuardContext): string | null {
  const index = words.findIndex((word) => executable(word) === "cd");
  if (index < 0) return cwd;
  // Embedded shell text is ambiguous; don't let it establish a trusted directory.
  if (index !== 0) return null;
  const args = words.slice(1).filter((word) => word !== "--");
  const target = args[0] ?? ctx.home;
  if (!target || target === "-" || args.length > 1) return null;
  return resolvePath(target, cwd, ctx);
}

/**
 * Every stage of a pipeline starts in the directory the pipeline started in.
 * Only the command after a pipeline that changed directory is ambiguous, since
 * zsh runs the last stage in the current shell.
 */
interface Pipeline {
  start: string | null;
  moved: boolean;
  piped: boolean;
}

function afterSeparator(token: string, cwd: string | null, pipe: Pipeline): string | null {
  if (token === "|") {
    pipe.piped = true;
    return pipe.start;
  }
  const next = pipe.moved && pipe.piped ? null : cwd;
  pipe.moved = false;
  pipe.piped = false;
  // A cd on either side of these operators may not affect the next command.
  return token === "||" || token === "&" ? null : next;
}

function scanTokens(input: string[], ctx: GuardContext): GuardCommand[] {
  const out: GuardCommand[] = [];
  const stack: (string | null)[] = [];
  let cwd: string | null = ctx.worktree;
  const pipe: Pipeline = { start: cwd, moved: false, piped: false };
  let words: string[] = [];
  for (const token of [...input, ";"]) {
    if (!SEPARATORS.has(token)) {
      words.push(token);
      continue;
    }
    if (words.length) {
      out.push({ words, text: words.join(" "), cwd });
      const next = nextDirectory(words, cwd, ctx);
      if (next !== cwd) pipe.moved = true;
      cwd = next;
      words = [];
    }
    if (token === "(") stack.push(cwd);
    if (token === ")") cwd = stack.length ? stack.pop()! : null;
    cwd = afterSeparator(token, cwd, pipe);
    if (token !== "|") pipe.start = cwd;
  }
  return out;
}

export function scanCommands(raw: string, ctx: GuardContext): GuardCommand[] {
  const literal = tokens(raw, true).map((token) => token.value);
  const loose = tokens(raw, false).map((token) => token.value);
  const parts = scanTokens(literal, ctx);
  if (literal.length === loose.length && literal.every((word, index) => word === loose[index])) return parts;
  return [...parts, ...scanTokens(loose, ctx)];
}

/** Scan at every word, including strings, heredocs, substitutions and wrapper arguments. */
export function candidates(part: GuardCommand): GuardCommand[] {
  const out: GuardCommand[] = [];
  for (let i = 0; i < part.words.length; i++) {
    const program = executable(part.words[i]!);
    if (!PROGRAMS.has(program) && !program.startsWith("mkfs")) continue;
    const words = part.words.slice(i);
    out.push({ words, text: words.join(" "), cwd: part.cwd });
  }
  return out;
}
