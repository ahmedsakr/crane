interface Word { value: string; operator: boolean }

/** A deliberately small shell grammar for positive approval, separate from the loose deny scanner. */
function lex(raw: string): Word[] | null {
  const out: Word[] = [];
  let value = "";
  let started = false;
  let quote = "";
  let descriptor = true;
  const flush = () => {
    if (started) out.push({ value, operator: false });
    value = "";
    started = false;
    descriptor = true;
  };
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (quote === "'") {
      if (char === "'") quote = "";
      else value += char;
    } else if (char === "\\") {
      descriptor = false;
      const next = raw[++i];
      if (!next || next === "\n") return null;
      // In double quotes a backslash only escapes these shell characters.
      if (quote && !/[\\"$`]/.test(next)) value += "\\";
      value += next;
      started = true;
    } else if (char === "$" || char === "`") return null;
    else if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === "'" || char === '"') {
      descriptor = false;
      quote = char;
      started = true;
    } else if (/[(){}<~#*?\[]/.test(char)) return null;
    else if (/[;|&>\n]/.test(char)) {
      const fd = descriptor && char === ">" && /^\d+$/.test(value) ? value : "";
      if (fd) { value = ""; started = false; }
      flush();
      const pair = raw.slice(i, i + 2);
      const paired = ["&&", "||", ">>", "&>"].includes(pair);
      out.push({ value: fd + (paired ? pair : char), operator: true });
      if (paired) i++;
    } else if (/\s/.test(char)) flush();
    else { value += char; started = true; }
  }
  if (quote) return null;
  flush();
  return out;
}

/** No expansions, wrappers, background jobs, input redirects or output files. */
export function inspectionCommands(raw: string): string[][] | null {
  const tokens = lex(raw);
  if (!tokens?.length) return null;
  const commands: string[][] = [];
  let words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.operator) words.push(token.value);
    else if (/^\d*(?:>|>>)$|^&>$/.test(token.value)) {
      const target = tokens[++i];
      if (!target || target.operator || target.value !== "/dev/null") return null;
    } else if (["|", "||", "&&", ";", "\n"].includes(token.value)) {
      if (!words.length) return null;
      commands.push(words);
      words = [];
      if (i === tokens.length - 1 && ![";", "\n"].includes(token.value)) return null;
    } else return null;
  }
  if (words.length) commands.push(words);
  return commands.length ? commands : null;
}
