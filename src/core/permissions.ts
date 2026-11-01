/**
 * Claude Code permission rules, as Crane reads and suggests them.
 *
 * A rule is a tool name, optionally with a pattern: `Read`, `Bash(npm ci:*)`.
 * For Bash, `prefix:*` matches any command that starts with `prefix`. Every
 * command in a pipeline or `&&` chain must be allowed, or the whole call is
 * refused, so a denial can need more than one rule.
 */

import { parseRule } from "@crane/contracts/rules";

/** Commands whose first word alone says too little to allow (`npm` could be anything). */
const SUBCOMMAND_TOOLS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "git",
  "cargo",
  "go",
  "docker",
  "make",
  "pip",
  "pip3",
  "poetry",
  "uv",
  "bundle",
  "gradle",
  "mvn",
  "dotnet",
  "deno",
  "kubectl",
  "gh",
]);

/** Interpreters run arbitrary code. Suggest the narrow form (`python3 -m pytest`) or nothing. */
const INTERPRETERS = new Set(["python", "python3", "ruby", "perl", "bash", "sh", "zsh", "node"]);

/** Split a shell command into the simple commands Claude Code checks one by one. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += c + command[++i];
    } else if (c === "\n" || c === ";" || (c === "|" && command[i + 1] !== "|") || (c === "&" && command[i + 1] !== "&")) {
      // `2>&1` and `&>` are redirections, not separators.
      if (c === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
        cur += c;
        continue;
      }
      out.push(cur);
      cur = "";
    } else if ((c === "&" || c === "|") && command[i + 1] === c) {
      out.push(cur);
      cur = "";
      i++;
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out
    .map((s) =>
      s
        .trim()
        // Leading `VAR=value` assignments and trailing redirections don't change what runs.
        .replace(/^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, "")
        .replace(/\s+\d?>>?\s*\S+$/, "")
        .replace(/\s+\d?>&\d$/, "")
        .trim(),
    )
    .filter(Boolean);
}

/** Does `rule` allow this one simple Bash command? */
function bashRuleAllows(pattern: string | null, command: string): boolean {
  if (pattern === null || pattern === "*" || pattern === ":*") return true;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return command === prefix || command.startsWith(prefix + " ");
  }
  if (pattern.endsWith("*")) return command.startsWith(pattern.slice(0, -1));
  return command === pattern;
}

/** Is this tool call covered by any of the rules? For Bash, every part of the command must be. */
export function isAllowed(rules: string[], tool: string, input: Record<string, unknown>): boolean {
  const parsed = rules.map(parseRule).filter((r) => r && r.tool === tool) as { tool: string; pattern: string | null }[];
  if (!parsed.length) return false;
  if (tool !== "Bash") return parsed.some((r) => r.pattern === null);
  const parts = splitCommand(typeof input.command === "string" ? input.command : "");
  return parts.length > 0 && parts.every((p) => parsed.some((r) => bashRuleAllows(r.pattern, p)));
}

/** The narrowest rule worth suggesting for one simple command, e.g. `npm ci --silent` → `Bash(npm ci:*)`. */
export function ruleForCommand(command: string): string | null {
  const words = command.split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first || /[`$(){}<>]/.test(first)) return null;
  if (first === "cd") return null; // Claude Code allows cd within the working directory on its own.
  let take = 1;
  if (INTERPRETERS.has(first)) {
    // `python3 -m pytest` is a tool; `python3 script.py` or `node -e` is arbitrary code.
    if (words[1] === "-m" && words[2]) take = 3;
    else return null;
  } else if (SUBCOMMAND_TOOLS.has(first) && words[1] && !words[1].startsWith("-")) {
    take = 2;
    if ((first === "npm" || first === "pnpm" || first === "yarn" || first === "bun") && words[1] === "run" && words[2]) take = 3;
  }
  const prefix = words.slice(0, take).join(" ");
  if (/[`$]/.test(prefix)) return null;
  return `Bash(${prefix}:*)`;
}

/**
 * Rules that would have let this call through, given what was already
 * allowed. Empty when Crane has nothing safe to suggest.
 */
export function suggestRules(tool: string, input: Record<string, unknown>, allowed: string[]): string[] {
  if (tool !== "Bash") return /^[A-Za-z_][\w-]*$/.test(tool) ? [tool] : [];
  const command = typeof input.command === "string" ? input.command : "";
  // This splitter is not a shell parser: heredoc bodies and terminators are
  // data, not commands. Don't turn their lines into permission suggestions,
  // or claim a prefix grant can resolve Claude Code's shell security checks.
  // Conservatively include here-strings and quoted occurrences of `<<`.
  if (command.includes("<<")) return [];
  const out: string[] = [];
  for (const part of splitCommand(command)) {
    if (isAllowed(allowed, "Bash", { command: part })) continue;
    const rule = ruleForCommand(part);
    if (!rule) return []; // One part we can't name means no suggestion would make the call work.
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

/** Would allowing `rule` let through anything one of `denied` blocks? */
export function overlapsDenied(rule: string, denied: string[]): boolean {
  const r = parseRule(rule);
  if (!r) return true;
  return denied.some((d) => {
    const x = parseRule(d);
    if (!x || x.tool !== r.tool) return false;
    if (r.pattern === null || x.pattern === null) return true;
    if (r.tool !== "Bash") return r.pattern === x.pattern;
    // Compare the literal prefixes: one containing the other means they overlap.
    const a = r.pattern.replace(/:?\*$/, "");
    const b = x.pattern.replace(/:?\*$/, "");
    return a === b || a.startsWith(b + " ") || b.startsWith(a + " ") || a === "" || b === "";
  });
}
