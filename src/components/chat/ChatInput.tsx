import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Mic, Square, ImagePlus, X, FileText, Atom, Globe, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useSpeechToText } from '@/hooks/useSpeechToText';
import { cn } from '@/lib/utils';

/**
 * Per-file attachment ceiling.
 *
 * Not a limit on what can be *read* — documents.ts reads from bounded slices and
 * would happily summarise a 500 MB log. It is a limit on what can be carried: each
 * attachment becomes a base64 data URL for the preview and the saved transcript,
 * which is 4/3 of the file in a string, in memory, per attachment, times up to ten.
 *
 * 25 MB is above every real document (a 400-page PDF is ~10 MB, a photo from a
 * phone ~5 MB) and below the sizes that hurt.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const formatSize = (bytes: number) => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

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
  //
  // There is deliberately no processing flag beside it. Recognition runs on the live
  // microphone stream and the browser hands back transcripts directly — no blob is uploaded
  // and nothing is transcribed after the fact — so there is no state between "listening" and
  // "the text is in the composer". A `const isProcessing = false` used to sit here and drive
  // three branches that could never render: a disabled mic button, a second colour scheme,
  // and a spinner. Branches that cannot run are not defensive, they are unreadable.
  const isRecording = isListening;

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

  // Enter sends, Shift+Enter inserts a newline — the convention every chat app
  // uses, and its absence is the most jarring thing about typing here.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing guards IME input: while composing Japanese/Chinese/Korean
    // text, Enter commits the candidate word and must NOT send the message.
    // keyCode 229 is the legacy signal for the same thing in older WebKit.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  };

  const submitMessage = () => {
    if ((message.trim() || selectedFiles.length > 0) && !isLoading && !disabled) {
      // Deliberately NOT blurring: with interactive-widget=resizes-content the
      // keyboard closing resizes the viewport and reflows the whole thread,
      // which loses your place on every single send. Native chat apps keep the
      // keyboard up so you can fire off consecutive messages.
      onSend(message.trim(), selectedFiles);
      // Sending is the clearest "I am done talking" there is, so it releases the mic.
      // Without this the engine stayed live across a send: `message` was cleared, so the
      // button that had been reading "Stop recording" went back to reading "Start voice
      // input" over an empty composer while the microphone was still open, and the next
      // phrase landed after the message the user thought they had finished.
      if (isRecording) stop();
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitMessage();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const incomingFiles = Array.from(event.target.files || []);
    if (!incomingFiles.length) return;

    // The picker no longer filters by extension, so this is the only thing standing
    // between the composer and a 4 GB disk image. The read path itself is bounded
    // (documents.ts slices rather than loading whole files), but every attachment is
    // also base64-encoded into a data URL for the preview and the transcript, and
    // base64 of a multi-gigabyte file is the tab dying with no message on screen.
    //
    // Refused per file rather than in aggregate, and the rest of the selection is
    // still accepted: dropping four readable files because the fifth was a video is
    // a worse outcome than reading four and saying why the fifth was skipped.
    const accepted: File[] = [];
    for (const file of incomingFiles) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`${file.name} is too large to attach (${formatSize(file.size)}). The limit is ${formatSize(MAX_ATTACHMENT_BYTES)}.`);
      } else {
        accepted.push(file);
      }
    }
    if (!accepted.length) return;

    setSelectedFiles((prev) => [...prev, ...accepted].slice(0, 10));

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

  // The contract state. The composer is a one-line pill while it holds nothing —
  // the reference shape: attach, a single line of text, the mode toggle, mic and
  // send all sharing one baseline — and opens into a panel only once there is
  // something to give room to: a draft (which may grow to the 120px textarea cap),
  // an attachment preview row, or a live dictation session.
  //
  // Focus is deliberately NOT part of this condition. An empty focused composer is
  // exactly the state the pill shape was designed for — caret in, controls inline,
  // still one tight line — and keying the expansion on focus would pop the bar open
  // under the user's thumb on every tap, which is the opposite of contracting.
  const hasDraft = message.trim().length > 0 || selectedFiles.length > 0;
  const isContracted = !hasDraft && !isRecording && !isFocused;
  // One radius expression shared by the hairline, the shell and the clipped
  // background wrapper so the three layers that draw the border never disagree
  // mid-transition.
  const shellRadius = isContracted ? 'rounded-full' : 'rounded-2xl sm:rounded-3xl';

  // No pb-* on the wrapper below: .safe-area-inset-bottom supplies it via
  // calc(0.75rem + env(safe-area-inset-bottom)) so the composer clears the
  // home indicator instead of sitting under it.
  return (
    <div className="px-3 pt-2 sm:px-4 lg:px-6 bg-gradient-to-t from-background via-background/95 to-transparent safe-area-inset-bottom">
      <form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
        {/* Native focus treatment — see the note below on what this replaced. */}
        {/* `disabled` used to be honoured only functionally: every control stopped
            responding and nothing looked any different, so the composer sat there
            reading "Ask X anything…" and silently swallowed clicks and keystrokes.
            A dead control that still looks live is the exact failure this pass
            exists to remove — and the one caller that sets `disabled` is the
            messages-read-failed state (§14.2 bug 7), i.e. it is showing precisely
            when the user is already confused about why the app looks empty.

            Dimming rather than `cursor: not-allowed`: the crossed circle is a web
            convention that #5 deliberately removed app-wide, and greyed-out
            styling is what communicates unavailability natively. `pointer-events`
            is left alone — the individual controls carry real `disabled`
            attributes, which keeps them out of the tab order too, and blocking
            pointer events on the wrapper would also block text selection inside
            it. */}
        <div className={cn('relative transition-opacity duration-150', disabled && 'opacity-50')}>
          {/* This used to be two stacked motion.div layers painting spinning
              conic-gradient rainbows: `--angle` animated 0deg→360deg with
              `repeat: Infinity` on both, plus a blurred outer glow pulsing its
              opacity on a second infinite loop. Removed in the native-look pass
              (§14) for two reasons.

              Aesthetic: a perpetually rotating rainbow around the text field is
              the loudest "web toy" signal in the app, and it is the surface the
              user looks at most.

              Cost: `--angle` was a registered @property, so each frame
              regenerated a conic gradient — on two layers, one of them behind a
              `blur-md`. Two always-on compositor loops on the composer alone,
              running whether or not the user was typing.

              What a native composer does instead is exactly this: a hairline that
              picks up the accent colour on focus, and a soft ring outside it. The
              -inset-px element is the hairline (the inner container paints over
              all but its outermost pixel); the box-shadow is the ring. The only
              motion left is a 150ms colour transition, which is a state change
              rather than decoration — so it also needs no reduced-motion carve-out. */}
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute -inset-px transition-all duration-200',
              shellRadius,
              isRecording
                ? 'bg-destructive/60 shadow-[0_0_0_3px_hsl(var(--destructive)/0.15)]'
                : isFocused
                  ? 'bg-primary/50 shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]'
                  : 'bg-border/70',
            )}
          />

          {/* Inner container. NOTE: overflow-hidden must NOT live here — the "+"
              menu renders above the bar (bottom-full) and a clip on this element
              cuts off every item except the bottom-most one. The background
              layers get their own clipped wrapper instead so the rounded corners
              still mask the gradient and blur. */}
          <div className={cn('relative liquid-composer transition-[border-radius] duration-200', shellRadius)}>
            <div className={cn('absolute inset-0 overflow-hidden', shellRadius)}>
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
            <div className="relative px-1.5 py-1 sm:px-2 sm:py-1.5">
              {previews.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1 pt-1 px-1 scrollbar-thin">
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
                          /* max-hover: keeps this visible on touch devices, where
                             group-hover never fires and the only way to remove an
                             attachment would otherwise be to send it. */
                          className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 hover:bg-destructive/80 text-white backdrop-blur-md border border-white/10 flex items-center justify-center z-20 opacity-0 group-hover/file:opacity-100 max-hover:opacity-100 transition-all scale-75 group-hover/file:scale-100 max-hover:scale-100"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* No `accept`, deliberately.

                  It used to carry a closed list of 18 extensions
                  (image/*,.pdf,.txt,.md,.json,.csv,.doc…), which was wrong in
                  both directions. It was narrower than the extractor, which
                  already read ~40 text extensions, so a .yaml or a .go could not
                  be picked from the dialog even though the pipeline handled it
                  perfectly — and dragging the same file in worked, because
                  `accept` filters the picker and nothing else. And it is now
                  narrower than the truth: src/lib/documents.ts reads any file,
                  falling back to a byte sniff and then to naming the format, so
                  there is no extension left to filter out.

                  Removing it rather than widening it to a longer list: an
                  exhaustive `accept` would be a second copy of the extractor's
                  format knowledge, kept in sync by hand, in a component that has
                  no other reason to know any of it. iOS still offers Photo
                  Library and Take Photo for an unfiltered file input, so the
                  image affordance survives. */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileChange}
                className="hidden"
              />

              {/* One row, always. The old bar stacked a full-width textarea over a
                  second row of controls; that second row is a permanent ~44px of
                  height the composer paid even when empty, and it is what made the
                  bar read as a panel rather than the pill the reference shape is.
                  Everything now shares one baseline — attach, the growing
                  textarea, the mode toggle, mic, send — with `items-end` so the
                  buttons stay pinned to the last text line as the draft grows
                  instead of drifting to the vertical middle of a tall textarea.

                  The "+" menu keeps Attach and Search; DeepThink moved out of it
                  and onto the row as the inline Think chip, because a toggle that
                  lives only inside a menu is invisible exactly when you are
                  deciding whether to turn it on. */}
              <div className="flex items-end gap-0.5 sm:gap-1">
                <div className="relative flex-shrink-0" ref={plusMenuRef}>
                  <motion.button
                    type="button"
                    onClick={() => setPlusOpen((v) => !v)}
                    disabled={isLoading || disabled}
                    aria-label="More options"
                    aria-expanded={plusOpen}
                    aria-haspopup="menu"
                    className={`
                      relative w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center
                      border transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed
                      ${plusOpen
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

                {/* The growing middle. min-w-0 so a long unbroken draft can shrink
                    the field and scroll inside it rather than pushing the send
                    button off the row. */}
                <div className="flex-1 min-w-0 flex items-center">
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
                    /* Not disabled while recording. Transcription mishears words often enough
                       that being unable to fix one until the engine releases the mic is a dead
                       end rather than a safeguard — and it was worse than that: the mic button
                       used to unmount as soon as dictation produced text (see the render
                       condition below), so no control was left to release it with. The
                       "Listening..." placeholder above is what signals the state. */
                    disabled={disabled}
                    rows={1}
                    aria-label="Message input"
                    /* Focus target for the app-wide keyboard layer (Cmd/Ctrl+L, and
                       type-anywhere-to-focus) — see src/lib/shortcuts.ts. An attribute
                       rather than a ref threaded down through props: the concern is
                       "whatever is the composer on this page", the shortcut hook lives
                       two levels up and does not otherwise know this component exists,
                       and a data attribute says out loud that something outside is
                       looking for this node. aria-label would have worked as a selector
                       too, and is exactly the wrong thing to build on — it is user-
                       facing copy and will be reworded by someone who has no reason to
                       suspect a keyboard shortcut depends on the wording. */
                    data-flyer-composer=""
                    /* text-base (16px) on mobile is deliberate, not a style choice:
                       iOS Safari zooms the whole viewport when a focused field's
                       text is under 16px, and never zooms back out. sm: restores
                       the intended 15px on larger screens. */
                    className="w-full bg-transparent border-0 resize-none focus:outline-none focus:ring-0 text-foreground placeholder:text-muted-foreground/50 py-2 px-1 sm:py-2.5 sm:px-1.5 max-h-[120px] scrollbar-thin text-base sm:text-[15px] leading-snug font-medium"
                    onKeyDown={handleKeyDown}
                    enterKeyHint="send"
                  />
                </div>

                {/* Trailing controls, right-hand end of the same row. */}
                <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
                  {/* DeepThink as an inline chip rather than a menu item: the
                      reference row carries its reasoning toggle in the open, and a
                      toggle hidden behind "+" is undiscoverable at exactly the
                      moment it matters — before typing. Icon-only below md so the
                      row still fits a 360px phone with the mic and send beside it;
                      the aria-label names it for screen readers and for the narrow
                      case where the visible word is hidden. */}
                  {modelKind !== 'Image' && onToggleDeepThink && (
                    <button
                      type="button"
                      onClick={onToggleDeepThink}
                      aria-label="DeepThink"
                      aria-pressed={deepThink}
                      title="Force step-by-step extended reasoning"
                      className={cn(
                        'flex items-center gap-1 h-8 sm:h-9 px-1.5 sm:px-2.5 rounded-full text-[12px] font-semibold transition-colors flex-shrink-0',
                        deepThink
                          ? 'bg-primary/20 text-primary border border-primary/50'
                          : 'text-muted-foreground/70 hover:text-foreground border border-transparent hover:border-border/40',
                      )}
                    >
                      <Atom className="w-[15px] h-[15px] flex-shrink-0" />
                      <span className="hidden md:inline">Think</span>
                    </button>
                  )}

                  {/* Search keeps a chip of its own once enabled, so the grounded
                      state stays visible after the menu closes — same rule the old
                      active-mode chips followed, now living on the row. */}
                  {webSearch && (
                    <button
                      type="button"
                      onClick={onToggleWebSearch}
                      title="Search enabled — click to turn off"
                      className="flex items-center gap-1 h-8 px-1.5 sm:h-9 sm:px-2.5 rounded-full text-[12px] font-semibold bg-primary/20 text-primary border border-primary/50 flex-shrink-0"
                    >
                      <Globe className="w-[15px] h-[15px] flex-shrink-0" />
                      <span className="hidden md:inline">Search</span>
                    </button>
                  )}

                  {/* Voice — browser Web Speech API (live transcription). Hidden once
                      there's content to send, so send takes the slot — but NEVER while the
                      engine is live, which is the whole of `isRecording ||` below.
                      Dictating flips `canSend` on the first word (`onResult` writes into
                      `message`), and this button is the only control that calls `stop()`, so
                      under `!canSend` alone it unmounted mid-sentence and left the
                      microphone open with nothing to close it. */}
                  {isSupported && (isRecording || (!canSend && !isLoading)) && (
                <motion.button
                  type="button"
                  onClick={handleVoiceClick}
                  className={`
                    relative w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center
                    transition-all duration-300 overflow-hidden
                    ${isRecording
                      ? 'bg-destructive/20 text-destructive border border-destructive/30'
                      : 'liquid-surface text-muted-foreground/70 hover:text-foreground border border-border/30 hover:border-primary/30'
                    }
                  `}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  aria-label={isRecording ? "Stop recording" : "Start voice input"}
                >
                  {isRecording ? (
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
                        className="relative w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center bg-destructive/20 text-destructive border border-destructive/30 hover:bg-destructive/30 transition-all duration-200"
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
                          relative w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center
                          transition-all duration-150 overflow-hidden
                          ${canSend
                            ? 'bg-gradient-to-br from-primary via-primary to-accent text-primary-foreground shadow-[0_1px_3px_hsl(0_0%_0%/0.3)] border border-primary/50'
                            : 'bg-muted/50 text-muted-foreground/30 cursor-not-allowed'
                          }
                        `}
                        /* Toned to native press behaviour. Was:
                             whileHover={{ scale: 1.08, y: -1, boxShadow: '0 0 24px hsla(var(--primary)/0.8)' }}
                             whileTap={{ scale: 0.9, rotate: -10 }}
                           and a resting `shadow-[0_0_16px_hsla(var(--primary)/0.6)]`.

                           Three separate things there read as web rather than app.
                           The resting state glowed — a 16px coloured halo at 0.6
                           alpha, which is a neon effect, not a shadow; it is now a
                           1px contact shadow, the same thing every platform puts
                           under a raised control. The tap rotated the button 10
                           degrees, and physical buttons do not twist when pressed.
                           And `duration-300` made the whole thing feel soft; native
                           controls respond in roughly 100-150ms, which is why the
                           transition came down to 150.

                           `scale: 1.03` on hover and `0.94` on press keep the
                           control feeling live without launching it off the
                           surface. */
                        whileHover={canSend ? { scale: 1.03 } : {}}
                        whileTap={canSend ? { scale: 0.94 } : {}}
                      >
                        {/* A permanent white shimmer used to sweep this button here —
                            `animate={{ opacity: [0, 0.4, 0] }}` on a 1.5s infinite
                            loop, mounted whenever `canSend` was true.

                            It is the clearest case in the app of the distinction
                            this pass turns on. The recording pulse a few lines up
                            is kept, and so are the streaming dots and the caret,
                            because each one reports something that is genuinely
                            happening right now: the mic is live, tokens are
                            arriving. This one fired because a button was *enabled*.
                            A native send button that is ready to send simply looks
                            ready — it does not glimmer to remind you.

                            The button still has plenty of feedback, all of it tied
                            to real input: `whileHover` lift, `whileTap` press, and
                            the enabled/disabled colour swap in the className. */}
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