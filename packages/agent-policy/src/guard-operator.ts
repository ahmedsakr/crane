import { executable } from "./guard-shell.js";
import { normalizePath } from "./guard-paths.js";

function craneArguments(words: string[]): string[] | null {
  const program = executable(words[0] ?? "");
  if (program === "crane") return words.slice(1);
  if (program === "npm") {
    const run = words.indexOf("run");
    if (run > 0 && words[run + 1] === "crane") return words.slice(run + 2);
  }
  if (program === "npx") {
    const crane = words.indexOf("crane");
    if (crane > 0) return words.slice(crane + 1);
  }
  if (program === "node" || program === "tsx") {
    const entry = words.findIndex((word) => /\/(?:bin\/crane\.js|src\/cli\/index\.ts)$/.test(normalizePath(word)));
    if (entry > 0) return words.slice(entry + 1);
  }
  return null;
}

export function operatorCli(words: string[]): boolean {
  const args = craneArguments(words);
  if (args === null || args.some((arg) => arg === "--help" || arg === "-h")) return false;
  const commands = args.filter((arg) => arg !== "--");
  const [subcommand, child] = commands;
  if (!subcommand || subcommand === "--version" || subcommand === "-V") return false;
  if (["tasks", "show", "blocked", "diff", "analytics", "watch"].includes(subcommand)) return false;
  if (subcommand === "repos" && (!child || child === "list" || child.startsWith("-"))) return false;
  if (subcommand === "goals" && ["list", "show"].includes(child ?? "")) return false;
  return true;
}

function localApi(word: string): boolean {
  const url = /^(?:https?:\/\/)?(?:[^/@\s]+@)?(?:localhost\.?|127\.0\.0\.1|\[::1\])(?::\d+)?(\/[^?#]*)/i.exec(word);
  if (!url) return false;
  try {
    const path = normalizePath(decodeURIComponent(url[1]!));
    return path === "/api" || path.startsWith("/api/");
  } catch {
    return true;
  }
}

function nonGetOption(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["-X", "--request", "--method"].includes(arg) && args[i + 1]?.toUpperCase() !== "GET") return true;
    const method = /^(?:-X|--request=|--method=)(.+)$/.exec(arg);
    if (method && method[1]!.toUpperCase() !== "GET") return true;
    if (/^(?:-[dFT]|--data|--form|--json|--upload-file|--post-|--body-)/.test(arg)) return true;
    // curl accepts short-option clusters such as -sSfX POST or -sfd payload.
    if (/^-[a-zA-Z]*[dFT]/.test(arg)) return true;
    const cluster = /^-[a-zA-Z]*?X(.*)$/.exec(arg);
    if (cluster && (cluster[1] || args[i + 1])?.toUpperCase() !== "GET") return true;
  }
  return false;
}

export function operatorHttp(words: string[]): boolean {
  const program = executable(words[0] ?? "");
  if (!["curl", "wget", "http", "https"].includes(program) || !words.some(localApi)) return false;
  if (program === "curl" || program === "wget") return nonGetOption(words.slice(1));
  const method = words.find((word) => /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)$/i.test(word));
  if (method) return method.toUpperCase() !== "GET";
  return words.some((word) => /^[^=]+=[^=]/.test(word));
}
