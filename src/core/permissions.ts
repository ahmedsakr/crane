/**
 * @deprecated Moved to `@crane/agent-policy`. Re-exported here so branches
 * written against the old path still build; remove once none import it.
 * The command splitter and rule-prefix helpers are internal to the policy now.
 */
export { isAllowed, overlapsDenied, suggestRules } from "@crane/agent-policy";
