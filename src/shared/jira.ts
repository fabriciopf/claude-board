/** Jira project keys of a comma list, upper-cased ("prod, stays2" = PROD, STAYS2). Card #309. */
export function jiraKeyList(value: string | null | undefined): string[] {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);
}
