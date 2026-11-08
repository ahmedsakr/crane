import { credentialPath } from "./guard-paths.js";
import { inspectionCommands } from "./guard-inspect-shell.js";
import { readOperands, READ_OPTIONS } from "./guard-inspect-options.js";
import type { GuardContext } from "./guard-types.js";

const FIND_FLAGS = new Set("-H -L -P -daystart -depth -follow -mount -xdev -ignore_readdir_race -noignore_readdir_race -true -false -empty -readable -writable -executable -nouser -nogroup -prune -print -print0 -ls -quit -a -and -o -or -not ! ( )".split(" "));
const FIND_VALUES = new Set("-name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -size -user -group -uid -gid -perm -links -inum -samefile -newer -anewer -cnewer -newermt -mtime -mmin -atime -amin -ctime -cmin -mindepth -maxdepth -printf".split(" "));

function find(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (FIND_VALUES.has(arg)) { if (args[++i] === undefined) return false; }
    else if (!FIND_FLAGS.has(arg) && (arg.startsWith("-") || arg === "+")) return false;
  }
  return true;
}

function sed(args: string[]): boolean {
  // No external script files, execution, reads or writes. Keep the accepted
  // script grammar small: addressed print/delete/quit/line-number commands.
  const operands = readOperands(args, "-n --quiet --silent -E -r --regexp-extended");
  if (!operands?.length || !args.some((arg) => arg === "--quiet" || arg === "--silent" || /^-[nEr]*n[nEr]*$/.test(arg))) return false;
  return operands[0]!.split(";").every((command) => /^\s*(?:\d+|\$)?(?:,(?:\d+|\$))?[pdq=]\s*$/.test(command));
}

function awk(args: string[]): boolean {
  const operands = readOperands(args, "", "-F -v");
  if (!operands?.length) return false;
  // getline can read paths embedded in the program, and @load/@include load
  // unchecked code. Backslashes could conceal those tokens in gawk source.
  return !/[<>|@\\]/.test(operands[0]!) && !/\b(?:system|getline)\b/.test(operands[0]!);
}

const GIT_FLAGS = "--no-pager --no-optional-locks --oneline --all --graph --decorate --no-decorate --stat --shortstat --numstat --name-only --name-status --check --raw --patch --no-patch --full-index --binary --relative --reverse --no-merges --merges --first-parent --follow --abbrev-commit --no-abbrev-commit --no-color --color --no-ext-diff --no-textconv -p -s -u -w -b -z --cached --staged --exit-code --quiet --short --porcelain --branch --ignored --untracked-files --show-toplevel --show-prefix --show-cdup --git-dir --is-inside-work-tree --verify --abbrev-ref --symbolic-full-name --exclude-standard --others --modified --deleted --full-name --long --object-only --count --left-right --boundary --invert-grep --regexp-ignore-case --extended-regexp --fixed-strings --perl-regexp --no-index -a -r -t -c -e -l -n -f -v -i -I -o -h -H -L --contains --no-contains --merged --no-merged --list --remotes --verbose --tags --always --dirty --broken --octopus --independent --is-ancestor --batch --batch-check --batch-all-objects --buffer -d";
const GIT_VALUES = "-n -U --max-count --skip --since --until --after --before --author --committer --grep --format --pretty --date --diff-filter --find-renames --find-copies --abbrev --max-depth --sort --points-at --exclude --glob --branches --remotes --tags -G -S -e -L";
const GIT_READ = new Set("log show diff status blame rev-parse ls-files ls-tree grep describe merge-base cat-file for-each-ref shortlog".split(" "));

function git(args: string[]): boolean {
  let i = 0;
  while (args[i] === "--no-pager" || args[i] === "--no-optional-locks") i++;
  // Never approve -c/--config-env, alternate executables or arbitrary Git
  // directory settings. The base guard still checks shared Git state first.
  if (args[i] === "-C") i += 2;
  const subcommand = args[i++];
  const rest = args.slice(i);
  if (subcommand === "remote") return rest.length === 1 && ["-v", "--verbose"].includes(rest[0]!);
  if (subcommand === "branch") {
    if (!rest.some((arg) => ["--list", "-a", "-r", "--all", "--remotes"].includes(arg))) return false;
    const operands = readOperands(rest, "--list -a -r --all --remotes -v --verbose --no-color", "--sort --format");
    return operands !== null && (!operands.length || rest.includes("--list"));
  }
  // Unlike log's -n <count>, shortlog's -n is a flag (sort by count).
  if (subcommand === "shortlog") return readOperands(rest, "-s -n -e -c --summary --numbered --email --committer --no-merges --all", "--group --format --author --since --until") !== null;
  if (!subcommand || !GIT_READ.has(subcommand)) return false;
  return readOperands(rest, GIT_FLAGS, GIT_VALUES) !== null;
}

function npm(args: string[]): boolean {
  if (args[0] === "ls" || args[0] === "view") {
    return readOperands(args.slice(1), "--json --all --long --parseable --global -g --silent", "--depth --workspace -w") !== null;
  }
  if (args.slice(0, 4).join(" ") !== "run --silent crane --") return false;
  const command = args[4];
  if (!command || !["tasks", "show", "blocked", "repos", "diff"].includes(command) || !args.includes("--json", 5)) return false;
  const operands = readOperands(args.slice(5), "--json --all -a", "-r --repo -s --status -n --limit");
  if (!operands) return false;
  if (command === "repos") return !operands.length || (operands.length === 1 && operands[0] === "list");
  return command === "show" || command === "diff" ? operands.length === 1 : !operands.length;
}

function readOnly(words: string[]): boolean {
  const [program, ...args] = words;
  // Custom executables in the checkout must not inherit a system tool's approval.
  if (!program || program.includes("/")) return false;
  if (program === "find") return find(args);
  if (program === "sed") return sed(args);
  if (program === "awk") return awk(args);
  if (program === "git") return git(args);
  if (program === "npm") return npm(args);
  if (program === "node") return args.length === 1 && args[0] === "--version";
  if ((program === "head" || program === "tail") && args.length === 1 && /^-\d+$/.test(args[0]!)) return true;
  if (!Object.hasOwn(READ_OPTIONS, program)) return false;
  const options = READ_OPTIONS[program]!;
  const operands = readOperands(args, ...options);
  return operands !== null && (!["uniq", "xxd"].includes(program) || operands.length <= 1);
}

/** The only positive approval path in the inspect profile, including auto repos. */
export function readOnlyInspection(raw: string, ctx: GuardContext): boolean {
  // Also cover paths embedded in option values and interpreted programs.
  if (/(?:^|\/)\.(?:ssh|aws|gnupg|netrc|npmrc|pypirc|kube|claude[^/\s]*|codex|config\/gh|docker\/config\.json)(?:[\/\s'"}]|$)/.test(raw)) return false;
  const commands = inspectionCommands(raw);
  if (!commands) return false;
  return commands.every((words) => readOnly(words) && !words.some((word) => credentialPath(word, { words, text: words.join(" "), cwd: ctx.worktree }, ctx)));
}
