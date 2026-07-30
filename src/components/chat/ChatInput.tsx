import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Mic, Square, Loader2, ImagePlus, X, FileText, Atom, Globe, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useSpeechToText } from '@/hooks/useSpeechToText';

// Single source of truth for the accent palette — the header swatch row and the
// composer's "+" menu both render from this, so they can't drift apart.
export const ACCENT_COLORS = [
  { name: 'Teal', value: '172 66% 50%', bg: 'bg-[#1ad1b9]' },
  { name: 'Blue', value: '210 90% 55%', bg: 'bg-[#258eff]' },
  { name: 'Purple', value: '270 85% 60%', bg: 'bg-[#984cff]' },
  { name: 'Rose', value: '340 85% 55%', bg: 'bg-[#ff2d74]' },
  { name: 'Amber', value: '30 95% 55%', bg: 'bg-[#ff8f1f]' },
  { name: 'Emerald', value: '145 75% 45%', bg: 'bg-[#1cb866]' },
];

interface ChatInputProps {
  onSend: (message: string, files?: File[]) => void;
  isLoading: boolean;
  disabled?: boolean;
  onStop?: () => void;
  modelName?: string;
  modelKind?: 'Chat' | 'Vision' | 'Image';
  deepThink?: boolean;
  onToggleDeepThink?: () => void;
  webSearch?: boolean;
  onToggleWebSearch?: () => void;
  accentColor?: string;
  onSelectAccent?: (value: string) => void;
}

