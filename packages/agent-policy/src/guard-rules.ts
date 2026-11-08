import { executable } from "./guard-shell.js";
import type { GuardCategory, GuardCommand } from "./guard-types.js";

export const GUARD_REASONS: Record<GuardCategory, string> = {
  "deny-list": "This command is on Crane's permanent deny list and cannot be allowed.",
  "shared-git": "Changing shared Git state is Crane's job and requires the operator's approval.",
  "outside-worktree": "Writing outside the task worktree and temporary directories is blocked to protect the operator's files.",
  "operator-actions": "Changing Crane's state is reserved for the operator.",
  "agent-config": "Changing agent settings or hooks is blocked to preserve Crane's permission controls.",
  privilege: "Privilege escalation is blocked because agents must keep their existing permissions.",
  system: "Changing system services, devices or processes is blocked to protect the host.",
  credentials: "Accessing or transmitting host credentials is blocked to protect the operator's accounts.",
  "remote-code": "Executing downloaded or concealed code is blocked because its contents cannot be checked by the command guard.",
  publish: "Publishing or changing remote resources requires an operator rule for this repository.",
  "global-install": "Installing software outside the project requires an operator rule for this repository.",
  "remote-shell": "Remote connections require an operator rule for this repository.",
};

export function machineCategory(words: string[]): GuardCategory | null {
  const program = executable(words[0] ?? "");
  if (["sudo", "su", "doas", "pkexec"].includes(program)) return "privilege";
  if (/^mkfs/.test(program)) return "system";
  if (["shutdown", "reboot", "halt", "poweroff", "systemctl", "service", "launchctl", "crontab", "mount", "umount", "iptables", "nft", "killall", "pkill"].includes(program)) return "system";
  if (program === "dd" && words.some((word) => /^of=\/dev\//.test(word))) return "system";
  if (program === "kill" && words.slice(1).some((word) => word === "-1" || word === "0")) return "system";
  return null;
}

function ghPublish(args: string[]): boolean {
  if (args.some((arg) => ["release", "repo", "secret"].includes(arg))) return true;
  if (args.includes("pr")) return args.some((arg) => ["create", "merge"].includes(arg));
  if (!args.includes("api")) return false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === "-X" || arg === "--method") && args[i + 1]?.toUpperCase() !== "GET") return true;
    const method = /^(?:-X|--method=)(.+)$/.exec(arg);
    if (method && method[1]!.toUpperCase() !== "GET") return true;
    if (/^(?:-[fF]|--(?:raw-)?field)(?:.|$)/.test(arg) && !args.includes("GET")) return true;
  }
  return false;
}

function publishes(program: string, args: string[]): boolean {
  if (["aws", "gcloud", "az"].includes(program)) return true;
  if (["npm", "pnpm", "yarn", "bun"].includes(program) && args.includes("publish")) return true;
  if (program === "npm" && args.some((arg) => ["login", "adduser", "token"].includes(arg))) return true;
  if (program === "gh") return ghPublish(args);
  const commands: Record<string, string[]> = {
    cargo: ["publish"], twine: ["upload"], gem: ["push"], docker: ["push"],
    vercel: ["deploy"], netlify: ["deploy"], fly: ["deploy"],
    terraform: ["apply", "destroy"], kubectl: ["apply", "delete", "exec"],
  };
  return args.some((arg) => commands[program]?.includes(arg));
}

function globalInstall(program: string, args: string[]): boolean {
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    const install = args.some((arg) => ["install", "i", "add"].includes(arg));
    return install && args.some((arg) => arg === "--global" || arg === "global" || /^-[a-zA-Z]*g/.test(arg));
  }
  if (program === "pip" || program === "pip3") {
    return args.includes("install") && args.some((arg) => /^(?:--user|--break-system-packages)(?:=|$)/.test(arg));
  }
  return ["apt", "apt-get", "yum", "dnf", "pacman", "brew"].includes(program)
    && args.some((arg) => arg === "install" || (program === "pacman" && /^-[a-zA-Z]*S/.test(arg)));
}

export function outwardCategory(words: string[]): GuardCategory | null {
  const program = executable(words[0] ?? "");
  const args = words.slice(1);
  if (publishes(program, args)) return "publish";
  if (globalInstall(program, args)) return "global-install";
  if (["ssh", "scp", "sftp", "nc", "ncat", "socat"].includes(program)) return "remote-shell";
  if (program === "rsync" && args.some((arg) => /^(?:[^/:\s]+@)?(?:\[[^\]]+\]|[^/:\s]+):/.test(arg))) return "remote-shell";
  return null;
}

export function concealedCode(raw: string, parts: GuardCommand[]): boolean {
  const words = parts.flatMap((part) => part.words).map(executable);
  if (words.includes("eval") && (raw.includes("$(") || raw.includes("`"))) return true;
  const network = words.some((word) => word === "curl" || word === "wget");
  const shell = words.some((word) => ["sh", "bash", "zsh", "python", "python3", "node", "perl"].includes(word));
  const decoded = words.includes("base64") && words.some((word) => /^-[a-zA-Z]*d/.test(word) || word === "--decode");
  return shell && ((network && (raw.includes("|") || /<\s*\(/.test(raw))) || (decoded && raw.includes("|")));
}

export function sendsEnvironment(parts: GuardCommand[]): boolean {
  const words = parts.flatMap((part) => part.words).map(executable);
  return words.some((word) => word === "env" || word === "printenv")
    && words.some((word) => ["curl", "wget", "http", "https", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "socat"].includes(word));
}
