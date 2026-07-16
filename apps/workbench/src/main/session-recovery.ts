export function missingManagedSessionIds(
  managedSessionIds: Iterable<string>,
  liveSessionIds: Iterable<string>,
): string[] {
  const live = new Set(liveSessionIds);
  return [...managedSessionIds].filter((sessionId) => !live.has(sessionId));
}
