/**
 * Move the entry with `id` to `toIndex` among the entries that share its group, keeping every other
 * entry where it is. Returns the new order, or null when the id is unknown or nothing would change.
 */
export function moveInGroup<T extends { id: number }>(
  entries: readonly T[], id: number, toIndex: number, group: (entry: T) => string,
): T[] | null {
  const moving = entries.find((entry) => entry.id === id);
  if (!moving || !Number.isFinite(toIndex)) return null;
  const key = group(moving);
  const slots: number[] = [];
  entries.forEach((entry, i) => { if (group(entry) === key) slots.push(i); });
  const members = slots.map((i) => entries[i]);
  const from = members.indexOf(moving);
  const to = Math.min(Math.max(Math.trunc(toIndex), 0), members.length - 1);
  if (from === to) return null;
  members.splice(from, 1);
  members.splice(to, 0, moving);
  const result = [...entries];
  slots.forEach((slot, i) => { result[slot] = members[i]; });
  return result;
}
