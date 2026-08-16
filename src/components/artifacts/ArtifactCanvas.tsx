// ---------------------------------------------------------------------------
// Canvas container — owns the panel's docked width and drag handle
// ---------------------------------------------------------------------------
// Sits at the right edge of <main> and is only visible when an artifact is open.
// Resizable because code/artefact panes want to be widened; we hold the width in
// state here rather than via react-resizable-panels' portal group so the canvas
// can come and go without disturbing the message layout (Arena mode keeps full
// width while the canvas is closed).

import { useCallback, useEffect, useRef, useState } from "react";
import { ArtifactPanel } from "./ArtifactPanel";
import type { Artifact } from "@/lib/artifacts";
import { useArtifacts } from "./ArtifactProvider";
import type { MessageFile } from "@/components/chat/types";

interface Props {
  /** Triggered when the user holds the edge of the canvas width handle down. */
  filesForTurn: MessageFile[];
  onEdit?: (text: string) => void;
}

const MIN_W = 320;
const MAX_W = 900;
const DEFAULT_W = 520;

export function ArtifactCanvas({ filesForTurn, onEdit }: Props) {
  const store = useArtifacts();
  const open = !!store?.openId;
  const [width, setWidth] = useState(DEFAULT_W);
  const dragging = useRef(false);

  const onDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const newWidth = window.innerWidth - e.clientX;
    setWidth(Math.max(MIN_W, Math.min(MAX_W, newWidth)));
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

  // When the panel opens, jump to a sensible default width rather than whatever
  // the last drag left it at — a freshly-opened artefact should read as its own
  // thing. The user can then drag to taste.
  useEffect(() => {
    if (open) setWidth((w) => Math.max(MIN_W, Math.min(MAX_W, w)));
  }, [open]);

  if (!open) return null;

  // Absolute-docked over <main> rather than a flex sibling: <main> is a vertical
  // column (header / messages / input), so a right-docked sibling would force a
  // row restructure that Arena mode relies on as full-width. Overlaid keeps the
  // canvas a pure overlay that appears only when open and does not touch layout.
  return (
    <aside
      style={{ width }}
      className="absolute right-0 top-0 bottom-0 hidden md:flex relative z-30 shadow-2xl"
      data-artifact-canvas
    >
      <div
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        title="Drag to resize"
        className="absolute left-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-ew-resize hover:bg-primary/40 z-[5]"
      />
      <ArtifactPanel onEdit={onEdit} onDownload={onDownload} fetchFileText={fetchFileText} />
    </aside>
  );
}

export default ArtifactCanvas;
