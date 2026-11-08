import { resolvePath } from "./guard-paths.js";
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
  tokens: string[];
  word: string;
  started: boolean;
  quote: string | null;
}

function flush(state: Lexer): void {
  if (state.started) state.tokens.push(state.word);
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
  flush(state);
  if (raw.slice(index, index + 3) === "<<<") {
    state.tokens.push(descriptor + "<<<");
    return index + 2;
  }
  const pair = raw.slice(index, index + 2);
  if (OPERATORS.has(pair)) {
    state.tokens.push(descriptor + pair);
    return index + 1;
  }
  state.tokens.push(descriptor + raw[index]!);
  return index;
}

/** Two views retain real path arguments and also inspect quoted text as commands. */
function tokens(raw: string, quoted: boolean): string[] {
  const state: Lexer = { tokens: [], word: "", started: false, quote: null };
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
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
      flush(state);
    } else {
      state.word += char;
      state.started = true;
    }
  }
  flush(state);
  return state.tokens;
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

function scanTokens(input: string[], ctx: GuardContext): GuardCommand[] {
  const out: GuardCommand[] = [];
  const stack: (string | null)[] = [];
  let cwd: string | null = ctx.worktree;
  let words: string[] = [];
  for (const token of [...input, ";"]) {
    if (!SEPARATORS.has(token)) {
      words.push(token);
      continue;
    }
    if (words.length) {
      out.push({ words, text: words.join(" "), cwd });
      cwd = nextDirectory(words, cwd, ctx);
      words = [];
    }
    if (token === "(") stack.push(cwd);
    if (token === ")") cwd = stack.length ? stack.pop()! : null;
    // A cd on either side of these operators may not affect the next command.
    if (token === "||" || token === "|" || token === "&") cwd = null;
  }
  return out;
}

export function scanCommands(raw: string, ctx: GuardContext): GuardCommand[] {
  const literal = tokens(raw, true);
  const loose = tokens(raw, false);
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
