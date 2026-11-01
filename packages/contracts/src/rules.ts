/** The shared permission-rule grammar. Enforcement belongs to the backend. */
const RULE = /^([A-Za-z_][\w-]*)(?:\((.+)\))?$/;

export function parseRule(rule: string): { tool: string; pattern: string | null } | null {
  const m = RULE.exec(rule.trim());
  return m ? { tool: m[1]!, pattern: m[2] ?? null } : null;
}

/** A short, human label for a rule: `Bash(npm ci:*)` → `npm ci`. */
export function ruleLabel(rule: string): string {
  const r = parseRule(rule);
  if (!r) return rule;
  if (r.tool === "Bash" && r.pattern) return r.pattern.replace(/:\*$/, "").replace(/\*$/, "");
  return r.pattern ? `${r.tool} ${r.pattern}` : r.tool;
}
