// ---------------------------------------------------------------------------
// Canvas container — owns the panel's docked width and drag handle
// ---------------------------------------------------------------------------
// Sits at the right edge of <main> and is only visible when an artifact is open.
// Resizable because code/artefact panes want to be widened; we hold the width in
// state here rather than via react-resizable-panels' portal group so the canvas
// can come and go without disturbing the message layout (Arena mode keeps full
// width while the canvas is closed).

import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { ArtifactPanel } from "./ArtifactPanel";
import type { Artifact, ArtifactVersion } from "@/lib/artifacts";
import { useArtifacts, setCanvasWidth } from "./ArtifactProvider";
import type { MessageFile } from "@/components/chat/types";

/**
 * A generated file plus the id of the message that produced it.
 *
 * The message id is the whole point of this type, and it fixes a wrong-data bug
 * (§14.2 #18). A file artifact's id is `file:<filename>` — filename alone — so
 * two turns that both generate `report.xlsx` share one artifact id, and
 * `mergeArtifacts` deliberately treats the second as a **new version** of the
 * first (a different producing message is its new-version signal). But both
 * resolvers below used to look the file up with
 * `filesForTurn.find(f => f.filename === …)`, and `find` returns the *first*
 * match — the oldest. So the panel showed "v2", and previewed and downloaded
 * version 1's bytes.
 *
 * Carrying the producing message id makes the lookup answer the question the
 * artifact is actually asking: not "a file with this name" but "the file this
 * version came from".
 */
export interface TurnFile extends MessageFile {
  messageId: string;
}

interface Props {
  /** Triggered when the user holds the edge of the canvas width handle down. */
  filesForTurn: TurnFile[];
  onEdit?: (text: string) => void;
}

export function ArtifactCanvas({ filesForTurn, onEdit }: Props) {
  const store = useArtifacts();
  const open = !!store?.openId;
  const width = store?.canvasWidth ?? 520;
  const dragging = useRef(false);

  const onDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    // Right-docked, so the width is the distance from the pointer to the right
    // edge of the window. The store clamps.
    setCanvasWidth(window.innerWidth - e.clientX);
  }, []);

  const onUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Resolve the blob url for the version of the artifact the panel is showing.
  // The Artifact itself carries no url, so this is the only join between the
  // artifact store and the actual bytes — and getting it wrong is invisible,
  // because the wrong file downloads exactly as successfully as the right one.
  const resolveFile = useCallback(
    (artifact: Artifact): TurnFile | undefined => {
      const named = filesForTurn.filter((f) => `file:${f.filename}` === artifact.id);
      if (named.length <= 1) return named[0];

      // More than one file with this name, so the artifact has versions and the
      // filename alone cannot say which. The panel renders the newest version's
      // content, so match that version's producing message.
      const latest = artifact.history[artifact.history.length - 1];
      const exact = latest && named.find((f) => f.messageId === latest.messageId);
      // Last rather than first when no version matches: an artifact registered
      // from a download chip (`openFileArtifact`) carries a synthetic messageId
      // that no message owns, and for it the newest same-named file is the one
      // the user was just looking at. `find`'s first-match — the *oldest* — was
      // the bug.
      return exact ?? named[named.length - 1];
    },
    [filesForTurn],
  );

  const onDownload = useCallback(
    (artifact: Artifact) => {
      const file = resolveFile(artifact);
      if (!file) {
        // Used to `return` silently. `fetchFileText` throws a reported error for
        // this exact condition two functions down, so the same missing file was
        // explained on the preview path and not on the download path — and a
        // Download button that does nothing at all reads as a broken app, so the
        // user presses it again.
        toast("That file is no longer available in this session.", {
          id: "artifact-file-missing",
        });
        return;
      }
      const a = document.createElement("a");
      a.href = file.url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    [resolveFile],
  );

  const fetchFileText = useCallback(
    async (artifact: Artifact): Promise<string> => {
      const file = resolveFile(artifact);
      if (!file) throw new Error("This file is no longer available.");
      const res = await fetch(file.url);
      if (!res.ok) throw new Error("Could not read the generated file.");
      return res.text();
    },
    [resolveFile],
  );

  /**
   * The bytes of **one particular version**, for the diff view.
   *
   * `resolveFile` cannot serve this: it exists to fill the panel's single content
   * pane, so it resolves the newest version and falls back to the newest
   * same-named file when no version matches. Both behaviours are right there and
   * wrong here. A diff asks "how do these two versions differ", and a fallback can
   * answer it with the same file on both sides — which renders as "identical", the
   * one output a user comparing two files they know differ will believe. So this
   * matches the producing message exactly and throws when it cannot.
   *
   * The honest failure it throws is reachable in normal use: an artifact opened
   * from a download chip carries a synthetic messageId no message owns, and a
   * blob URL dies with the tab that made it.
   */
  const fetchVersionText = useCallback(
    async (artifact: Artifact, version: ArtifactVersion): Promise<string> => {
      const file = filesForTurn.find(
        (f) => `file:${f.filename}` === artifact.id && f.messageId === version.messageId,
      );
      if (!file) throw new Error("That version's file is no longer in this session.");
      const res = await fetch(file.url);
      if (!res.ok) throw new Error("Could not read that version of the file.");
      return res.text();
    },
    [filesForTurn],
  );

  // When the panel opens it uses whatever docked width the store holds; there is
  // no per-open reset, because the width is a preference the user set by
  // dragging and re-normalising it on every open fights that.

  if (!open) return null;

  // Absolute-docked over <main> rather than a flex sibling: <main> is a vertical
  // column (header / messages / input), so a right-docked sibling would force a
  // row restructure that Arena mode relies on as full-width. Overlaid keeps the
  // canvas a pure overlay that appears only when open and does not touch layout.
  //
  // Two things here were previously wrong and are worth not re-introducing:
  //
  //   1. The class list held both `absolute` and `relative`. Tailwind resolves
  //      that by stylesheet order, not by the order they are written, and
  //      `.relative` is emitted after `.absolute` — so the panel was
  //      `position: relative`, every one of `right-0 top-0 bottom-0` was inert,
  //      and instead of docking it sat in the flow sized to its content.
  //   2. It was `hidden md:flex`, but the "Open in canvas" triggers in
  //      ChatMessage render at every width. Below the breakpoint the button was
  //      live and did nothing visible. Now the canvas covers the conversation
  //      full-width on narrow viewports (`inset-x-0`) and only docks to a
  //      resizable column at `lg`, where there is room for both. The full-width
  //      case needs `z-50` to clear the composer's `z-40`; docked, it is beside
  //      the composer rather than over it, so `lg:z-30` is enough.
  return (
    <aside
      style={{ ["--canvas-w" as string]: `${width}px` }}
      className="absolute inset-y-0 inset-x-0 lg:left-auto lg:right-0 lg:w-[var(--canvas-w)] flex z-50 lg:z-30 shadow-2xl"
      data-artifact-canvas
    >
      <div
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        title="Drag to resize"
        className="absolute left-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-ew-resize hover:bg-primary/40 z-[5] hidden lg:block touch-none"
      />
      <ArtifactPanel
        onEdit={onEdit}
        onDownload={onDownload}
        fetchFileText={fetchFileText}
        fetchVersionText={fetchVersionText}
      />
    </aside>
  );
}

export default ArtifactCanvas;
