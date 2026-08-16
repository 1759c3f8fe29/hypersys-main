// ---------------------------------------------------------------------------
// Artifact canvas panel
// ---------------------------------------------------------------------------
// A resizable side panel that opens when the assistant ships substantial code or
// a generated file. Three views: a live preview (sandboxed iframe for HTML/SVG),
// a syntax-highlighted code view, and rendered markdown for prose; plus a diff
// between versions for artifacts that have history.

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Check, Download, X, History, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { diffLines, diffSummary } from "@/lib/artifact-diff";
import type { Artifact } from "@/lib/artifacts";
import { useArtifacts, closeArtifact } from "./ArtifactProvider";

// The languages the preview iframe can render live. React would need a runtime
// (Babel-in-browser / esbuild-wasm) we deliberately don't bundle — so React
// blocks fall back to the code view, and a Mermaid block renders a note rather
// than a silently-wrong substitution (the brief's Pollinations rule, applied to
// previews too).
const PREVIEWABLE = new Set(["html", "svg"]);
const MARKDOWN_LANGS = new Set(["markdown", "md"]);

interface Props {
  /**
   * Hands the artifact's current text back to the composer so the user can ask
   * for changes against it. Optional — the button is hidden when absent.
   */
  onEdit?: (text: string) => void;
  onDownload?: (artifact: Artifact) => void;
  /** Resolve a file artifact's text from its object URL (only used for files). */
  fetchFileText?: (artifact: Artifact) => Promise<string>;
}

export function ArtifactPanel({ onEdit, onDownload, fetchFileText }: Props) {
  const { artifacts, openId } = useArtifacts();
  const artifact = useMemo(
    () => artifacts.find((a) => a.id === openId) || null,
    [artifacts, openId],
  );

  if (!artifact) return null;

  return (
    <div className="h-full flex flex-col bg-card border-l border-border/40">
      <PanelHeader artifact={artifact} onClose={closeArtifact} onDownload={onDownload} />
      <PanelBody artifact={artifact} onEdit={onEdit} fetchFileText={fetchFileText} />
    </div>
  );
}

