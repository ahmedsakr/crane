/** Source ranges distinguish shell operators from quoted argument contents. */
export interface ShellToken {
  value: string;
  start: number;
  end: number;
  operator: boolean;
}

const COMMAND_SEPARATORS = new Set([";", "\n", "|", "||", "&", "&&", "(", ")", "`"]);

function literalQuoted(raw: string): boolean {
  const quote = raw[0];
  if (quote !== "'" && quote !== '"') return false;
  for (let i = 1; i < raw.length; i++) {
    const char = raw[i];
    if (char === quote) return i === raw.length - 1;
    if (quote === "'") continue;
    if (char === "$" || char === "`") return false;
    if (char === "\\") i++;
  }
  return false;
}

function messageRanges(raw: string, words: ShellToken[]): ShellToken[] {
  // Deliberately narrow: wrappers, global Git options and ambiguous option
  // values keep the existing conservative scan rather than guessing provenance.
  if (!/^(?:\S*\/)?git$/.test(words[0]?.value ?? "") || words[1]?.value !== "commit") return [];
  const ranges: ShellToken[] = [];
  for (let i = 2; i < words.length; i++) {
    const token = words[i]!;
    if (token.operator) break;
    const option = token.value;
    if (["-m", "-am", "--message"].includes(option)) {
      const value = words[++i];
      if (!value) break;
      if (literalQuoted(raw.slice(value.start, value.end))) ranges.push(value);
    } else if (option.startsWith("--message=") || /^-[am]*m./.test(option)) {
      const offset = option.startsWith("--message=") ? 10 : option.indexOf("m") + 1;
      const start = token.start + offset;
      if (literalQuoted(raw.slice(start, token.end))) ranges.push({ ...token, start });
    } else if (!["-a", "--all", "-q", "--quiet", "--amend", "--no-edit", "--allow-empty", "--allow-empty-message", "--no-verify", "-s", "--signoff", "-v", "--verbose"].includes(option)) break;
  }
  return ranges;
}

export function maskCommitMessages(raw: string, tokens: ShellToken[]): string {
  const ranges: ShellToken[] = [];
  let words: ShellToken[] = [];
  for (const token of tokens) {
    if (!token.operator || !COMMAND_SEPARATORS.has(token.value)) words.push(token);
    else {
      ranges.push(...messageRanges(raw, words));
      words = [];
    }
  }
  ranges.push(...messageRanges(raw, words));
  let out = raw;
  for (const range of ranges.reverse()) out = out.slice(0, range.start) + "''" + out.slice(range.end);
  return out;
}
