// ---------------------------------------------------------------------------
// Artifact store + provider (module-level store + provider/host components)
// ---------------------------------------------------------------------------
// The canvas lives at the chat-layout root and listens as turns complete, so it
// accumulates artifacts across a whole conversation and keeps version history.
//
// The store is a module-level singleton rather than a useState inside a
// provider, so `ingest` can be called from deep inside Chat's turn-completion
// handler without threading the provider down through 1700 lines of layout —
// and without the stale-state hazards the updater side-channel had. Components
// subscribe via `useSyncExternalStore`; the singleton owns the Map.

import { useSyncExternalStore } from "react";
import type { Artifact } from "@/lib/artifacts";
import { codeArtifactFrom, fileArtifactFrom, mergeArtifacts } from "@/lib/artifacts";
import type { MessageFile } from "@/components/chat/types";

interface State {
  artifacts: Artifact[];
  openId: string | null;
  /**
   * Docked width of the canvas in px, at the breakpoint where it docks rather
   * than covering the conversation.
   *
   * This lives in the store, not in `ArtifactCanvas`, because two components
   * need the same number: the panel sizes itself by it, and the message column
   * must reserve exactly that much room so the canvas does not sit on top of
   * the text. Held locally, the two drift — the original bug was a hardcoded
   * `lg:pr-[34rem]` gutter next to a panel the user could drag to 900px, so
   * widening the panel silently hid the right-hand side of every message.
   */
  canvasWidth: number;
}

export const CANVAS_MIN_W = 320;
export const CANVAS_MAX_W = 900;
const CANVAS_DEFAULT_W = 520;

let state: State = { artifacts: [], openId: null, canvasWidth: CANVAS_DEFAULT_W };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): State {
  return state;
}

/** Merge a turn's fresh artifacts into the running set, with version history. */
export function ingestArtifacts(fresh: Artifact[]): void {
  state = { ...state, artifacts: mergeArtifacts(state.artifacts, fresh) };
  emit();
}

export function openArtifact(id: string): void {
  if (state.openId === id) return;
  state = { ...state, openId: id };
  emit();
}

/**
 * Open a code block straight from the conversation, registering it if the turn's
 * ingest never did.
 *
 * This exists because the alternative — the button passing only an id — could
 * open an id the store had never heard of, and the failure was silent: the canvas
 * docked, reserved its 520px gutter, and rendered nothing, because
 * `ArtifactPanel` finds no artifact and returns null. Any drift at all produced
 * it: a scanner that skipped the block, a threshold that disagreed, text the
 * renderer had normalised and the extractor had not.
 *
 * Passing the content makes the question unanswerable-by-mismatch. The id is
 * derived here, once, from the same text the user is looking at, and the artifact
 * is guaranteed present before it is opened.
 */
export function openCodeArtifact(language: string, content: string): void {
  const artifact = codeArtifactFrom(language, content, "inline");
  if (!state.artifacts.some((a) => a.id === artifact.id)) {
    state = { ...state, artifacts: mergeArtifacts(state.artifacts, [artifact]) };
  }
  state = { ...state, openId: artifact.id };
  emit();
}

/**
 * Open a generated file straight from its download chip, registering it if the
 * turn's ingest never did.
 *
 * The chip used to hand `openArtifact` a bare `file:<name>` id, which is the same
 * open-an-id-nothing-holds hazard `openCodeArtifact` exists to close — and here it
 * had a worse reading, because the chip proves the file is still in the session:
 * its Download button works. Clicking Open beside it and being told "this artifact
 * is no longer in this session" is the panel contradicting the button next to it.
 * Any turn whose ingest did not run leaves that state — the store is cleared on
 * conversation change while the messages (and their chips) are re-rendered from
 * whatever is in hand.
 *
 * Registered under a fixed `"inline"` message id, and only when the id is absent:
 * `mergeArtifacts` treats a *different* producing message as a file's new-version
 * signal, so merging a click-registered copy into an ingested one would append a
 * phantom version and light up the diff view with a change that never happened.
 */
export function openFileArtifact(file: MessageFile): void {
  const artifact = fileArtifactFrom(file, "inline");
  if (!state.artifacts.some((a) => a.id === artifact.id)) {
    state = { ...state, artifacts: [...state.artifacts, artifact] };
  }
  state = { ...state, openId: artifact.id };
  emit();
}

export function closeArtifact(): void {
  if (state.openId === null) return;
  state = { ...state, openId: null };
  emit();
}

/** Open the newest artifact in the set, if any. */
export function openFirstArtifact(): void {
  const latest = state.artifacts[state.artifacts.length - 1];
  if (!latest) return;
  openArtifact(latest.id);
}

/**
 * Set the docked canvas width, clamped. Clamping lives here rather than in the
 * drag handler so every caller lands inside the same bounds — a drag past the
 * window edge cannot leave the message column with a negative gutter.
 */
export function setCanvasWidth(px: number): void {
  const next = Math.max(CANVAS_MIN_W, Math.min(CANVAS_MAX_W, Math.round(px)));
  if (state.canvasWidth === next) return;
  state = { ...state, canvasWidth: next };
  emit();
}

/**
 * Reset on conversation change so history from the prior chat does not bleed.
 * `canvasWidth` deliberately survives: it is a display preference the user set
 * by dragging, not part of the conversation, and snapping it back mid-session
 * would read as the panel forgetting itself.
 */
export function resetArtifacts(): void {
  state = { artifacts: [], openId: null, canvasWidth: state.canvasWidth };
  emit();
}

/** Subscribe a component to the store. */
export function useArtifacts(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to one question — "does the canvas hold this artifact" — rather than to
 * the whole store.
 *
 * `CodeBlock` needs this for every fenced block in the conversation, and the store
 * replaces its state object on every ingest, so `useArtifacts` there would re-render
 * every code block in a long chat once per turn, each one re-running Prism over its
 * body. This returns a boolean instead, and `useSyncExternalStore` bails out of the
 * render when the snapshot is `Object.is`-equal to the last one, so a block only
 * re-renders on the ingest that actually lifted it.
 */
export function useHasArtifact(id: string | null): boolean {
  const read = () => (id ? state.artifacts.some((a) => a.id === id) : false);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Read the store outside React. The imperative writers above (`ingestArtifacts`,
 * `openArtifact`, …) are already callable from anywhere, so the read side needs a
 * non-hook counterpart or the store's invariants — the width clamp, what
 * survives a reset — can only be observed by rendering a component, which turns
 * a plain assertion into a DOM test.
 */
export function readArtifactState(): State {
  return state;
}