function PanelHeader({
  artifact,
  onClose,
  onDownload,
}: {
  artifact: Artifact;
  onClose: () => void;
  onDownload?: (a: Artifact) => void;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40 bg-secondary/30">
      <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground/70 px-2 py-0.5 rounded-md bg-background/60 border border-border/30">
        {artifact.language}
      </span>
      <span className="flex-1 min-w-0 text-sm font-medium text-foreground/90 truncate">
        {artifact.title}
      </span>
      {artifact.history.length > 1 && (
        <span className="text-xs text-muted-foreground/70 px-2 py-0.5 rounded-md bg-background/40">
          v{artifact.history.length}
        </span>
      )}
      {artifact.downloadable && onDownload && (
        <button
          onClick={() => onDownload(artifact)}
          title="Download"
          className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          <Download className="w-4 h-4" />
        </button>
      )}
      <button
        onClick={onClose}
        title="Close"
        className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function PanelBody({
  artifact,
  onEdit,
  fetchFileText,
}: {
  artifact: Artifact;
  onEdit?: (t: string) => void;
  fetchFileText?: (a: Artifact) => Promise<string>;
}) {
  const latest = artifact.history[artifact.history.length - 1];
  // File artifacts resolve their text from an object URL on demand.
  const [resolved, setResolved] = useState<string | null>(
    artifact.kind === "file" || !latest?.content ? null : null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadingFile = useRef(false);

  useEffect(() => {
    if (artifact.kind !== "file") return;
    if (loadingFile.current) return;
    if (resolved !== null) return;
    if (!fetchFileText) {
      setLoadError("File preview is unavailable in this context.");
      return;
    }
    loadingFile.current = true;
    fetchFileText(artifact)
      .then((text) => setResolved(text))
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not read file text."))
      .finally(() => {
        loadingFile.current = false;
      });
  }, [artifact, resolved, fetchFileText]);

  const content = artifact.kind === "file" ? resolved : latest?.content ?? "";
  const loading = artifact.kind === "file" && resolved === null && !loadError;

  const [view, setView] = useState<"preview" | "code" | "markdown" | "diff">("code");
  // Default to the most useful view for the artifact.
  const effectiveView = useMemo(() => {
    if (view !== "code") return view; // user override
    if (artifact.kind === "file") {
      const ext = artifact.language;
      if (PREVIEWABLE.has(ext) || MARKDOWN_LANGS.has(ext)) return PREVIEWABLE.has(ext) ? "preview" : "markdown";
      return "code";
    }
    if (PREVIEWABLE.has(artifact.language)) return "preview";
    if (MARKDOWN_LANGS.has(artifact.language)) return "markdown";
    return "code";
  }, [view, artifact]);

  if (loadError) {
    return <div className="flex-1 p-6 text-sm text-muted-foreground">{loadError}</div>;
  }
  if (loading) {
    return <div className="flex-1 p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ViewSwitch view={effectiveView} setView={setView} artifact={artifact} />
      <div className="flex-1 min-h-0 overflow-auto">
        {effectiveView === "preview" && <Preview content={content} kind={artifact.language} />}
        {effectiveView === "code" && <CodeView content={content} language={artifact.language} />}
        {effectiveView === "markdown" && <MarkdownView content={content} />}
        {effectiveView === "diff" && <DiffView artifact={artifact} />}
      </div>
      {onEdit && effectiveView !== "diff" && (
        <EditBar content={content} onEdit={onEdit} />
      )}
    </div>
  );
}

function ViewSwitch({
  view,
  setView,
  artifact,
}: {
  view: "preview" | "code" | "markdown" | "diff";
  setView: (v: "preview" | "code" | "markdown" | "diff") => void;
  artifact: Artifact;
}) {
  const tabs: Array<{ id: "preview" | "code" | "markdown" | "diff"; label: string; shown: boolean }> = [
    { id: "preview", label: "Preview", shown: PREVIEWABLE.has(artifact.language) },
    { id: "markdown", label: "Render", shown: MARKDOWN_LANGS.has(artifact.language) },
    { id: "code", label: "Code", shown: true },
    { id: "diff", label: "Diff", shown: artifact.history.length > 1 },
  ];
  const shown = tabs.filter((t) => t.shown);
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-border/40 bg-background/40">
      {shown.map((t) => (
        <button
          key={t.id}
          onClick={() => setView(t.id)}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            view === t.id
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Preview({ content, kind }: { content: string; kind: string }) {
  const srcDoc = kind === "svg" ? `<!doctype html><body style="margin:0;display:grid;place-items:center;background:#0b0b0c">${content}</body>` : content;
  return (
    <iframe
      title="artifact preview"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="w-full h-full bg-background rounded-md"
    />
  );
}

function CodeView({ content, language }: { content: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative h-full">
      <button
        onClick={copy}
        className="absolute top-3 right-3 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background/80 hover:bg-background text-xs text-muted-foreground hover:text-foreground border border-border/30 transition-colors"
      >
        {copied ? <><Check className="w-3.5 h-3.5 text-primary" /><span>Copied</span></> : <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>}
      </button>
      <SyntaxHighlighter
        language={language || "text"}
        style={oneDark}
        customStyle={{ margin: 0, padding: "1.25rem 1.5rem", background: "transparent", fontSize: "0.8125rem", lineHeight: 1.65, minHeight: "100%" }}
        showLineNumbers={content.split("\n").length > 3}
        lineNumberStyle={{ opacity: 0.4, minWidth: "2.5em" }}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
}

function MarkdownView({ content }: { content: string }) {
  return (
    <div className="p-5 prose prose-invert prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function DiffView({ artifact }: { artifact: Artifact }) {
  const [pos, setPos] = useState(0); // which pair to diff
  const versions = artifact.history;
  const prev = versions[Math.max(0, pos)]?.content ?? "";
  const next = versions[Math.min(versions.length - 1, pos + 1)]?.content ?? "";
  const rows = useMemo(() => (prev !== next ? diffLines(prev, next) : []), [prev, next]);
  const summary = useMemo(() => diffSummary(rows), [rows]);

  if (versions.length < 2) {
    return <div className="p-6 text-sm text-muted-foreground">No earlier version to diff against.</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 bg-background/40 text-xs text-muted-foreground">
        <History className="w-3.5 h-3.5" />
        <span>History · {versions.length} versions</span>
        <div className="flex items-center gap-1 ml-auto">
          <button
            disabled={pos === 0}
            onClick={() => setPos((p) => Math.max(0, p - 1))}
            className="p-1 rounded hover:bg-secondary disabled:opacity-30"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="font-mono">
            v{pos + 1} → v{pos + 2}
          </span>
          <button
            disabled={pos >= versions.length - 2}
            onClick={() => setPos((p) => Math.min(versions.length - 2, p + 1))}
            className="p-1 rounded hover:bg-secondary disabled:opacity-30"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        {rows.length > 0 && (
          <span className="ml-2">
            <span className="text-emerald-500/90">+{summary.added}</span>
            {" "}
            <span className="text-rose-500/90">−{summary.removed}</span>
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto font-mono text-xs leading-relaxed">
        {rows.map((row, i) => (
          <DiffRowView key={i} row={row} />
        ))}
        {rows.length === 0 && (
          <div className="p-6 text-muted-foreground">Versions v{pos + 1} and v{pos + 2} are identical.</div>
        )}
      </div>
    </div>
  );
}

function DiffRowView({ row }: { row: import("@/lib/artifact-diff").DiffRow }) {
  if (row.kind === "equal") {
    return (
      <div className="flex">
        <span className="w-10 shrink-0 text-right pr-2 text-muted-foreground/40 select-none">{row.newLine ?? ""}</span>
        <span className="flex-1 whitespace-pre-wrap text-muted-foreground/70 pl-1">{row.lines.join("\n")}</span>
      </div>
    );
  }
  const bg = row.kind === "added" ? "bg-emerald-500/10" : "bg-rose-500/10";
  const marker = row.kind === "added" ? "+" : "−";
  const color = row.kind === "added" ? "text-emerald-400" : "text-rose-400";
  return (
    <div className={`flex ${bg}`}>
      <span className={`w-10 shrink-0 text-right pr-2 text-muted-foreground/40 select-none ${color}`}>
        {row.kind === "added" ? row.newLine : row.oldLine ?? ""}
      </span>
      <span className={`flex-1 whitespace-pre-wrap pl-1 ${color}`}>
        {marker} {row.lines.join("\n")}
      </span>
    </div>
  );
}

function EditBar({ content, onEdit }: { content: string; onEdit: (t: string) => void }) {
  return (
    <div className="border-t border-border/40 px-4 py-3 flex items-center justify-between gap-2 bg-background/40">
      <span className="text-xs text-muted-foreground">Feed this into the chat to ask for changes.</span>
      <button
        onClick={() => onEdit(content)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
      >
        <Pencil className="w-3.5 h-3.5" />
        Edit this
      </button>
    </div>
  );
}

export default ArtifactPanel;
