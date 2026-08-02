import { motion } from 'framer-motion';
import { Sparkles, Copy, Check, Volume2, VolumeX, Loader2, FileText, Download, RefreshCw, Globe, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useState } from 'react';
import { useTextToSpeech } from '@/hooks/useTextToSpeech';
import { extractFirstMarkdownImage, sanitizeAssistantText, stripMarkdownImages } from '@/lib/chat-format';
import type { ChatAttachment, MessageSource } from './types';

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
  onRegenerate?: () => void;
  canRegenerate?: boolean;
  isArenaMode?: boolean;
  arenaResponses?: ArenaResponse[];
}

function hostOf(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return link;
  }
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

function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
        <button onClick={handleCopy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background/60 hover:bg-background text-xs text-muted-foreground hover:text-foreground transition-all border border-border/20">
          {copied ? <><Check className="w-3.5 h-3.5 text-primary" /><span className="text-primary font-medium">Copied!</span></> : <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>}
        </button>
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

const MARKDOWN_COMPONENTS: any = {
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
    return <CodeBlock language={match[1]}>{String(children).replace(/\n$/, '')}</CodeBlock>;
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

export default function ChatMessage({ role, content, isStreaming, attachments = [], imageUrl, modelName = "AI", statusText, sources, onRegenerate, canRegenerate, isArenaMode, arenaResponses }: ChatMessageProps) {
  const isUser = role === 'user';
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedArenaIdx, setCopiedArenaIdx] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const { speak, stop, isSpeaking, isLoading: isTTSLoading } = useTextToSpeech();

  const displayContent = isUser ? content : sanitizeAssistantText(content);
  const generatedImageUrl = !isUser ? imageUrl || extractFirstMarkdownImage(displayContent) : undefined;
  const textOnlyContent = !isUser ? stripMarkdownImages(displayContent) : displayContent;

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
          <div className="liquid-message-user rounded-2xl rounded-br-md px-5 py-3.5 backdrop-blur-xl">
            {attachments.length > 0 && (
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
            {content && <p className="text-sm sm:text-[15px] leading-relaxed text-foreground font-medium whitespace-pre-wrap break-words">{content}</p>}
          </div>
        </div>
      ) : (
        <div className={isArenaMode ? 'w-full grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 relative before:hidden md:before:block md:before:absolute md:before:left-1/2 md:before:top-0 md:before:bottom-0 md:before:w-[1px] md:before:bg-gradient-to-b md:before:from-primary/50 md:before:via-accent/40 md:before:to-transparent md:before:-translate-x-1/2' : 'w-full flex flex-col md:flex-row gap-6'}>
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
                    className="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-background/70 backdrop-blur-md border border-border/40 text-xs font-medium text-foreground/90 hover:text-primary hover:border-primary/40 opacity-0 group-hover/image:opacity-100 transition-all duration-200"
                    title="Download image"
                  >
                    {downloaded ? <><Check className="w-4 h-4 text-primary" />Saved</> : <><Download className="w-4 h-4" />Download</>}
                  </button>
                </div>
              )}

              {textOnlyContent ? (
                <div className="prose prose-sm sm:prose-base prose-invert max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={MARKDOWN_COMPONENTS}
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

            {!isUser && sources && sources.length > 0 && <SourceChips sources={sources} />}
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
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
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
