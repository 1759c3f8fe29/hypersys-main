import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Sparkles, Mic, Square, Loader2, ImagePlus, X, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useSpeechToText } from '@/hooks/useSpeechToText';

interface ChatInputProps {
  onSend: (message: string, files?: File[]) => void;
  isLoading: boolean;
  disabled?: boolean;
  onStop?: () => void;
  modelName?: string;
  modelKind?: 'Chat' | 'Vision' | 'Image';
}

export default function ChatInput({ onSend, isLoading, disabled, onStop, modelName = "Flyer", modelKind = 'Chat' }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
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

  // Auto-focus on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      if (textareaRef.current && !disabled) {
        textareaRef.current.focus();
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [disabled]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
    }
  }, [message]);

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
    <div className="p-3 sm:p-4 lg:p-6 bg-gradient-to-t from-background via-background/95 to-transparent safe-area-inset-bottom">
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

          {/* Inner container */}
          <div className="relative liquid-composer rounded-2xl sm:rounded-3xl overflow-hidden">
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

            {/* Content */}
            <div className="relative p-3 sm:p-4 space-y-3">
              {previews.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
                  {previews.map(({ file, url }) => {
                    const fileKey = `${file.name}-${file.size}`;

                    return (
                      <div key={fileKey} className="group/file relative w-20 h-20 sm:w-24 sm:h-24 rounded-2xl overflow-hidden border-2 border-primary/20 bg-background/50 flex-shrink-0 shadow-lg transition-transform hover:scale-[1.03] hover:border-primary/50 hover:shadow-primary/20">
                        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover/file:opacity-100 transition-opacity z-10 pointer-events-none" />
                        
                        {isImageFile(file) ? (
                          <img src={url} alt={file.name} className="w-full h-full object-cover relative z-0" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-2 text-center bg-secondary/30 relative z-0">
                            <FileText className="w-7 h-7 text-primary/80 drop-shadow-md" />
                            <span className="text-[11px] font-medium leading-tight text-foreground/90 line-clamp-2">{file.name}</span>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => removeFile(fileKey)}
                          className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-black/50 hover:bg-destructive/80 text-white backdrop-blur-md border border-white/10 flex items-center justify-center z-20 opacity-0 group-hover/file:opacity-100 transition-all scale-75 group-hover/file:scale-100"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="w-4 h-4" />
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

              <div className="flex items-end gap-2 sm:gap-3">
              {/* AI Sparkle indicator */}
              <motion.div 
                className="hidden sm:flex items-center justify-center w-10 h-10 rounded-xl flex-shrink-0 mb-0.5 relative overflow-hidden"
                animate={isLoading ? { scale: [1, 1.08, 1] } : {}}
                transition={{ duration: 1.5, repeat: isLoading ? Infinity : 0, ease: "easeInOut" }}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-primary/25 via-primary/15 to-transparent" />
                <div className="absolute inset-0 border border-primary/25 rounded-xl" />
                
                {isLoading && (
                  <motion.div 
                    className="absolute inset-0 rounded-xl"
                    style={{
                      background: 'conic-gradient(from var(--angle), transparent, hsl(var(--primary) / 0.4), transparent)',
                    }}
                    animate={{ '--angle': ['0deg', '360deg'] } as never}
                    transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                  />
                )}
                
                <Sparkles className={`w-5 h-5 relative z-10 transition-all duration-300 ${isLoading ? 'text-primary animate-pulse' : 'text-primary/60'}`} />
              </motion.div>
              
                {/* Input Area */}
                <div className="flex-1 relative min-w-0">
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
                    className="w-full bg-transparent border-0 resize-none focus:outline-none focus:ring-0 text-foreground placeholder:text-muted-foreground/50 py-2.5 sm:py-3 px-1 max-h-[150px] scrollbar-thin text-sm sm:text-[15px] leading-relaxed font-medium"
                  />
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 flex-shrink-0 mb-0.5">
                  <motion.button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLoading || disabled}
                    className="relative w-10 h-10 rounded-xl flex items-center justify-center liquid-surface text-muted-foreground/70 hover:text-foreground border border-border/30 hover:border-primary/30 transition-all duration-300 overflow-hidden disabled:opacity-50 disabled:cursor-not-allowed"
                    whileHover={{ scale: isLoading || disabled ? 1 : 1.05 }}
                    whileTap={{ scale: isLoading || disabled ? 1 : 0.95 }}
                      aria-label="Upload image or file"
                  >
                    <ImagePlus className="w-[18px] h-[18px]" />
                  </motion.button>

                {/* Voice button - browser Web Speech API (live transcription) */}
                {isSupported && (
                <motion.button
                  type="button"
                  onClick={handleVoiceClick}
                  disabled={isProcessing}
                  className={`
                    relative w-10 h-10 rounded-xl flex items-center justify-center
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
                    <Loader2 className="w-[18px] h-[18px] animate-spin" />
                  ) : isRecording ? (
                    <>
                      <motion.div
                        className="absolute inset-0 bg-destructive/20"
                        animate={{ opacity: [0.3, 0.6, 0.3] }}
                        transition={{ duration: 1, repeat: Infinity }}
                      />
                      <Square className="w-4 h-4 relative z-10 fill-current" />
                    </>
                  ) : (
                    <Mic className="w-[18px] h-[18px]" />
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
                        className="relative w-11 h-11 rounded-xl flex items-center justify-center bg-destructive/20 text-destructive border border-destructive/30 hover:bg-destructive/30 transition-all duration-200"
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        aria-label="Stop generating"
                      >
                        <Square className="w-4 h-4 fill-current" />
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
                          relative w-11 h-11 rounded-xl flex items-center justify-center
                          transition-all duration-300 overflow-hidden
                          ${canSend 
                            ? 'bg-gradient-to-br from-primary via-primary to-accent text-primary-foreground shadow-[0_0_20px_hsla(var(--primary)/0.6)] border border-primary/50' 
                            : 'bg-muted/50 text-muted-foreground/30 cursor-not-allowed'
                          }
                        `}
                        whileHover={canSend ? { scale: 1.1, y: -2, boxShadow: '0 0 30px hsla(var(--primary)/0.8)' } : {}}
                        whileTap={canSend ? { scale: 0.9, rotate: -10 } : {}}
                      >
                        {canSend && (
                          <motion.div 
                            className="absolute inset-0 bg-white/20"
                            animate={{ opacity: [0, 0.4, 0] }}
                            transition={{ duration: 1.5, repeat: Infinity }}
                          />
                        )}
                        <Send className="w-[18px] h-[18px] relative z-10" />
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