export default function ChatInput({
  onSend,
  isLoading,
  disabled,
  onStop,
  modelName = "Flyer",
  modelKind = 'Chat',
  deepThink = false,
  onToggleDeepThink,
  webSearch = false,
  onToggleWebSearch,
  accentColor,
  onSelectAccent,
}: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  
  const { start, stop, isListening, isSupported } = useSpeechToText({
    onResult: (text) => {
      setMessage((prev) => (prev ? `${prev} ${text}` : text));
    },
    onError: (err) => {
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        toast.error('Microphone access was blocked. Enable it in your browser settings.');
      } else if (err !== 'aborted' && err !== 'no-speech') {
        toast.error('Voice input failed. Please try again.');
      }
    },
  });

  // Keep the recording flag name the UI already animates on.
  const isRecording = isListening;
  const isProcessing = false;

  const previews = useMemo(
    () => selectedFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [selectedFiles],
  );

  useEffect(() => {
    return () => {
      previews.forEach((preview) => URL.revokeObjectURL(preview.url));
    };
  }, [previews]);

  // Auto-focus on mount (only on desktop to avoid keyboard springing up on mobile)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (textareaRef.current && !disabled && window.innerWidth > 768) {
        textareaRef.current.focus();
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [disabled]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      // Keep in sync with the textarea's max-h-[120px] class — a mismatch lets
      // the inline height grow past the CSS cap and clips the last line.
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [message]);

  // Dismiss the "+" menu on outside click or Escape so it never traps taps on
  // mobile, where there's no hover affordance to signal it's still open.
  useEffect(() => {
    if (!plusOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!plusMenuRef.current?.contains(e.target as Node)) setPlusOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlusOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [plusOpen]);

  const handleVoiceClick = () => {
    if (!isSupported) {
      toast.error("Voice input isn't supported in this browser. Try Chrome or Edge.");
      return;
    }
    if (isRecording) {
      stop();
    } else {
      start();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((message.trim() || selectedFiles.length > 0) && !isLoading && !disabled) {
      textareaRef.current?.blur();
      onSend(message.trim(), selectedFiles);
      setMessage('');
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const incomingFiles = Array.from(event.target.files || []);
    if (!incomingFiles.length) return;

    setSelectedFiles((prev) => [...prev, ...incomingFiles].slice(0, 10));

    if (event.target) {
      event.target.value = '';
    }
  };

  const removeFile = (fileName: string) => {
    setSelectedFiles((prev) => prev.filter((file) => `${file.name}-${file.size}` !== fileName));
  };

  const handleStop = () => {
    if (onStop) {
      onStop();
    }
  };

  const canSend = (!!message.trim() || selectedFiles.length > 0) && !isLoading && !disabled;
  const isImageFile = (file: File) => file.type.startsWith('image/');

  return (
    <div className="px-3 pb-3 pt-2 sm:px-4 sm:pb-4 lg:px-6 bg-gradient-to-t from-background via-background/95 to-transparent safe-area-inset-bottom">
      <form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
        {/* Futuristic rotating border container */}
        <div className="relative">
          {/* Animated gradient border */}
          <motion.div
            className="absolute -inset-[2px] rounded-2xl sm:rounded-3xl opacity-80"
            style={{
              background: isFocused || isRecording
                ? 'conic-gradient(from var(--angle), hsl(var(--primary)), hsl(200 80% 50%), hsl(280 70% 50%), hsl(320 70% 50%), hsl(var(--primary)))'
                : 'conic-gradient(from var(--angle), hsl(var(--primary) / 0.3), hsl(200 80% 50% / 0.3), hsl(var(--primary) / 0.3))',
            }}
            animate={{
              '--angle': ['0deg', '360deg'],
            } as never}
            transition={{
              duration: isFocused || isRecording ? 3 : 8,
              repeat: Infinity,
              ease: 'linear',
            }}
          />
          
          {/* Blur glow effect */}
          <motion.div
            className="absolute -inset-[3px] rounded-2xl sm:rounded-3xl blur-md"
            style={{
              background: isRecording 
                ? 'conic-gradient(from var(--angle), hsl(0 72% 51% / 0.5), hsl(320 70% 50% / 0.5), hsl(0 72% 51% / 0.5))'
                : 'conic-gradient(from var(--angle), hsl(var(--primary) / 0.4), hsl(200 80% 50% / 0.4), hsl(280 70% 50% / 0.4), hsl(320 70% 50% / 0.4), hsl(var(--primary) / 0.4))',
            }}
            animate={{
              '--angle': ['0deg', '360deg'],
              opacity: isFocused || isRecording ? [0.5, 0.8, 0.5] : [0.2, 0.3, 0.2],
            } as never}
            transition={{
              '--angle': { duration: 4, repeat: Infinity, ease: 'linear' },
              opacity: { duration: 2, repeat: Infinity, ease: 'easeInOut' },
            }}
          />

          {/* Inner container. NOTE: overflow-hidden must NOT live here — the "+"
              menu renders above the bar (bottom-full) and a clip on this element
              cuts off every item except the bottom-most one. The background
              layers get their own clipped wrapper instead so the rounded corners
              still mask the gradient and blur. */}
          <div className="relative liquid-composer rounded-2xl sm:rounded-3xl">
            <div className="absolute inset-0 rounded-2xl sm:rounded-3xl overflow-hidden">
              {/* Glass background */}
              <div className={`
                absolute inset-0 transition-all duration-500
                ${isRecording
                  ? 'bg-gradient-to-br from-destructive/20 via-destructive/10 to-secondary/60'
                  : isFocused
                    ? 'bg-gradient-to-br from-secondary/70 via-secondary/50 to-primary/10'
                    : 'bg-secondary/30'
                }
              `} />
              <div className="absolute inset-0 backdrop-blur-2xl" />
            </div>

            {/* Content */}
            <div className="relative px-2 py-1.5 sm:px-2.5 space-y-1">
              {previews.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
                  {previews.map(({ file, url }) => {
                    const fileKey = `${file.name}-${file.size}`;

                    return (
                      <div key={fileKey} className="group/file relative w-14 h-14 sm:w-16 sm:h-16 rounded-xl overflow-hidden border border-primary/20 bg-background/50 flex-shrink-0 shadow-md transition-transform hover:scale-[1.03] hover:border-primary/50 hover:shadow-primary/20">
                        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover/file:opacity-100 transition-opacity z-10 pointer-events-none" />
                        
                        {isImageFile(file) ? (
                          <img src={url} alt={file.name} className="w-full h-full object-cover relative z-0" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center gap-1 px-1 text-center bg-secondary/30 relative z-0">
                            <FileText className="w-5 h-5 text-primary/80 drop-shadow-md" />
                            <span className="text-[9px] font-medium leading-tight text-foreground/90 line-clamp-2">{file.name}</span>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => removeFile(fileKey)}
                          className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 hover:bg-destructive/80 text-white backdrop-blur-md border border-white/10 flex items-center justify-center z-20 opacity-0 group-hover/file:opacity-100 transition-all scale-75 group-hover/file:scale-100"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.js,.ts,.tsx,.jsx,.py,.html,.css"
                multiple
                onChange={handleFileChange}
                className="hidden"
              />

              {/* Row 1: the textarea spans the full width, ChatGPT-style. */}
              <textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder={
                  isRecording
                    ? "🎤 Listening..."
                    : modelKind === 'Image'
                      ? `Describe an image for ${modelName} to create...`
                      : modelKind === 'Vision'
                        ? `Upload an image and ask ${modelName} about it...`
                        : `Ask ${modelName} anything...`
                }
                disabled={disabled || isRecording}
                rows={1}
                aria-label="Message input"
                className="w-full bg-transparent border-0 resize-none focus:outline-none focus:ring-0 text-foreground placeholder:text-muted-foreground/50 py-1 px-1.5 max-h-[120px] scrollbar-thin text-sm sm:text-[15px] leading-snug font-medium"
              />

              {/* Row 2: a "+" menu holds attach/DeepThink/Search so the bar stays
                  one line on mobile. Mic sits in the send slot until there's
                  something to send, exactly like ChatGPT. */}
              <div className="flex items-center gap-1.5">
                <div className="relative flex-shrink-0" ref={plusMenuRef}>
                  <motion.button
                    type="button"
                    onClick={() => setPlusOpen((v) => !v)}
                    disabled={isLoading || disabled}
                    aria-label="More options"
                    aria-expanded={plusOpen}
                    aria-haspopup="menu"
                    className={`
                      relative w-9 h-9 rounded-full flex items-center justify-center
                      border transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed
                      ${plusOpen || deepThink || webSearch
                        ? 'bg-primary/20 text-primary border-primary/50'
                        : 'liquid-surface text-muted-foreground/70 hover:text-foreground border-border/30 hover:border-primary/30'
                      }
                    `}
                    whileHover={{ scale: isLoading || disabled ? 1 : 1.05 }}
                    whileTap={{ scale: isLoading || disabled ? 1 : 0.95 }}
                  >
                    <motion.span animate={{ rotate: plusOpen ? 45 : 0 }} transition={{ duration: 0.2 }}>
                      <Plus className="w-[18px] h-[18px]" />
                    </motion.span>
                  </motion.button>

                  <AnimatePresence>
                    {plusOpen && (
                      <motion.div
                        role="menu"
                        initial={{ opacity: 0, y: 8, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.95 }}
                        transition={{ duration: 0.15 }}
                        className="absolute bottom-full left-0 mb-2 z-50 w-[152px] rounded-xl border border-border/50 bg-popover/95 backdrop-blur-2xl shadow-xl p-1 space-y-0.5"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => { fileInputRef.current?.click(); setPlusOpen(false); }}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-foreground/90 hover:bg-secondary/70 transition-colors"
                        >
                          <ImagePlus className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>Attach</span>
                        </button>

                        <button
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={deepThink}
                          onClick={() => { onToggleDeepThink?.(); setPlusOpen(false); }}
                          title="Force step-by-step extended reasoning"
                          className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                            deepThink ? 'bg-primary/15 text-primary' : 'text-foreground/90 hover:bg-secondary/70'
                          }`}
                        >
                          <Atom className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>DeepThink</span>
                          {deepThink && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />}
                        </button>

                        <button
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={webSearch}
                          onClick={() => { onToggleWebSearch?.(); setPlusOpen(false); }}
                          title="Always ground this answer in live web results"
                          className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                            webSearch ? 'bg-primary/15 text-primary' : 'text-foreground/90 hover:bg-secondary/70'
                          }`}
                        >
                          <Globe className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>Search</span>
                          {webSearch && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />}
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Active-mode chips: keep the enabled state visible once the
                    menu is closed. Icon-only on mobile so nothing wraps. */}
                {deepThink && (
                  <button
                    type="button"
                    onClick={onToggleDeepThink}
                    title="DeepThink enabled — click to turn off"
                    className="flex items-center gap-1 h-7 px-2 rounded-full text-[11px] font-semibold bg-primary/20 text-primary border border-primary/50 flex-shrink-0"
                  >
                    <Atom className="w-[13px] h-[13px]" />
                    <span className="hidden sm:inline">DeepThink</span>
                  </button>
                )}
                {webSearch && (
                  <button
                    type="button"
                    onClick={onToggleWebSearch}
                    title="Search enabled — click to turn off"
                    className="flex items-center gap-1 h-7 px-2 rounded-full text-[11px] font-semibold bg-primary/20 text-primary border border-primary/50 flex-shrink-0"
                  >
                    <Globe className="w-[13px] h-[13px]" />
                    <span className="hidden sm:inline">Search</span>
                  </button>
                )}

                <div className="flex-1 min-w-0" />

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* Voice — browser Web Speech API (live transcription). Hidden
                      once there's content to send, so send takes the slot. */}
                  {isSupported && !canSend && !isLoading && (
                <motion.button
                  type="button"
                  onClick={handleVoiceClick}
                  disabled={isProcessing}
                  className={`
                    relative w-9 h-9 rounded-full flex items-center justify-center
                    transition-all duration-300 overflow-hidden
                    ${isRecording
                      ? 'bg-destructive/20 text-destructive border border-destructive/30'
                      : isProcessing
                        ? 'bg-primary/20 text-primary border border-primary/30'
                        : 'liquid-surface text-muted-foreground/70 hover:text-foreground border border-border/30 hover:border-primary/30'
                    }
                  `}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  aria-label={isRecording ? "Stop recording" : "Start voice input"}
                >
                  {isProcessing ? (
                    <Loader2 className="w-[17px] h-[17px] animate-spin" />
                  ) : isRecording ? (
                    <>
                      <motion.div
                        className="absolute inset-0 bg-destructive/20"
                        animate={{ opacity: [0.3, 0.6, 0.3] }}
                        transition={{ duration: 1, repeat: Infinity }}
                      />
                      <Square className="w-3.5 h-3.5 relative z-10 fill-current" />
                    </>
                  ) : (
                    <Mic className="w-[17px] h-[17px]" />
                  )}
                </motion.button>
                  )}

                  {/* Send/Stop button */}
                  <AnimatePresence mode="wait">
                    {isLoading ? (
                      <motion.button
                        key="stop"
                        type="button"
                        onClick={handleStop}
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.8, opacity: 0 }}
                        className="relative w-9 h-9 rounded-full flex items-center justify-center bg-destructive/20 text-destructive border border-destructive/30 hover:bg-destructive/30 transition-all duration-200"
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        aria-label="Stop generating"
                      >
                        <Square className="w-3.5 h-3.5 fill-current" />
                      </motion.button>
                    ) : (
                      <motion.button
                        key="send"
                        type="submit"
                        disabled={!canSend}
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.8, opacity: 0 }}
                        aria-label="Send message"
                        className={`
                          relative w-9 h-9 rounded-full flex items-center justify-center
                          transition-all duration-300 overflow-hidden
                          ${canSend
                            ? 'bg-gradient-to-br from-primary via-primary to-accent text-primary-foreground shadow-[0_0_16px_hsla(var(--primary)/0.6)] border border-primary/50'
                            : 'bg-muted/50 text-muted-foreground/30 cursor-not-allowed'
                          }
                        `}
                        whileHover={canSend ? { scale: 1.08, y: -1, boxShadow: '0 0 24px hsla(var(--primary)/0.8)' } : {}}
                        whileTap={canSend ? { scale: 0.9, rotate: -10 } : {}}
                      >
                        {canSend && (
                          <motion.div
                            className="absolute inset-0 bg-white/20"
                            animate={{ opacity: [0, 0.4, 0] }}
                            transition={{ duration: 1.5, repeat: Infinity }}
                          />
                        )}
                        <Send className="w-[17px] h-[17px] relative z-10" />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
