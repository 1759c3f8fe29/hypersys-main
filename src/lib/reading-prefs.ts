// Reading preferences: the things a person changes within the first hour of using
// a chat app for real, and which this one had no control for at all.
//
// Found by using it: a long answer at the fixed size is uncomfortable on a bright
// screen and unreadable for anyone who needs larger text, and the only recourse
// was browser zoom, which also scales the sidebar and the composer. Density and
// width are the other two — a wide monitor wastes half its width on a column
// sized for a laptop, and a narrow one wants the opposite.
//
// The values are clamped rather than validated-with-errors: this is a preference,
// and a stored 900% font is either a corruption or a bug in a past version, so the
// sane move is to sit it on the nearest allowed value and carry on. Nothing here
// throws, for the same reason the drafts module does not.

import type { DraftStore } from "./composer-drafts";

export interface ReadingPrefs {
  /** Body text scale, as a multiplier applied to the message prose. */
  fontScale: number;
  /** Message column width in rem-capped px terms; larger is wider. */
  width: number;
  /** Row rhythm inside the conversation. */
  density: "comfortable" | "compact";
  /** Per-message timestamps under a reply. */
  timestamps: boolean;
}

export const FONT_SCALES = [0.9, 1, 1.1, 1.25] as const;
export const WIDTHS = [720, 820, 960] as const;
export const DENSITIES = ["comfortable", "compact"] as const;

export const DEFAULT_READING_PREFS: ReadingPrefs = {
  fontScale: 1,
  width: 820,
  density: "comfortable",
  timestamps: false,
};

export const READING_PREFS_KEY = "flyer_reading_prefs_v1";

/**
 * Snap a value into a known set, falling back to the default.
 *
 * A closed set rather than a range because these are the steps the control
 * offers: a stored 1.17 that no button can produce would render a state the user
 * cannot get back to and cannot see they are in.
 */
function oneOf<T extends string | number>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Read the stored preferences, repairing anything unusable. */
export function loadReadingPrefs(store: DraftStore): ReadingPrefs {
  let raw: string | null = null;
  try {
    raw = store.getItem(READING_PREFS_KEY);
  } catch {
    return { ...DEFAULT_READING_PREFS };
  }
  if (!raw) return { ...DEFAULT_READING_PREFS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_READING_PREFS };
    }
    const p = parsed as Partial<ReadingPrefs>;
    return {
      fontScale: oneOf(FONT_SCALES, p.fontScale, DEFAULT_READING_PREFS.fontScale),
      width: oneOf(WIDTHS, p.width, DEFAULT_READING_PREFS.width),
      density: oneOf(DENSITIES, p.density, DEFAULT_READING_PREFS.density),
      timestamps: typeof p.timestamps === "boolean" ? p.timestamps : DEFAULT_READING_PREFS.timestamps,
    };
  } catch {
    return { ...DEFAULT_READING_PREFS };
  }
}

export function saveReadingPrefs(store: DraftStore, prefs: ReadingPrefs): void {
  try {
    store.setItem(READING_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Same contract as the drafts: a preference that will not persist is not
    // worth breaking a render over. It still applies for this session.
  }
}

/** Step the font scale up or down one notch, saturating at the ends. */
export function steppedScale(current: number, direction: 1 | -1): number {
  const i = FONT_SCALES.indexOf(oneOf(FONT_SCALES, current, 1));
  const next = FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, i + direction))];
  return next;
}

/** The CSS custom properties a container spreads to apply the preferences. */
export function readingPrefsStyle(prefs: ReadingPrefs): Record<string, string> {
  return {
    "--flyer-font-scale": String(prefs.fontScale),
    "--flyer-content-width": `${prefs.width}px`,
    "--flyer-row-gap": prefs.density === "compact" ? "0.25rem" : "0.75rem",
  };
}
