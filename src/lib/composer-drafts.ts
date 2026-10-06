// The composer's drafts, so a half-written message survives leaving the app.
//
// Weakness this fixes, found by using the app the way a person does: you type two
// paragraphs, tap a conversation in the sidebar to check something, and the text
// is gone. Every chat app people compare this to keeps a draft. The loss is worst
// on a phone, where an app switch is enough to reload the page.
//
// PER CONVERSATION, not one global draft. A single slot would follow you between
// chats and paste yesterday's question about a spreadsheet into today's thread —
// worse than losing it, because it is not obviously wrong.
//
// The storage is best-effort by construction, which is the part that matters:
// Safari in private mode throws on `localStorage` access rather than returning
// null, a draft can be left by an account that has since signed out, and the JSON
// on disk may be from an older version of this module. Every one of those paths
// returns "no draft" or writes nothing, and none of them throws into the
// composer's render or its keystroke handler.
//
// Deliberately dependency-free and pure over an injectable store, so the tests can
// drive a store that throws on read, throws on write, or holds corrupt JSON.

/** One saved draft. `at` is what lets the oldest go when the list is full. */
export interface Draft {
  text: string;
  at: number;
}

export type DraftStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * How many conversations keep a draft.
 *
 * Bounded because the store is per-origin and shared with the BYOK keys and the
 * sidebar preference: unbounded growth here would eventually make an unrelated
 * `setItem` fail on quota, which surfaces as a key that will not save. Twenty is
 * far more than anyone is mid-thought in at once and small enough that the whole
 * map is a couple of kilobytes.
 */
export const MAX_DRAFTS = 20;

/** A draft longer than this is not a draft, it is the message. */
export const MAX_DRAFT_CHARS = 20_000;

export const DRAFTS_KEY = "flyer_drafts_v1";

type DraftMap = Record<string, Draft>;

/**
 * Namespace a draft by conversation, or by user when there is no conversation yet.
 *
 * A brand-new chat has no id, so keying on the conversation alone would lose the
 * most fragile draft there is — the first message, which is also the one with
 * nowhere else to be recovered from. `new:<user>` namespaces those per account so
 * two people on one machine never see each other's.
 */
export function draftKeyFor(conversationId: string | null, userId: string | null): string {
  if (conversationId) return conversationId;
  return `new:${userId || "guest"}`;
}

function readAll(store: DraftStore): DraftMap {
  let raw: string | null = null;
  try {
    raw = store.getItem(DRAFTS_KEY);
  } catch {
    // Private-mode Safari, or storage disabled for the origin. No drafts, and
    // nothing to report: the composer works identically without them.
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DraftMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Validated rather than trusted: this key is shared with anything else on
      // the origin, and a shape that is wrong one level down would otherwise
      // surface as `undefined.slice` inside a render.
      if (!value || typeof value !== "object") continue;
      const { text, at } = value as Partial<Draft>;
      if (typeof text !== "string") continue;
      out[key] = { text, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(store: DraftStore, map: DraftMap): void {
  try {
    store.setItem(DRAFTS_KEY, JSON.stringify(map));
  } catch {
    // Quota, or a store that refuses writes. Dropping a draft is not worth an
    // exception in a keystroke handler.
  }
}

/** Trim to the cap, oldest first, so a long-lived session cannot grow forever. */
function capped(map: DraftMap): DraftMap {
  const entries = Object.entries(map);
  if (entries.length <= MAX_DRAFTS) return map;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_DRAFTS));
}

/** The saved text for a conversation, or "" when there is none. */
export function loadDraft(store: DraftStore, key: string): string {
  return readAll(store)[key]?.text ?? "";
}

/**
 * Save, or clear when there is nothing left to save.
 *
 * Clearing on empty is what stops a sent message reappearing: the composer calls
 * this with "" after a send, and the deletion has to be a write rather than a
 * skip, or the old text comes back on the next mount.
 */
export function saveDraft(store: DraftStore, key: string, text: string, now: number): void {
  const map = readAll(store);
  if (!text.trim()) {
    if (!(key in map)) return;
    delete map[key];
  } else {
    map[key] = { text: text.slice(0, MAX_DRAFT_CHARS), at: now };
  }
  writeAll(store, capped(map));
}

/** Drop one conversation's draft without touching the others. */
export function clearDraft(store: DraftStore, key: string): void {
  const map = readAll(store);
  if (!(key in map)) return;
  delete map[key];
  writeAll(store, map);
}
