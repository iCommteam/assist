import {
  emptySessionView,
  foldEvents,
  type Fact,
  type ReceivedEvent,
  type SessionView,
} from "eve/events";

/**
 * Folds committed lines of v27 facts into a session view with eve's own fold,
 * so tests read the same tables hooks and channels see at runtime.
 */
export function viewOf(
  lines: readonly (readonly Fact[])[],
  at = "2026-01-01T00:00:00.000Z"
): SessionView {
  return foldEvents(emptySessionView(), eventsOf(lines, at));
}

/** As `viewOf`, with the time eve recorded each line. */
export function viewAt(
  lines: readonly (readonly [at: string, facts: readonly Fact[]])[]
): SessionView {
  return foldEvents(
    emptySessionView(),
    lines.flatMap(([at, facts], line) =>
      facts.map((fact, index) => ({
        ...fact,
        meta: {
          at,
          endOfLine: index === facts.length - 1,
          position: { index, line },
        },
      }))
    )
  );
}

/** The stream events a reader receives for these committed lines. */
export function eventsOf(
  lines: readonly (readonly Fact[])[],
  at = "2026-01-01T00:00:00.000Z"
): ReceivedEvent[] {
  return lines.flatMap((facts, line) =>
    facts.map((fact, index) => ({
      ...fact,
      meta: {
        at,
        endOfLine: index === facts.length - 1,
        position: { index, line },
      },
    }))
  );
}
