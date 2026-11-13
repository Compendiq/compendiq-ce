/**
 * Confluence task ids (#1751).
 *
 * `ac:task-id` numbers a page's tasks 1, 2, 3, … and must be unique within the
 * page: two tasks that share an id check and uncheck together (Atlassian KB
 * "Checking/unchecking a Task Item in a page causes other Tasks Items to trigger
 * the same behavior"). Confluence keeps it as a 64-bit integer.
 */

/** The largest Confluence task id, 2^63 - 1. */
export const MAX_CONFLUENCE_TASK_ID = 9223372036854775807n;

/**
 * Whether `value` is a Confluence task id: canonical decimal (no sign, no
 * leading zero, so equal ids are equal strings) of at most 2^63 - 1. A task
 * whose value is anything else carries no id and counts as new. The length
 * check comes first, so an oversized value is never parsed.
 */
export function isConfluenceTaskId(value: string): boolean {
  return value.length <= 19 && /^(?:0|[1-9]\d*)$/.test(value) && BigInt(value) <= MAX_CONFLUENCE_TASK_ID;
}
