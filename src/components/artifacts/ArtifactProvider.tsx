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
import { mergeArtifacts } from "@/lib/artifacts";

interface State {
  artifacts: Artifact[];
  openId: string | null;
}

let state: State = { artifacts: [], openId: null };
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

/** Reset on conversation change so history from the prior chat does not bleed. */
export function resetArtifacts(): void {
  state = { artifacts: [], openId: null };
  emit();
}

/** Subscribe a component to the store. */
export function useArtifacts(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
