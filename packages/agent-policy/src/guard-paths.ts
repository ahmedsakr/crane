import type { GuardCategory, GuardCommand, GuardContext } from "./guard-types.js";

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

export function within(path: string, root: string): boolean {
  const base = normalizePath(root);
  return path === base || path.startsWith(base === "/" ? base : base + "/");
}

export function resolvePath(target: string, cwd: string | null, ctx: GuardContext): string | null {
  let path = target;
  if (/^~(?:\/|$)/.test(path)) path = ctx.home === null ? "$UNKNOWN" : ctx.home + path.slice(1);
  path = path.replace(/\$\{HOME\}|\$HOME\b/g, ctx.home ?? "$UNKNOWN");
  if (!path || /[$`\n]/.test(path) || path.startsWith("~")) return null;
  if (path.startsWith("/")) return normalizePath(path);
  if (cwd === null) return null;
  return normalizePath(cwd + "/" + path);
}

function agentConfig(path: string): boolean {
  return /(?:^|\/)\.(?:claude|codex)(?:\/|$)/.test(path) || /(?:^|\/)\.mcp\.json(?:\/|$)/.test(path);
}

export function writeCategory(target: string, cwd: string | null, ctx: GuardContext): GuardCategory | null {
  const path = resolvePath(target, cwd, ctx);
  if (agentConfig(target) || (path !== null && agentConfig(path))) return "agent-config";
  if (path === null) return "outside-worktree";
  if (/(?:^|\/)\.git(?:\/|$)/.test(path)) return "shared-git";
  if (within(path, ctx.craneHome) && !within(path, ctx.worktree)) return "operator-actions";
  if (within(path, ctx.worktree) || within(path, "/tmp") || within(path, "/var/tmp")) return null;
  return "outside-worktree";
}

const VALUE_OPTIONS: Record<string, string[]> = {
  cp: ["-t", "--target-directory", "-S", "--suffix"],
  mv: ["-t", "--target-directory", "-S", "--suffix"],
  install: ["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"],
  ln: ["-t", "--target-directory", "-S", "--suffix"],
  touch: ["-d", "--date", "-t", "-r", "--reference"],
  mkdir: ["-m", "--mode", "-Z", "--context"],
  truncate: ["-s", "--size", "-r", "--reference"],
  chmod: ["--reference"],
  chown: ["--reference", "--from"],
};

function operands(args: string[], program: string): string[] {
  const out: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--" && options) options = false;
    else if (options && VALUE_OPTIONS[program]?.includes(arg)) i++;
    else if (options && program === "chmod" && /^-[rwxXstugo,+-=]+$/.test(arg)) out.push(arg);
    else if (!options || !arg.startsWith("-")) out.push(arg);
  }
  return out;
}

function destination(args: string[], program: string): string[] {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "-t" || arg === "--target-directory") return [args[i + 1] ?? "$UNKNOWN"];
    if (arg.startsWith("--target-directory=")) return [arg.slice(19)];
    if (arg.startsWith("-t") && arg.length > 2) return [arg.slice(2)];
  }
  const paths = operands(args, program);
  if (program === "install" && args.some((arg) => arg === "-d" || arg === "--directory")) return paths;
  if (program === "ln" && paths.length === 1) return ["."];
  return paths.slice(-1);
}

function sedTargets(args: string[]): string[] {
  if (!args.some((arg) => arg.startsWith("--in-place") || /^-[a-zA-Z]*i/.test(arg))) return [];
  const files: string[] = [];
  let script = false;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--" && options) options = false;
    else if (options && ["-e", "--expression", "-f", "--file"].includes(arg)) {
      script = true;
      i++;
    } else if (options && /^(-[ef].+|--(?:expression|file)=)/.test(arg)) script = true;
    else if (options && arg.startsWith("-")) continue;
    else if (!script) script = true;
    else files.push(arg);
  }
  return files;
}

const REDIRECTIONS = new Set([">", ">>", "&>", ">&", "<", "<>", ">|", "<<", "<<<", "<&"]);

function redirection(word: string): string {
  return word.replace(/^\d+/, "");
}

function withoutRedirects(words: string[]): string[] {
  const args: string[] = [];
  for (let i = 1; i < words.length; i++) {
    if (REDIRECTIONS.has(redirection(words[i]!))) i++;
    else args.push(words[i]!);
  }
  return args;
}

export function writeTargets(words: string[]): string[] {
  const program = words[0]?.split("/").pop() ?? "";
  const args = withoutRedirects(words);
  if (["cp", "install", "ln"].includes(program)) return destination(args, program);
  if (program === "mv") return [...operands(args, program), ...destination(args, program)];
  if (program === "sed") return sedTargets(args);
  if (!["rm", "rmdir", "tee", "truncate", "chmod", "chown", "touch", "mkdir"].includes(program)) return [];
  const paths = operands(args, program);
  if ((program === "chmod" || program === "chown") && !args.some((arg) => arg.startsWith("--reference"))) return paths.slice(1);
  return paths;
}

export function redirectTargets(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = redirection(words[i]!);
    if (![">", ">>", "&>", ">&", "<>", ">|"].includes(word)) continue;
    const target = words[i + 1] ?? "$UNKNOWN";
    if (word === ">&" && /^(?:\d+|-)$/.test(target)) continue;
    out.push(target);
  }
  return out;
}

export function credentialPath(word: string, part: GuardCommand, ctx: GuardContext): boolean {
  const path = resolvePath(word.replace(/^[@=]/, ""), part.cwd, ctx);
  if (path && ctx.home && within(path, ctx.home)) {
    const relative = path.slice(normalizePath(ctx.home).length);
    return /^\/\.(?:ssh|aws|gnupg|netrc|npmrc|pypirc|kube|codex)(?:\/|$)/.test(relative)
      || /^\/\.claude[^/]*(?:\/|$)/.test(relative)
      || /^\/\.(?:config\/gh|docker\/config\.json)(?:\/|$)/.test(relative);
  }
  return /^(?:~|\$HOME|\$\{HOME\})\/\.(?:ssh|aws|gnupg|netrc|npmrc|pypirc|kube|claude[^/]*|codex|config\/gh|docker\/config\.json)(?:\/|$)/.test(word);
}
