import { motion } from 'framer-motion';
import { Sparkles, Copy, Check, Volume2, VolumeX, Loader2, FileText, Download, RefreshCw, Globe, ExternalLink, ArrowUpRight, Pencil, ChevronLeft, ChevronRight, Terminal } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useState, useMemo, useRef, useEffect } from 'react';
import { useTextToSpeech } from '@/hooks/useTextToSpeech';
import { extractFirstMarkdownImage, sanitizeAssistantText, stripMarkdownImages } from '@/lib/chat-format';
import { artifactIdForCode, isSubstantialCodeBlock } from '@/lib/artifacts';
import type { ChatAttachment, MessageFile, MessageSource } from './types';

interface ArenaResponse {
  modelId: string;
  modelName: string;
  content: string;
}

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  attachments?: ChatAttachment[];
  imageUrl?: string;
  modelName?: string;
  statusText?: string;
  sources?: MessageSource[];
  followUps?: string[];
  files?: MessageFile[];
  // Inline Python runs from the run_code tool (Part G). Each entry is one
  // sandboxed Pyodide run; rendered as a terminal block with stdout/stderr and
  // any matplotlib figures inline, so computed answers are visibly proven.
  codeRuns?: Array<{ stdout?: string; stderr?: string; images?: string[] }>;
  onFollowUp?: (question: string) => void;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
  isArenaMode?: boolean;
  /** Open one of this turn's artifacts in the canvas. The id comes from the
   * shared extractor; the assistant turn's artefacts are ingested into the store
   * already, so ChatMessage only needs to hand over the id and the store opens. */
  onOpenArtifact?: (artifactId: string) => void;
  arenaResponses?: ArenaResponse[];
  // Branching (Part F). branchIndex is this message's 1-based position among
  // its siblings that share a parent; branchCount is how many siblings there
  // are. When count > 1 the row renders a < 2/3 > switcher. Both default to
  // undefined (treated as a sole branch) for live new sends, which have no
  // siblings yet.
  branchIndex?: number;
  branchCount?: number;
  onSwitchBranch?: (direction: 'prev' | 'next') => void;
  // Inline edit affordance for the user's own message. Editing is non-
  // destructive: the parent appends a new sibling branch rather than overwriting.
  canEdit?: boolean;
  onEdit?: (newContent: string) => void;
}

function hostOf(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return link;
  }
}

// One-tap follow-up questions shown under a grounded reply. The questions come
// from the search provider's "related" list, so they cost nothing extra to
// surface and keep the conversation moving the way Gemini/Perplexity do.
function FollowUpChips({ followUps, onFollowUp }: { followUps: string[]; onFollowUp: (q: string) => void }) {
  return (
    <div className="mt-4 pt-3 border-t border-border/30">
      <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-muted-foreground">
        <Sparkles className="w-3.5 h-3.5" />
        <span>Related</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {followUps.map((q, i) => (
          <button
            key={`${q}-${i}`}
            type="button"
            onClick={() => onFollowUp(q)}
            className="group flex items-center justify-between gap-2 text-left px-3 py-2 rounded-xl bg-secondary/40 hover:bg-secondary border border-border/30 hover:border-primary/30 transition-colors active:scale-[0.99]"
          >
            <span className="text-sm text-foreground/85 group-hover:text-foreground">{q}</span>
            <ArrowUpRight className="w-4 h-4 shrink-0 text-muted-foreground/50 group-hover:text-primary" />
          </button>
        ))}
      </div>
    </div>
  );
}

