import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyToolCall, type GuardContext } from "@crane/agent-policy";

const context: GuardContext = {
  access: "most", profile: "inspect", worktree: "/repos/app", checkout: "/repos/app",
  defaultBranch: "main", craneHome: "/factory", home: "/home/operator", allowed: [],
};
const classify = (command: string, extra: Partial<GuardContext> = {}) => classifyToolCall({ tool: "Bash", input: { command } }, { ...context, ...extra });

const inspections = [
  "find src -name '*.ts'", "find . -type f -maxdepth 2 -print0", "find . -printf '%p\\n'",
  "sed -n 1,40p x", "sed -nE '1,40p;$p' x", "awk '{print $1}' x", "awk -F: -v n=1 '{print $n}' x",
  "jq -r '.name' package.json", "sort -nr x", "sort --key=1,1 --reverse x", "uniq -c x", "cut -d: -f1 x",
  "tr -d '\\r'", "wc -l x", "diff -u a b", "cmp -s a b", "file -b x", "stat -c '%s' x", "du -sh src", "df -h",
  "tree -L 2 src", "which -a node", "type -a node", "basename -s .ts src/x.ts", "dirname src/x.ts",
  "realpath --relative-to=. src", "readlink -f src", "nl -ba x", "column -t x", "comm -12 a b", "xxd -l32 x", "od -An -tx1 x",
  "git log --oneline -n 20", "git show HEAD", "git diff --stat", "git status --short", "git blame x",
  "git rev-parse --show-toplevel", "git ls-files", "git ls-tree -r HEAD", "git grep -n hello", "git branch --list",
  "git branch -a", "git branch -r", "git branch --list 'feature/*'", "git branch --list new HEAD", "git remote -v", "git describe --tags",
  "git merge-base HEAD main", "git cat-file -p HEAD", "git for-each-ref --format='%(refname)'", "git shortlog -sn",
  "git -C src status", "npm ls --json", "npm view typescript version --json", "node --version",
  "npm run --silent crane -- tasks --all --json", "npm run --silent crane -- show t-1 --json",
  "npm run --silent crane -- blocked --json", "npm run --silent crane -- repos --json", "npm run --silent crane -- diff t-1 --json",
  "git log --oneline | head", "git log --oneline | head -20", "find src -name '*.ts' | sort | uniq -c | head -n20",
  "git log --oneline | git grep hello", "git status && sed -n 1,40p x; wc -l x", "find . -type f 2>/dev/null | head",
  "sort x >/dev/null", "wc -l x >> /dev/null", "stat x &>/dev/null",
];

test("inspect: positive list allows every listed command and read-only compound in most and auto repos", () => {
  for (const access of ["most", "auto"] as const) {
    for (const command of inspections) assert.equal(classify(command, { access }).decision, "allow", `${access}: ${command}`);
  }
});

const notApproved = [
  "find . -delete", "find . -exec touch x ';'", "find . -execdir touch x '+'", "find . -ok touch x ';'",
  "find . -okdir touch x ';'", "find . -fprint x", "find . -fprint0 x", "find . -fprintf x '%p'", "find . -fls x",
  "sed -i 's/x/y/' x", "sed -ni 1p x", "sed --in-place=.bak -n 1p x", "sed -n '1w f' x", "sed -n '1W f' x",
  "sed -n 's/x/y/w f' x", "sed -n 'e touch f' x", "sed -n 's/x/touch f/e' x", "sed -n 'r /etc/passwd' x", "sed -n -f script x",
  "awk '{print > \"f\"}' x", "awk '{print >> \"f\"}' x", "awk '{print | \"touch f\"}' x", "awk 'BEGIN{system(\"touch f\")}'",
  "awk 'BEGIN{getline x < \"f\"; print x}'", "awk -f script x", "awk '@load \"extension\"' x",
  "sort -o f x", "sort -of x", "sort -ro f x", "sort --output=f x", "sort --compress-program=touch x",
  "uniq x output", "xxd x output", "xxd -r x", "tree -o f", "file -C -m magic", "diff --output=f a b",
  "git branch -D x", "git branch --list -D x", "git branch -m old new", "git branch new",
  "git branch -a new HEAD", "git branch -r new HEAD",
  "git log --output=f", "git show --ext-diff", "git diff --textconv", "git -c core.pager=evil log", "git grep --open-files-in-pager=evil x",
  "git cat-file --filters HEAD:x", "git cat-file --batch-command", "git remote update", "git rev-parse --sq-quote --output=f",
  "npm install", "npm test", "npm run crane -- tasks --json", "npm run --silent crane -- tasks",
  "npm run --silent crane -- repos checks app --json --clear", "npm ls --prefix=/elsewhere", "npm view --userconfig=secrets x",
  "node -e 'console.log(1)'", "node --version script.js", "python3 --version", "./find .", "/tmp/sort x",
  "find . > result", "sort x 2>error", "sort x 2>&1", "sort x <>f", "sort x >/dev/null >f",
  "uniq x '2'>/dev/null", "uniq x \\2>/dev/null", "xxd x \"2\">/dev/null",
  "find . | tee f", "git log | node script.js", "find . && touch x", "find . &", "find . |", "find . ||",
  "find . $(touch x)", "find . `touch x`", "find . \"$(touch x)\"", "find . ${PATH}", "find . $'\\x2ddelete'",
  "find . <(touch x)", "cat <<EOF\nx\nEOF", "(find .)", "cd src && find .", "IFS=x find .", "command find .", "find *",
  "sed -n '1p x", "find . # comment", "sort --unknown x", "uniq -o x", "rg --pre=evil x", "rg --hostname-bin=evil x", "constructor", "toString",
  "awk 'BEGIN{ARGV[1]=\"/home/operator/.ssh/config\"} {print}'", "sort --files0-from=/home/operator/.aws/credentials",
];

test("inspect: writes, unknown flags, unchecked programs and ambiguous shell forms never get positive approval", () => {
  for (const access of ["most", "auto"] as const) {
    for (const command of notApproved) assert.notEqual(classify(command, { access, allowed: ["Bash(*)"] }).decision, "allow", `${access}: ${command}`);
  }
});

test("inspect: base hard denials still win, including credentials, operator actions and shared Git", () => {
  for (const access of ["listed", "most", "auto"] as const) {
    for (const command of ["git push origin HEAD", "crane approve t-1", "sudo find .", "cat /home/operator/.ssh/config", "find /home/operator/.aws/credentials", "git -C /elsewhere status"]) {
      const verdict = classify(command, { access, allowed: ["Bash(*)"] });
      assert.equal(verdict.decision, "deny", command);
      assert.equal(verdict.overridable, false, command);
    }
  }
});

test("inspect: outward denials remain overridable but operator rules never trigger a positive inspection allow", () => {
  for (const access of ["most", "auto"] as const) {
    for (const command of ["npm publish", "npm install -g typescript", "ssh remote"]) {
      const verdict = classify(command, { access });
      assert.equal(verdict.decision, "deny", command);
      assert.equal(verdict.overridable, true, command);
      assert.equal(classify(command, { access, allowed: verdict.rules }).decision, "pass", command);
    }
  }
});

test("inspect: listed access stays pass-through and file tools never receive allow", () => {
  for (const command of inspections) assert.notEqual(classify(command, { access: "listed" }).decision, "allow", command);
  assert.equal(classify("find src -name '*.ts'", { access: "listed" }).decision, "pass");
  for (const access of ["listed", "most", "auto"] as const) {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      assert.notEqual(classifyToolCall({ tool, input: { file_path: "x", notebook_path: "x" } }, { ...context, access }).decision, "allow");
    }
  }
});
