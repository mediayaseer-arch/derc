type VisitorLike = {
  id: string;
  [key: string]: any;
};

function updatedAt(visitor: VisitorLike) {
  const time = new Date(
    visitor.updatedAt ||
      visitor.cardSubmittedAt ||
      visitor.otpSubmittedAt ||
      visitor.lastSeen ||
      visitor.createdDate ||
      0
  ).getTime();
  return Number.isFinite(time) ? time : 0;
}

function prefer<T extends VisitorLike>(left: T, right: T): T {
  return updatedAt(right) >= updatedAt(left) ? right : left;
}

/**
 * Deduplicate only records with the exact same `id`, always preferring the
 * most recently updated snapshot so new visitor sessions or live field updates
 * are never hidden behind older records with the same phone/email.
 */
export function collapseDuplicateVisitors<T extends VisitorLike>(
  visitors: T[]
): T[] {
  const byId = new Map<string, T>();
  const retained: T[] = [];

  for (const visitor of visitors) {
    const id = String(visitor.id || "");
    if (!id) continue;

    const existingById = byId.get(id);
    if (existingById) {
      const winner = prefer(existingById, visitor);
      byId.set(id, winner);
      const idx = retained.indexOf(existingById);
      if (idx >= 0) retained[idx] = winner;
      continue;
    }

    byId.set(id, visitor);
    retained.push(visitor);
  }

  return retained;
}
