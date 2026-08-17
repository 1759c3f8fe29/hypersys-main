// ---------------------------------------------------------------------------
// Canvas container — owns the panel's docked width and drag handle
// ---------------------------------------------------------------------------
// Sits at the right edge of <main> and is only visible when an artifact is open.
// Resizable because code/artefact panes want to be widened; we hold the width in
// state here rather than via react-resizable-panels' portal group so the canvas
// can come and go without disturbing the message layout (Arena mode keeps full
// width while the canvas is closed).

import { useCallback, useRef } from "react";
import { ArtifactPanel } from "./ArtifactPanel";
import type { Artifact } from "@/lib/artifacts";
import { useArtifacts, setCanvasWidth } from "./ArtifactProvider";
import type { MessageFile } from "@/components/chat/types";

interface Props {
  /** Triggered when the user holds the edge of the canvas width handle down. */
  filesForTurn: MessageFile[];
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

  // There is exactly one download per file in `filesForTurn`. A file artifact's
  // id is `file:<filename>`, so we resolve the blob url by filename here — the
  // Artifact itself carries no url.
  const onDownload = useCallback(
    (artifact: Artifact) => {
      const file = filesForTurn.find((f) => `file:${f.filename}` === artifact.id);
      if (!file) return;
      const a = document.createElement("a");
      a.href = file.url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    [filesForTurn],
  );

  const fetchFileText = useCallback(
    async (artifact: Artifact): Promise<string> => {
      const file = filesForTurn.find((f) => `file:${f.filename}` === artifact.id);
      if (!file) throw new Error("This file is no longer available.");
      const res = await fetch(file.url);
      if (!res.ok) throw new Error("Could not read the generated file.");
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
      <ArtifactPanel onEdit={onEdit} onDownload={onDownload} fetchFileText={fetchFileText} />
    </aside>
  );
}

export default ArtifactCanvas;