// Inline results from the run_code tool (Part G). Each run is one Python
// execution: stdout/stderr in a terminal-style block and any matplotlib figures
// the capture shim pulled out, rendered inline so the computed proof sits
// beside the model's prose. Empty stdout+stderr+images collapses to nothing.
function CodeRunBlocks({ runs }: { runs: Array<{ stdout?: string; stderr?: string; images?: string[] }> }) {
  const meaningful = runs.filter(r => (r.stdout && r.stdout.trim()) || (r.stderr && r.stderr.trim()) || (r.images && r.images.length));
  if (meaningful.length === 0) return null;
  return (
    <div className="mt-4 space-y-3">
      {meaningful.map((run, i) => {
        const stdout = (run.stdout || '').trim();
        const stderr = (run.stderr || '').trim();
        const images = run.images || [];
        const hasText = stdout || stderr;
        return (
          <div key={i} className="rounded-lg border border-border/40 overflow-hidden bg-muted/30">
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/30 bg-muted/50 text-[11px] text-muted-foreground">
              <Terminal className="w-3 h-3" />
              <span className="font-medium">Python · run {i + 1}</span>
            </div>
            {hasText && (
              <pre className="overflow-x-auto px-3 py-2.5 text-[12.5px] leading-relaxed font-mono whitespace-pre">
                {stdout && <span className="text-foreground/90">{stdout}</span>}
                {stdout && stderr && '\n'}
                {stderr && <span className="text-red-500/90">{stderr}</span>}
              </pre>
            )}
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 p-3 bg-background/40">
                {images.map((src, j) => (
                  <img key={j} src={src} alt={`Figure ${j + 1}`} className="max-w-full max-h-64 rounded border border-border/30" />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Downloads for files the create_file tool wrote. `download` on the anchor is
// what makes the browser save it under the model's chosen filename instead of
// navigating to a blob URL and rendering it inline. An "open" button on each chip
// surfaces the file in the canvas as well.
function FileChips({ files, onOpenFile }: { files: MessageFile[]; onOpenFile?: (filename: string) => void }) {
  return (
    <div className="mt-4 pt-3 border-t border-border/30 flex flex-wrap gap-2">
      {files.map((file) => (
        <div
          key={file.url}
          className="group flex items-center gap-2 px-3 py-2 rounded-xl bg-secondary/40 hover:bg-secondary border border-border/30 hover:border-primary/30 transition-colors active:scale-[0.99]"
        >
          <FileText className="w-4 h-4 shrink-0 text-primary/80" />
          <span className="text-sm font-medium text-foreground/85 group-hover:text-foreground truncate max-w-[14rem]">
            {file.filename}
          </span>
          {onOpenFile && (
            <button
              onClick={() => onOpenFile(file.filename)}
              title="Open in canvas"
              className="p-1 rounded-md hover:bg-foreground/5 text-muted-foreground/60 hover:text-primary transition-colors"
            >
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          )}
          <a href={file.url} download={file.filename} title="Download" className="p-1 rounded-md hover:bg-foreground/5 text-muted-foreground/60 hover:text-primary transition-colors">
            <Download className="w-3.5 h-3.5" />
          </a>
        </div>
      ))}
    </div>
  );
}

function SourceChips({ sources }: { sources: MessageSource[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? sources : sources.slice(0, 3);
  const hidden = sources.length - shown.length;

  return (
    <div className="mt-4 pt-3 border-t border-border/30">
      <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-muted-foreground">
        <Globe className="w-3.5 h-3.5" />
        <span>Sources</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {shown.map((s, i) => (
          <a
            key={`${s.link}-${i}`}
            href={s.link}
            target="_blank"
            rel="noopener noreferrer"
            title={s.title}
            className="group flex items-center gap-2 max-w-[260px] px-2.5 py-2 rounded-xl bg-secondary/50 hover:bg-secondary border border-border/30 transition-colors active:scale-[0.98]"
          >
            <span className="flex items-center justify-center w-4 h-4 shrink-0 rounded-full bg-primary/15 text-primary text-[10px] font-semibold">
              {sources.indexOf(s) + 1}
            </span>
            <span className="flex flex-col min-w-0 leading-tight">
              <span className="truncate text-xs text-foreground/90">{s.title}</span>
              <span className="truncate text-[10px] text-muted-foreground">{s.source || hostOf(s.link)}</span>
            </span>
            <ExternalLink className="w-3 h-3 shrink-0 text-muted-foreground/60 group-hover:text-foreground/70" />
          </a>
        ))}
        {hidden > 0 && (
          <button
            onClick={() => setExpanded(true)}
            className="px-3 py-2 rounded-xl bg-secondary/40 hover:bg-secondary border border-border/30 text-xs text-muted-foreground transition-colors active:scale-[0.98]"
          >
            +{hidden} more
          </button>
        )}
      </div>
    </div>
  );
}

function CodeBlock({ language, children, onOpenArtifact }: { language: string; children: string; onOpenArtifact?: (id: string) => void }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  // Only show the canvas affordance when the block clears the trigger bar and a
  // handler exists — a three-line example with a "open in canvas" button is the
  // annoyance the brief names.
  const substantial = isSubstantialCodeBlock(children);
  const artifactId = useMemo(
    () => (substantial ? artifactIdForCode(language, children) : null),
    [language, children, substantial],
  );

  return (
    <div className="relative group my-5 rounded-2xl overflow-hidden border border-border/40 bg-card shadow-xl">
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-secondary/90 to-secondary/70 border-b border-border/30">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-amber-500/70" />
            <div className="w-3 h-3 rounded-full bg-emerald-500/70" />
          </div>
          <span className="text-xs text-muted-foreground/70 font-mono ml-2 uppercase tracking-wider">{language || 'code'}</span>
        </div>
        <div className="flex items-center gap-2">
          {substantial && onOpenArtifact && artifactId && (
            <button
              onClick={() => onOpenArtifact(artifactId)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background/60 hover:bg-background text-xs text-muted-foreground hover:text-foreground transition-all border border-border/20"
              title="Open in canvas"
            >
              <ArrowUpRight className="w-3.5 h-3.5" /><span>Open</span>
            </button>
          )}
          <button onClick={handleCopy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background/60 hover:bg-background text-xs text-muted-foreground hover:text-foreground transition-all border border-border/20">
            {copied ? <><Check className="w-3.5 h-3.5 text-primary" /><span className="text-primary font-medium">Copied!</span></> : <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <SyntaxHighlighter
          language={language || 'text'}
          style={oneDark}
          customStyle={{ margin: 0, padding: '1.25rem 1.5rem', background: 'transparent', fontSize: '0.875rem', lineHeight: '1.7' }}
          showLineNumbers={children.split('\n').length > 3}
          lineNumberStyle={{ opacity: 0.4, minWidth: '2.5em' }}
        >
          {children}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

// Markdown element overrides. Built as a function so the fenced-code renderer
// can close over `onOpenArtifact` (a substantial block is the trigger that opens
// the canvas); the rest of the overrides are static and shared identically.
function buildMarkdownComponents(onOpenArtifact?: (id: string) => void): any {
 return {
  h1: ({ children }) => (
    <h1 className="text-xl sm:text-2xl font-extrabold mb-3 mt-5 first:mt-0 text-foreground bg-clip-text text-transparent bg-gradient-to-r from-primary via-accent to-primary drop-shadow-sm tracking-tight">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg sm:text-xl font-bold mb-2.5 mt-4 first:mt-0 text-foreground/95 flex items-center gap-2">
      <span className="w-1 h-4 rounded-full bg-gradient-to-b from-primary to-accent flex-shrink-0" />
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base sm:text-lg font-semibold mb-2 mt-3.5 first:mt-0 text-foreground/90 tracking-tight">{children}</h3>
  ),
  p: ({ children, node }) => {
    // If paragraph contains only an image, render as div to avoid nesting issues
    const hasImage = node?.children?.some((child: any) => child.tagName === 'img');
    if (hasImage) {
      return <div className="text-sm sm:text-[15px] leading-relaxed mb-3.5 last:mb-0 text-foreground/85">{children}</div>;
    }
    return <p className="text-sm sm:text-[15px] leading-relaxed mb-3.5 last:mb-0 text-foreground/85">{children}</p>;
  },
  ul: ({ children }) => <ul className="space-y-2 my-3 pl-1 list-none">{children}</ul>,
  ol: ({ children }) => <ol className="space-y-2 my-3 pl-5 list-decimal marker:text-primary/70 marker:font-semibold text-sm sm:text-[15px]">{children}</ol>,
  li: ({ children, className }) => {
    if (className?.includes('task-list-item')) {
      return <li className="flex items-center gap-2.5 text-sm sm:text-[15px] text-foreground/85 my-1">{children}</li>;
    }
    return (
      <li className="flex items-start gap-2.5 text-sm sm:text-[15px] leading-relaxed text-foreground/85 py-0.5 px-0.5 transition-transform duration-200 group/li">
        <span className="flex-shrink-0 mt-[8px] w-1.5 h-1.5 rounded-full bg-primary/40 group-hover/li:bg-primary group-hover/li:shadow-[0_0_6px_hsla(var(--primary)/0.6)] transition-all" />
        <span className="flex-1">{children}</span>
      </li>
    );
  },
  strong: ({ children }) => (
    <strong className="font-bold text-foreground bg-primary/10 px-1 rounded-sm">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-foreground/90">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 pl-4 py-2 border-l-[3px] border-primary/50 bg-primary/[0.03] rounded-r-xl text-foreground/80 text-sm sm:text-[15px] italic shadow-inner">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className || '');
    if (!match) {
      return <code className="px-1.5 py-0.5 mx-0.5 rounded-md bg-secondary/60 border border-border/40 text-primary font-mono text-[0.85em]">{children}</code>;
    }
    return <CodeBlock language={match[1]} onOpenArtifact={onOpenArtifact}>{String(children).replace(/\n$/, '')}</CodeBlock>;
  },
  pre: ({ children }) => <>{children}</>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-accent font-medium underline underline-offset-4 decoration-primary/30 hover:decoration-accent transition-colors">{children}</a>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-border/40 shadow-md">
      <table className="w-full text-xs sm:text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="px-4 py-2.5 text-left font-bold bg-primary/10 border-b border-border/40 text-foreground">{children}</th>,
  td: ({ children }) => <td className="px-4 py-2.5 border-b border-border/20 text-foreground/85">{children}</td>,
  hr: () => <hr className="my-6 border-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />,
  img: ({ src, alt }) => {
    if (src && (src.startsWith('data:image') || src.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i))) {
      return (
        <span className="block my-4 rounded-xl overflow-hidden border border-border/30 shadow-xl">
          <img src={src} alt={alt || 'Generated image'} className="w-full h-auto block" loading="lazy" />
        </span>
      );
    }
    return (
      <span className="block my-4 rounded-xl overflow-hidden border border-border/30 shadow-xl">
        <img src={src} alt={alt || ''} className="w-full h-auto block" loading="lazy" />
      </span>
    );
  },
 };
}

export default function ChatMessage({ role, content, isStreaming, attachments = [], imageUrl, modelName = "AI", statusText, sources, followUps, files, codeRuns, onFollowUp, onRegenerate, canRegenerate, isArenaMode, arenaResponses, onOpenArtifact, branchIndex, branchCount, onSwitchBranch, canEdit, onEdit }: ChatMessageProps) {
  const isUser = role === 'user';
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedArenaIdx, setCopiedArenaIdx] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  // Inline-edit mode for a user message. Editing is non-destructive upstream
  // (the parent appends a new branch sibling rather than overwriting), so here
  // it's just a local textarea swap with Save/Cancel before we hand the text back.
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(content);
  useEffect(() => { if (!isEditing) setEditDraft(content); }, [content, isEditing]);
  const { speak, stop, isSpeaking, isLoading: isTTSLoading } = useTextToSpeech();

  // Rebuilt only when the open callback changes (i.e. never per chunk in
  // practice) so ReactMarkdown's own memoization is not defeated.
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(onOpenArtifact),
    [onOpenArtifact],
  );

  const displayContent = isUser ? content : sanitizeAssistantText(content);
  const generatedImageUrl = !isUser ? imageUrl || extractFirstMarkdownImage(displayContent) : undefined;
  const strippedContent = !isUser ? stripMarkdownImages(displayContent) : displayContent;

  // ---- Streaming render coalescing ----
  // ReactMarkdown re-parses its entire string on every prop change. While a turn
  // streams, the parent updates `content` on every token (often 20+ per second),
  // so a long answer parses the whole markdown 20×/sec and gets progressively
  // slower — the visible lag users read as "the model is slow". We break that
  // coupling: the raw content is tracked in a ref (free), and a ~60ms timer
  // flushes it into `renderedContent` state. So the parse rate is bounded by the
  // timer, not by the token rate, while the ref always holds the latest text.
  // When not streaming we stay in lock-step with the prop (no timer latency).
  // The ref always tracks the latest text (a ref write is free — no re-render).
  // The timer below copies it into state at a bounded rate.
  const liveContentRef = useRef(strippedContent);
  liveContentRef.current = strippedContent;
  const [renderedContent, setRenderedContent] = useState(strippedContent);
  useEffect(() => {
    if (isUser) return;
    if (!isStreaming) {
      // Final state: snap to the complete content immediately so there is no
      // one-frame lag where the last chunk is absent.
      const next = liveContentRef.current;
      if (renderedContent !== next) setRenderedContent(next);
      return;
    }
    let cancelled = false;
    const flush = () => {
      if (cancelled) return;
      const next = liveContentRef.current;
      setRenderedContent((prev) => (prev === next ? prev : next));
    };
    // rAF-based coalescing: one flush per frame caps the parse rate at the
    // display refresh (≤60/sec, usually far less) and drops work if the tab is
    // backgrounded. A setInterval backstop keeps text advancing even when rAF
    // is throttled to near-zero in a background tab.
    let raf = 0;
    let interval = 0;
    const tick = () => { flush(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    interval = window.setInterval(flush, 120);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (interval) clearInterval(interval);
    };
    // Re-subscribing only on streaming-state change (not on every chunk) keeps
    // the timer stable across the whole turn rather than churning per token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, isUser]);

  // During streaming we drop remark-math + rehype-katex. KaTeX is the heaviest
  // transform here and partial LaTeX (e.g. a lone "$" mid-token) renders jumpy
  // error fallbacks; the full pipeline runs once at completion instead.
  const streamingPlugins = isStreaming && !isUser;
  const textOnlyContent = renderedContent;

  const handleCopyAll = async () => {
    await navigator.clipboard.writeText(textOnlyContent || displayContent);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  const handleCopyArena = async (idx: number, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedArenaIdx(idx);
    setTimeout(() => setCopiedArenaIdx(null), 2000);
  };

  const handleDownloadImage = async () => {
    if (!generatedImageUrl) return;
    try {
      let href = generatedImageUrl;
      if (!href.startsWith('data:')) {
        const res = await fetch(generatedImageUrl);
        const blob = await res.blob();
        href = URL.createObjectURL(blob);
      }
      const a = document.createElement('a');
      a.href = href;
      a.download = `novaris-image-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (!generatedImageUrl.startsWith('data:')) setTimeout(() => URL.revokeObjectURL(href), 4000);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2000);
    } catch (e) {
      console.error('Download failed', e);
    }
  };

  const handleSpeak = () => {
    if (isSpeaking) stop();
    else speak(textOnlyContent || displayContent);
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 15 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ 
        type: "spring", 
        stiffness: 280, 
        damping: 22, 
        mass: 0.9 
      }}
      className={`w-full ${isUser ? 'flex justify-end' : ''}`}
    >
      {isUser ? (
        <div className="max-w-[85%] sm:max-w-[75%]">
          <div className="group/user relative liquid-message-user rounded-2xl rounded-br-md px-5 py-3.5 backdrop-blur-xl">
            {attachments.length > 0 && !isEditing && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="rounded-2xl overflow-hidden border border-primary/20 bg-background/50">
                    {attachment.type === 'image' ? (
                      <img src={attachment.url} alt={attachment.name} className="w-full h-32 object-cover block" loading="lazy" />
                    ) : (
                      <div className="h-32 flex flex-col items-center justify-center gap-2 px-3 text-center bg-background/60">
                        <FileText className="w-6 h-6 text-primary" />
                        <p className="text-xs text-foreground/80 line-clamp-2">{attachment.name}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {isEditing ? (
              <div className="flex flex-col gap-2">
                <textarea
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter submits (Shift+Enter for newline), Escape cancels —
                    // matches the composer's own keymap so editing feels native.
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      const t = editDraft.trim();
                      if (t) { setIsEditing(false); onEdit?.(t); }
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsEditing(false);
                      setEditDraft(content);
                    }
                  }}
                  rows={Math.min(12, Math.max(2, editDraft.split('\n').length))}
                  className="w-full resize-none bg-background/40 border border-primary/30 rounded-xl px-3 py-2 text-sm sm:text-[15px] leading-relaxed text-foreground font-medium focus:outline-none focus:border-primary/60"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setIsEditing(false); setEditDraft(content); }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-foreground/70 hover:text-foreground hover:bg-secondary/60 transition-colors"
                  >Cancel</button>
                  <button
                    type="button"
                    onClick={() => { const t = editDraft.trim(); if (t) { setIsEditing(false); onEdit?.(t); } }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40"
                    disabled={!editDraft.trim() || editDraft.trim() === content.trim()}
                  >Send</button>
                </div>
              </div>
            ) : (
              content && <p className="text-sm sm:text-[15px] leading-relaxed text-foreground font-medium whitespace-pre-wrap break-words">{content}</p>
            )}
            {/* Hover edit affordance — only while not editing and not streaming.
                Editing is non-destructive, so the original wording stays reachable
                via the branch switcher after the conversation reloads. */}
            {!isEditing && canEdit && onEdit && (
              <button
                type="button"
                onClick={() => { setEditDraft(content); setIsEditing(true); }}
                className="absolute -left-9 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-foreground/40 hover:text-foreground hover:bg-secondary/60 opacity-0 group-hover/user:opacity-100 transition-all"
                title="Edit message"
                aria-label="Edit message"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {/* Branch switcher: shows 1/1 guard counts so we only render when this
              message is genuinely one of several siblings. Lives under the bubble
              so it reads visually as belonging to this turn, and disappears for a
              live new send (branchCount undefined → treated as a sole branch). */}
          {branchCount && branchCount > 1 && onSwitchBranch && (
            <div className="mt-1.5 flex items-center justify-center gap-1 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => onSwitchBranch('prev')}
                disabled={(branchIndex ?? 1) <= 1}
                className="p-1 rounded-md hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                aria-label="Previous branch"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="tabular-nums">{branchIndex ?? 1} / {branchCount}</span>
              <button
                type="button"
                onClick={() => onSwitchBranch('next')}
                disabled={(branchIndex ?? 1) >= (branchCount ?? 1)}
                className="p-1 rounded-md hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                aria-label="Next branch"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div
          className={isArenaMode ? 'w-full grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 relative before:hidden md:before:block md:before:absolute md:before:left-1/2 md:before:top-0 md:before:bottom-0 md:before:w-[1px] md:before:bg-gradient-to-b md:before:from-primary/50 md:before:via-accent/40 md:before:to-transparent md:before:-translate-x-1/2' : 'w-full flex flex-col md:flex-row gap-6'}
          /* Announce the reply to assistive tech as it streams in. Without a
             live region a screen-reader user hears nothing until they manually
             navigate to the message — they have no cue the answer has arrived.
             "polite" so it waits for a pause rather than interrupting. */
          role="log"
          aria-live="polite"
          aria-atomic="false"
          aria-busy={isStreaming}
        >
          {/* Primary Model Card (Model A) */}
          <div className={isArenaMode ? 'flex-1 min-w-0 rounded-2xl border border-primary/40 bg-gradient-to-b from-primary/10 via-secondary/20 to-background/60 p-4 sm:p-5 shadow-2xl shadow-primary/10 backdrop-blur-xl relative overflow-hidden transition-all duration-300 hover:border-primary/60 border-t-4 border-t-primary' : 'flex-1 min-w-0'}>
            <div className="flex items-center gap-2 mb-3 justify-between pb-2.5 border-b border-primary/20">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-xl flex items-center justify-center overflow-hidden bg-black/10 shadow-md shadow-primary/20 border border-primary/30">
                  <img src="/flyer-logo.png" alt="Flyer AI" className="w-full h-full object-cover" />
                </div>
                <span className="text-sm font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">{modelName}</span>
                {isArenaMode && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-primary bg-primary/20 border border-primary/40 rounded-full px-2.5 py-0.5 shadow-sm">
                    👑 MODEL A
                  </span>
                )}
                {/* Branch switcher for a regenerated reply — same shape as the
                    user-message one. Pinned in the header so it travels with the
                    turn rather than the (variable) footer actions. */}
                {branchCount && branchCount > 1 && onSwitchBranch && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => onSwitchBranch('prev')}
                      disabled={(branchIndex ?? 1) <= 1}
                      className="p-0.5 rounded-md hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                      aria-label="Previous branch"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <span className="tabular-nums">{branchIndex ?? 1} / {branchCount}</span>
                    <button
                      type="button"
                      onClick={() => onSwitchBranch('next')}
                      disabled={(branchIndex ?? 1) >= (branchCount ?? 1)}
                      className="p-0.5 rounded-md hover:text-foreground hover:bg-secondary/60 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                      aria-label="Next branch"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {canRegenerate && onRegenerate && !isStreaming && (
                  <button type="button" onClick={onRegenerate}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-secondary/50 hover:bg-secondary text-xs text-muted-foreground hover:text-foreground transition-all border border-border/30 hover:border-primary/30"
                    title="Regenerate response">
                    <RefreshCw className="w-3.5 h-3.5" /><span className="hidden sm:inline">Retry</span>
                  </button>
                )}
                <button type="button" onClick={handleSpeak} disabled={isTTSLoading}
                  className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all border ${isSpeaking ? 'bg-primary/20 text-primary border-primary/30' : isTTSLoading ? 'bg-primary/10 text-primary border-primary/20' : 'bg-secondary/50 hover:bg-secondary text-muted-foreground hover:text-foreground border-border/30 hover:border-primary/30'}`}>
                  {isTTSLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isSpeaking ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
                <button type="button" onClick={handleCopyAll}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-secondary/50 hover:bg-secondary text-xs text-muted-foreground hover:text-foreground transition-all border border-border/30 hover:border-primary/30">
                  {copiedAll ? <><Check className="w-3.5 h-3.5 text-primary" /><span className="text-primary font-medium">Copied</span></> : <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>}
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="w-full pt-1">
              {generatedImageUrl && (
                <div className="mb-4 relative group/image rounded-2xl overflow-hidden liquid-surface border border-border/30 shadow-2xl">
                  <img src={generatedImageUrl} alt="Generated image" className="w-full h-auto block" loading="lazy" />
                  <button
                    type="button"
                    onClick={handleDownloadImage}
                    /* max-hover: on touch there is no hover, so without this the
                       only way to save a generated image is a long-press. */
                    className="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-background/70 backdrop-blur-md border border-border/40 text-xs font-medium text-foreground/90 hover:text-primary hover:border-primary/40 opacity-0 group-hover/image:opacity-100 max-hover:opacity-100 transition-all duration-200"
                    title="Download image"
                    aria-label="Download image"
                  >
                    {downloaded ? <><Check className="w-4 h-4 text-primary" />Saved</> : <><Download className="w-4 h-4" />Download</>}
                  </button>
                </div>
              )}

              {textOnlyContent ? (
                <div className="prose prose-sm sm:prose-base prose-invert max-w-none">
                  <ReactMarkdown
                    remarkPlugins={streamingPlugins ? [remarkGfm] : [remarkGfm, remarkMath]}
                    rehypePlugins={streamingPlugins ? [] : [rehypeKatex]}
                    components={markdownComponents}
                  >
                    {textOnlyContent}
                  </ReactMarkdown>
                </div>
              ) : (isStreaming && !isArenaMode) ? (
                <div className="flex items-center gap-3 py-2">
                  <div className="flex gap-1.5">
                    {[0, 1, 2].map((i) => (
                      <motion.span key={i} className="w-2 h-2 rounded-full bg-primary"
                        animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
                        transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.15 }}
                      />
                    ))}
                  </div>
                  <span className="text-xs text-primary/90 font-medium tracking-wide">
                    {statusText || "Generating response..."}
                  </span>
                </div>
              ) : null}

              {isStreaming && content && (
                <motion.span className="inline-block w-0.5 h-4 bg-primary ml-0.5 align-middle rounded-full"
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 0.6, repeat: Infinity }}
                />
              )}
            </div>

            {!isUser && files && files.length > 0 && <FileChips files={files} onOpenFile={(fn) => onOpenArtifact?.(`file:${fn}`)} />}
            {!isUser && codeRuns && codeRuns.length > 0 && <CodeRunBlocks runs={codeRuns} />}
            {!isUser && sources && sources.length > 0 && <SourceChips sources={sources} />}
            {!isUser && !isStreaming && followUps && followUps.length > 0 && onFollowUp && (
              <FollowUpChips followUps={followUps} onFollowUp={onFollowUp} />
            )}
          </div>

          {/* Secondary Models (Arena Mode) — separated by clear line borders */}
          {isArenaMode && arenaResponses?.map((arena, aIdx) => {
            const arenaText = sanitizeAssistantText(arena.content);
            const modelLabel = String.fromCharCode(66 + aIdx);
            return (
              <div key={arena.modelId} className="flex-1 min-w-0 rounded-2xl border border-accent/40 bg-gradient-to-b from-accent/10 via-secondary/20 to-background/60 p-4 sm:p-5 shadow-2xl shadow-accent/10 backdrop-blur-xl relative overflow-hidden transition-all duration-300 hover:border-accent/60 border-t-4 border-t-accent">
                <div className="flex items-center gap-2 mb-3 justify-between pb-2.5 border-b border-accent/20">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-xl liquid-icon flex items-center justify-center bg-accent/20 border border-accent/30 shadow-md shadow-accent/20">
                      <Sparkles className="w-4 h-4 text-accent" />
                    </div>
                    <span className="text-sm font-bold bg-gradient-to-r from-accent via-primary to-accent bg-clip-text text-transparent">
                      {arena.modelName || 'AI'}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-accent bg-accent/20 border border-accent/40 rounded-full px-2.5 py-0.5 shadow-sm">
                      ⚔️ MODEL {modelLabel}
                    </span>
                  </div>
                  {arenaText && (
                    <button type="button" onClick={() => handleCopyArena(aIdx, arenaText)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-secondary/50 hover:bg-secondary text-xs text-muted-foreground hover:text-foreground transition-all border border-border/30 hover:border-accent/30">
                      {copiedArenaIdx === aIdx ? <><Check className="w-3.5 h-3.5 text-accent" /><span className="text-accent font-medium">Copied</span></> : <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>}
                    </button>
                  )}
                </div>

                <div className="prose prose-sm sm:prose-base prose-invert max-w-none pt-1">
                  {arenaText ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {arenaText}
                    </ReactMarkdown>
                  ) : isStreaming ? (
                    <div className="flex items-center gap-3 py-2">
                      <div className="flex gap-1.5">
                        {[0, 1, 2].map((i) => (
                          <motion.span key={i} className="w-2 h-2 rounded-full bg-accent"
                            animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
                            transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.15 }}
                          />
                        ))}
                      </div>
                      <span className="text-xs text-accent/80 font-medium">Generating response...</span>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
