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
import { copyText } from "@/lib/clipboard";
import type { Artifact, ArtifactVersion } from "@/lib/artifacts";
import { RunButton, RunOutput } from "@/components/chat/CodeRunner";
import { isRunnableLanguage, useCodeRunner } from "@/components/chat/use-code-runner";
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
  /**
   * Resolve **one specific version** of a file artifact, which is what the diff
   * view needs and `fetchFileText` cannot give it: that one always resolves the
   * newest version, because it exists to fill the panel's single content pane.
   *
   * Separate rather than a parameter with a default, because the two have
   * different fallback rules and the difference is load-bearing. Resolving the
   * newest may fall back to the newest same-named file when no version matches
   * (see `resolveFile`); resolving version *n* must match `messageId` exactly or
   * fail, because the whole claim a diff makes is "these two are different
   * versions of the same file", and a positional guess can satisfy it with the
   * same file twice — a diff that says "identical" about two files the user knows
   * differ. Failing loudly is the only honest option there.
   */
  fetchVersionText?: (artifact: Artifact, version: ArtifactVersion) => Promise<string>;
}

export function ArtifactPanel({ onEdit, onDownload, fetchFileText, fetchVersionText }: Props) {
  const { artifacts, openId } = useArtifacts();
  const artifact = useMemo(
    () => artifacts.find((a) => a.id === openId) || null,
    [artifacts, openId],
  );

  if (!artifact) {
    // Reachable only if something opened an id the store does not hold — the
    // failure that used to render a docked, blank 520px column and no
    // explanation. `openCodeArtifact` closed that path for code blocks; a stale
    // `file:` id from a reloaded conversation can still land here, so say so and
    // give the user the way out rather than showing them an empty panel.
    return (
      <div className="h-full flex flex-col bg-card border-l border-border/40">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40 bg-secondary/30">
          <span className="flex-1 text-sm font-medium text-foreground/90">Not available</span>
          <button
            onClick={closeArtifact}
            title="Close"
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 p-6 text-sm text-muted-foreground">
          This artifact is no longer in this session. Generated files live only as
          long as the tab that made them, so a reloaded conversation cannot reopen
          one.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card border-l border-border/40">
      <PanelHeader artifact={artifact} onClose={closeArtifact} onDownload={onDownload} />
      {/* Keyed, so switching artifacts starts the body over. Every piece of
          state below belongs to one artifact and none of it was being reset:
          `resolved` holds a file's fetched text and its effect refuses to
          re-fetch once it is non-null, so opening a second file showed the
          *first* file's bytes under the second one's name — the §14.2 #16 shape
          again, a wrong answer that looks like a right one. `view` carried a
          user's "Render" choice onto a Python artifact, and `pos` carried a diff
          position onto an artifact with fewer versions, labelling it "v4 → v5".
          One key fixes all three, which is why it is a key and not three
          effects. */}
      <PanelBody
        key={artifact.id}
        artifact={artifact}
        onEdit={onEdit}
        fetchFileText={fetchFileText}
        fetchVersionText={fetchVersionText}
      />
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
  fetchVersionText,
}: {
  artifact: Artifact;
  onEdit?: (t: string) => void;
  fetchFileText?: (a: Artifact) => Promise<string>;
  fetchVersionText?: (a: Artifact, v: ArtifactVersion) => Promise<string>;
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
        {effectiveView === "diff" && (
          <DiffView artifact={artifact} fetchVersionText={fetchVersionText} />
        )}
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
    // This used to read `history.length > 1 && kind !== "file"`, and that second
    // clause was right about the bug and fatal to the feature. The bug: a file
    // artifact's per-version `content` is `""` by design — files defer their bytes
    // to an object URL, and only the newest version was ever fetched — so a
    // two-version file diffed `""` against `""` and reported "no changes" between
    // two genuinely different spreadsheets (§14.2 #18).
    //
    // What it missed is that **a file is the only artifact that can ever have two
    // versions.** A code artifact's id is a hash of its content, so re-generating
    // it either produces the same id and the same bytes — which `mergeArtifacts`
    // correctly treats as the same version, not a new one — or a different id,
    // which is a different artifact. Excluding files therefore left the condition
    // unsatisfiable: this tab could not appear, and `DiffView`, `diffLines`,
    // `diffSummary` and all of `artifact-diff.test.ts` were unreachable from the
    // running app. A guard that removes the last live path is indistinguishable
    // from deleting the feature, and nothing said so out loud.
    //
    // Fixed by resolving each version's bytes instead of refusing to compare:
    // `fetchVersionText` matches a version's producing message to its file. A
    // version whose blob is gone now says so; that is the honest form of the old
    // guard, and it fires per version rather than per kind.
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
    if (!(await copyText(content))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  // Python in the canvas is runnable on the same terms as Python in the
  // conversation: a Run button beside Copy, and nothing executes until it is
  // pressed. The output docks under the code rather than floating, so a long
  // traceback scrolls with the panel instead of covering it.
  const runner = useCodeRunner(content);
  const runnable = isRunnableLanguage(language);
  return (
    <div className="relative h-full flex flex-col">
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <button
          onClick={copy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background/80 hover:bg-background text-xs text-muted-foreground hover:text-foreground border border-border/30 transition-colors"
        >
          {copied ? <><Check className="w-3.5 h-3.5 text-primary" /><span>Copied</span></> : <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>}
        </button>
        {runnable && (
          <RunButton state={runner.state} onRun={runner.run} onStop={runner.stop} />
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
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
      {runnable && (
        <div className="shrink-0 max-h-[45%] overflow-auto">
          <RunOutput state={runner.state} />
        </div>
      )}
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

/**
 * Compare two adjacent versions of an artifact.
 *
 * Two things here are deliberate and were previously wrong:
 *
 * **It opens on the newest pair, not the oldest.** `useState(0)` showed v1 → v2
 * on an artifact with five versions, so the question the panel answers on open
 * was "what changed the first time" — while the reason anyone opens it is the
 * change that just happened. On a two-version artifact the two are the same, which
 * is why this survived: the common case cannot tell them apart.
 *
 * **The bytes are resolved per version, asynchronously.** A code artifact carries
 * its text inline, but a file artifact's versions all hold `""` and defer to an
 * object URL, so a diff has to fetch both sides. That fetch is racy by nature —
 * pressing the chevron twice starts two — so a cancelled flag drops the loser,
 * the same guard `useTextToSpeech` needs for its awaited voice list. Without it
 * the slower response wins and the panel shows a diff of a pair it is not
 * labelling.
 */
function DiffView({
  artifact,
  fetchVersionText,
}: {
  artifact: Artifact;
  fetchVersionText?: (a: Artifact, v: ArtifactVersion) => Promise<string>;
}) {
  const versions = artifact.history;
  // The newest pair. `max(0, …)` guards the length-1 case, which returns early
  // below but still runs this initialiser.
  const [pos, setPos] = useState(Math.max(0, versions.length - 2));
  const [sides, setSides] = useState<{ prev: string; next: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const older = versions[pos];
    const newer = versions[pos + 1];
    if (!older || !newer) return;

    let cancelled = false;
    const resolve = async (v: ArtifactVersion): Promise<string> => {
      // Inline content wins: a code artifact never needs a fetch, and a file
      // whose bytes have already been read does not need a second one.
      if (v.content) return v.content;
      if (!fetchVersionText) throw new Error("Version history is unavailable here.");
      return fetchVersionText(artifact, v);
    };

    setSides(null);
    setLoadError(null);
    Promise.all([resolve(older), resolve(newer)])
      .then(([prev, next]) => {
        if (!cancelled) setSides({ prev, next });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(
          e instanceof Error ? e.message : "Could not read one of these versions.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [artifact, versions, pos, fetchVersionText]);

  const rows = useMemo(
    () => (sides && sides.prev !== sides.next ? diffLines(sides.prev, sides.next) : []),
    [sides],
  );
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
          {/* Icon-only, so named: the neighbouring "v1 → v2" is the only thing
              saying what these move through, and it is not part of either name. */}
          <button
            disabled={pos === 0}
            onClick={() => setPos((p) => Math.max(0, p - 1))}
            aria-label="Compare an earlier pair of versions"
            title="Earlier versions"
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
            aria-label="Compare a later pair of versions"
            title="Later versions"
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
        {/* Three different reasons for an empty diff, and telling the user
            "identical" for the other two is the whole family of bug this file
            keeps hitting: a confident wrong answer beats no answer only for the
            program. `sides === null` is still fetching; `loadError` means a
            version's bytes are gone (a blob URL dies with its tab); identical is
            the one case where the comparison happened and found nothing. */}
        {loadError && <div className="p-6 text-muted-foreground">{loadError}</div>}
        {!loadError && sides === null && (
          <div className="p-6 text-muted-foreground">Reading both versions…</div>
        )}
        {!loadError && sides !== null && rows.length === 0 && (
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
