// Conversation search (§8 Part F: "Search across message bodies, not just
// titles"). Decides whether a conversation matches the sidebar's history
// filter — by title, as before, OR by a needle appearing anywhere in its
// message bodies.
//
// WHY A MODULE, AND WHY PURE
// The conversation list payload carries no messages: titles only. Bodies live
// behind a per-conversation Firestore read (getMessages), so the sidebar has
// to fetch them lazily, race-guard them, and cache them — wiring concerns.
// What can be pinned without any of that is the *predicate*: given a title, a
// count of how many fetched bodies contain the needle, and the needle, does
// this conversation match? That is string comparison over plain data, so it
// lives here, dependency-free (see conversation-export.ts for the same
// reasoning), testable with no DOM, no Firestore mock, and no React.
//
// The sidebar supplies `bodyHits` rather than the messages themselves so the
// predicate stays a pure function of numbers and strings while the fetch
// bookkeeping — which messages have been fetched, for which needle, in which
// generation — stays where the re-render is triggered from. countBodyHits
// exists so the sidebar does not re-implement the body-side matching rule
// (two private copies of one canonical rule is the exact failure mode this
// repo has been burned by; see the "private copies" note in the chat-format
// tests).

/** The message fields the body search reads. A structural subset of
 *  FirestoreMessage (src/lib/firestore-db.ts) — kept local so this module does
 *  not import from the DB layer, which would drag Firebase into a pure unit
 *  test. Role is deliberately absent: both sides of the conversation are
 *  searched, because the user remembers phrases from replies at least as often
 *  as phrases from their own turns. */
export interface SearchableMessage {
  id: string;
  content: string;
}

/**
 * The needle the field actually means: trimmed (a pasted phrase brings trailing
 * whitespace more often than not) and lowercased, exactly as the title filter
 * already normalizes it (`historyQuery.trim().toLowerCase()` in ChatSidebar).
 * One normalizer for both halves of the same field — if title matching trimmed
 * and body matching did not, " bridge " would find one and miss the other.
 */
function normalizeNeedle(needle: string): string {
  return needle.trim().toLowerCase();
}

/** True when `title` contains the needle, case-insensitively. An empty needle
 *  matches: the sidebar's empty-query behaviour is "show all", so the module
 *  must agree with it or wiring it in would blank the list the moment the
 *  field was cleared. */
export function matchesTitle(title: string, needle: string): boolean {
  const n = normalizeNeedle(needle);
  if (!n) return true;
  return title.toLowerCase().includes(n);
}

/** How many of `messages` contain the needle in their body,
 *  case-insensitively. A count rather than a boolean because the sidebar has
 *  two uses for it: zero-vs-nonzero is the match predicate, and the raw number
 *  is available for a future "3 hits in contents" affordance. Empty lists and
 *  empty needles both count 0 — countBodyHits is only ever consulted through
 *  matchesConversation, which handles the empty needle before reaching here. */
export function countBodyHits(messages: SearchableMessage[], needle: string): number {
  const n = normalizeNeedle(needle);
  if (!n) return 0;
  return messages.filter((m) => m.content.toLowerCase().includes(n)).length;
}

/**
 * The filter predicate: a conversation matches when its title matches OR its
 * message bodies contain the needle. `bodyHits` is the number of fetched
 * messages that contain the needle (countBodyHits over the conversation's
 * bodies) — 0 when the bodies have not been fetched yet, which means a
 * conversation that will match by body is filtered out for the moments before
 * its bodies land. That is the deliberate trade: titles filter instantly from
 * local state, body matches stream in as the lazy fetches resolve, and the
 * alternative (blocking the filter on every conversation's messages) would
 * make typing feel broken.
 *
 * Empty needle matches everything, mirroring the empty-query shows-all rule
 * the title filter already has.
 */
export function matchesConversation(
  title: string,
  bodyHits: number,
  needle: string,
): boolean {
  return matchesTitle(title, needle) || bodyHits > 0;
}
