import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, MessageSquare, Trash2, LogOut, ChevronLeft, Sparkles, Bot, ChevronDown, ChevronUp, Search, History, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { format, isToday, isYesterday, differenceInCalendarDays } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export interface AIModel {
  id: string;
  name: string;
  label: string;
  description: string;
  emoji: string;
  kind: 'Chat' | 'Vision' | 'Image';
  featured?: boolean;
}

// NOTE: Every id here maps 1:1 to a verified-working entry in MODEL_REGISTRY
// (src/lib/ai.ts). Models tha returns 404/DEGRADED for — or that
// hang — were removed so the picker never offers a model that fails to fetch.
export const AI_MODELS: AIModel[] = [
  // ── Featured Chat / Reasoning Models ──────────
  { id: 'deepseek-v4-flash', name: 'Deepseek', label: 'Deepseek', description: 'Fast DeepSeek V4 reasoning (Default )', emoji: '⚡', kind: 'Chat', featured: true },
  { id: 'mistral-large-latest', name: 'Flyer', label: 'Flyer', description: 'Fast flagship chat & vision (Mistral API)', emoji: '🧬', kind: 'Chat', featured: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', label: 'DeepSeek V4', description: 'DeepSeek flagship reasoning)', emoji: '🧠', kind: 'Chat', featured: true },
  { id: 'llama-4-maverick', name: 'Llama 4 Maverick', label: 'Llama 4', description: 'Meta Llama 4 128-expert MoE)', emoji: '🦅', kind: 'Chat', featured: true },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', label: 'Kimi K2.6', description: 'Moonshot AI Kimi K2.6 reasoning)', emoji: '🌙', kind: 'Chat', featured: true },
  { id: 'nemotron-3-ultra-550b', name: 'Nemotron 3 Ultra 550B', label: 'Nemotron 3 Ultra', description: 'NVIDIA 550B flagship reasoning)', emoji: '🔱', kind: 'Chat', featured: true },
  { id: 'minimax-m3', name: 'MiniMax M3', label: 'MiniMax M3', description: 'MiniMax flagship chat model)', emoji: '🚀', kind: 'Chat', featured: true },
  { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', label: 'Llama 3.3 70B', description: 'Meta flagship instruct model)', emoji: '🐘', kind: 'Chat', featured: true },
  { id: 'pixtral-12b', name: 'Pixtral 12B', label: 'Pixtral 12B', description: 'Multimodal vision & chat (Mistral API)', emoji: '👁️', kind: 'Chat', featured: true },
  { id: 'codestral-latest', name: 'Codestral', label: 'Codestral', description: 'Code & programming specialist (Mistral API)', emoji: '💻', kind: 'Chat', featured: true },

  // ── More Real Chat Models ──────────────────────────
  { id: 'mistral-medium', name: 'Mistral Medium', label: 'Mistral Medium', description: 'Balanced Mistral (Mistral API)', emoji: '🇫🇷', kind: 'Chat', featured: false },
  { id: 'mistral-small', name: 'Mistral Small', label: 'Mistral Small', description: 'Fast lightweight Mistral (Mistral API)', emoji: '🥖', kind: 'Chat', featured: false },
  { id: 'devstral-latest', name: 'Devstral', label: 'Devstral', description: 'Developer AI model (Mistral API)', emoji: '🛠️', kind: 'Chat', featured: false },
  { id: 'ministral-8b', name: 'Ministral 8B', label: 'Ministral 8B', description: 'Edge AI chat model (Mistral API)', emoji: '📱', kind: 'Chat', featured: false },
  { id: 'qwen-3-next-80b', name: 'Qwen 3 Next 80B', label: 'Qwen 3 80B', description: 'Qwen 3 Next generation reasoning)', emoji: '👑', kind: 'Chat', featured: false },
  { id: 'nemotron-super-49b', name: 'Nemotron Super 49B', label: 'Nemotron 49B', description: 'NVIDIA mid-tier reasoning)', emoji: '🦁', kind: 'Chat', featured: false },
  { id: 'llama-70b', name: 'Llama 3.1 70B', label: 'Llama 70B', description: 'Meta 3.1 instruct model)', emoji: '🐘', kind: 'Chat', featured: false },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', label: 'MiniMax M2.7', description: 'MiniMax mid-tier chat model)', emoji: '✨', kind: 'Chat', featured: false },
  { id: 'llama-8b', name: 'Llama 3.1 8B', label: 'Llama 8B', description: 'Fast, lightweight model)', emoji: '🦙', kind: 'Chat', featured: false },
  { id: 'nemotron-nano-9b', name: 'Nemotron Nano 9B', label: 'Nemotron Nano', description: 'Compact NVIDIA reasoning)', emoji: '🔱', kind: 'Chat', featured: false },
  { id: 'step-3.7-flash', name: 'Step 3.7 Flash', label: 'Step 3.7', description: 'StepFun fast reasoning)', emoji: '🌀', kind: 'Chat', featured: false },

  // ── Image Generation Models & Pollinations) ──
  { id: 'sana', name: 'NVIDIA Sana', label: 'NVIDIA Sana', description: 'Fast, crisp flagshi diffusion engine', emoji: '✨', kind: 'Image', featured: true },
  { id: 'flux', name: 'FLUX', label: 'FLUX', description: 'Highest-quality photorealistic images', emoji: '🖼️', kind: 'Image', featured: true },
  { id: 'gptimage', name: 'GPT Image', label: 'GPT Image', description: 'Newest ChatGPT-style generation', emoji: '🎨', kind: 'Image', featured: true },
  { id: 'turbo', name: 'FLUX Turbo', label: 'Turbo', description: 'Fastest image generation', emoji: '⚡', kind: 'Image', featured: false },
  { id: 'stable-diffusion', name: 'Stable Diffusion', label: 'Stable Diffusion', description: 'Classic versatile image model', emoji: '🌈', kind: 'Image', featured: false },
];



interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ChatSidebarProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  selectedModel: string;
  onSelectModel: (id: string) => void;
}

export default function ChatSidebar({
  conversations, activeConversationId, onSelectConversation,
  onNewConversation, onDeleteConversation, isCollapsed, onToggleCollapse,
  selectedModel, onSelectModel,
}: ChatSidebarProps) {
  const { user, signOut } = useAuth();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Settings State for API Keys (NVIDIA + Mistral only)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nvidiaKey, setNvidiaKey] = useState(() => localStorage.getItem('VITE_NVIDIA_API_KEY') || '');
  const [mistralKey, setMistralKey] = useState(() => localStorage.getItem('VITE_MISTRAL_API_KEY') || '');

  // Re-sync with localStorage when dialog opens
  useEffect(() => {
    if (settingsOpen) {
      setNvidiaKey(localStorage.getItem('VITE_NVIDIA_API_KEY') || '');
      setMistralKey(localStorage.getItem('VITE_MISTRAL_API_KEY') || '');
    }
  }, [settingsOpen]);

  const handleSaveKeys = () => {
    if (nvidiaKey.trim()) {
      localStorage.setItem('VITE_NVIDIA_API_KEY', nvidiaKey.trim());
    } else {
      localStorage.removeItem('VITE_NVIDIA_API_KEY');
    }
    if (mistralKey.trim()) {
      localStorage.setItem('VITE_MISTRAL_API_KEY', mistralKey.trim());
    } else {
      localStorage.removeItem('VITE_MISTRAL_API_KEY');
    }
    setSettingsOpen(false);
    toast.success('API keys updated successfully!');
  };

  const selectedModelMeta = AI_MODELS.find((m) => m.id === selectedModel) || AI_MODELS[0];

  const filteredModels = AI_MODELS.filter((model) =>
    model.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
    model.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    model.description.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const visibleModels = showAllModels ? filteredModels : filteredModels.filter((model) => model.featured);

  // Group conversations by recency for a cleaner, scannable history list.
  const groupLabel = (dateStr: string): string => {
    const d = new Date(dateStr);
    if (isToday(d)) return 'Today';
    if (isYesterday(d)) return 'Yesterday';
    if (differenceInCalendarDays(new Date(), d) < 7) return 'Previous 7 days';
    if (differenceInCalendarDays(new Date(), d) < 30) return 'Previous 30 days';
    return 'Older';
  };
  const GROUP_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];
  const groupedConversations = GROUP_ORDER
    .map((label) => ({ label, items: conversations.filter((c) => groupLabel(c.updated_at) === label) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <AnimatePresence>
        {!isCollapsed && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 lg:hidden" onClick={onToggleCollapse} />
        )}
      </AnimatePresence>

      <motion.aside
        initial={false}
        animate={{ width: isCollapsed ? 0 : 280, x: isCollapsed ? -280 : 0 }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
        className="fixed lg:relative h-screen liquid-sidebar border-r border-sidebar-border z-50 flex flex-col overflow-hidden"
      >
        <div className="flex flex-col h-full w-[280px]">
          <div className="p-4 border-b border-sidebar-border">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden bg-black/10">
                  <img src="/flyer-logo.png" alt="Deepseek" className="w-full h-full object-cover" />
                </div>
                <span className="font-display font-bold text-lg gradient-text">
                  Flyer
                </span>
              </div>
              <button onClick={onToggleCollapse} className="p-2 rounded-lg hover:bg-sidebar-accent transition-colors lg:block hidden" aria-label="Collapse sidebar">
                <ChevronLeft className="w-5 h-5 text-sidebar-foreground/70" />
              </button>
            </div>
          </div>

          <div className="p-4 space-y-4 flex-shrink-0">
            <Button 
              onClick={onNewConversation} 
              className="w-full liquid-control text-primary justify-start gap-3 py-6 px-5 font-semibold tracking-wide"
            >
              <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/20 group-hover:bg-primary/30 transition-colors">
                <Plus className="w-4 h-4 text-primary" />
              </div>
              <span className="text-sm">New Chat</span>
            </Button>

            {/* Model Selector — collapsible so History always has room.
                The full model picker also lives in the chat header. */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setModelPanelOpen((v) => !v)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl border border-sidebar-border/50 bg-sidebar-accent/10 hover:bg-sidebar-accent/30 transition-all duration-300 group"
                aria-expanded={modelPanelOpen}
              >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform">
                  <Bot className="w-4 h-4 text-primary/80" />
                </div>
                <span className="flex flex-col items-start min-w-0 flex-1">
                  <span className="text-[10px] font-bold text-sidebar-foreground/50 uppercase tracking-widest leading-none mb-1">AI Model</span>
                  <span className="text-sm font-semibold text-sidebar-foreground truncate max-w-full">
                    {selectedModelMeta.emoji} {selectedModelMeta.label}
                  </span>
                </span>
                <ChevronDown className={`w-4 h-4 text-sidebar-foreground/50 transition-transform duration-300 flex-shrink-0 ${modelPanelOpen ? 'rotate-180 text-primary' : 'group-hover:text-primary/70'}`} />
              </button>

              <AnimatePresence initial={false}>
                {modelPanelOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-2 pt-1">
                      {/* Search input for AI models */}
                      <div className="relative group px-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sidebar-foreground/45 group-focus-within:text-primary transition-colors" />
                        <input
                          type="text"
                          placeholder="Search models..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="w-full pl-8 pr-3 py-1.5 bg-sidebar-accent/20 hover:bg-sidebar-accent/40 border border-sidebar-border/40 focus:border-primary/40 focus:ring-1 focus:ring-primary/20 rounded-lg text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/30 focus:outline-none transition-all"
                        />
                      </div>

                      <div className="space-y-1 max-h-[26vh] overflow-y-auto pr-1 scrollbar-thin">
                        {visibleModels.map((model) => (
                          <button
                            key={model.id}
                            onClick={() => onSelectModel(model.id)}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all duration-200 text-sm liquid-model-button
                              ${selectedModel === model.id
                                ? 'bg-primary/15 text-primary border border-primary/25 shadow-sm shadow-primary/10'
                                : 'hover:bg-sidebar-accent/50 text-sidebar-foreground/70 hover:text-sidebar-foreground border border-transparent'
                              }`}
                          >
                            <span className="text-base">{model.emoji}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium truncate">{model.label}</span>
                                <span className="text-[10px] text-sidebar-foreground/40 truncate">{model.kind}</span>
                              </div>
                              <p className="text-[11px] text-sidebar-foreground/45 truncate">{model.description}</p>
                            </div>
                            {selectedModel === model.id && (
                              <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                            )}
                          </button>
                        ))}
                      </div>
                      {AI_MODELS.length > AI_MODELS.filter((model) => model.featured).length && (
                        <button
                          type="button"
                          onClick={() => setShowAllModels((prev) => !prev)}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/40 transition-colors"
                        >
                          {showAllModels ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          {showAllModels ? 'Show less' : `Show all ${AI_MODELS.length} models`}
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-4">
            <div className="flex items-center gap-2 px-2 mb-2 sticky top-0 z-10 py-1.5 bg-gradient-to-b from-[hsl(224_36%_4%)] to-transparent">
              <History className="w-3.5 h-3.5 text-sidebar-foreground/50" />
              <p className="text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider">History</p>
              {conversations.length > 0 && (
                <span className="ml-auto text-[10px] font-semibold text-primary/70 bg-primary/10 border border-primary/20 rounded-full px-2 py-0.5">
                  {conversations.length}
                </span>
              )}
            </div>

            {conversations.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center justify-center text-center py-12 px-4"
              >
                <div className="w-12 h-12 rounded-2xl liquid-icon flex items-center justify-center mb-3">
                  <MessageSquare className="w-5 h-5 text-primary/70" />
                </div>
                <p className="text-sm font-medium text-sidebar-foreground/60">No conversations yet</p>
                <p className="text-xs text-sidebar-foreground/35 mt-1">Start a new chat to see it here</p>
              </motion.div>
            ) : (
              <div className="space-y-3">
                {groupedConversations.map((group) => (
                  <div key={group.label} className="space-y-1">
                    <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/35">{group.label}</p>
                    <AnimatePresence>
                      {group.items.map((conv) => (
                        <motion.div key={conv.id}
                          layout
                          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                          onMouseEnter={() => setHoveredId(conv.id)} onMouseLeave={() => setHoveredId(null)}
                          onClick={() => onSelectConversation(conv.id)}
                          className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-200 border
                            ${activeConversationId === conv.id
                              ? 'bg-gradient-to-r from-primary/15 to-primary/5 text-sidebar-foreground border-primary/25 shadow-sm shadow-primary/10'
                              : 'border-transparent hover:bg-sidebar-accent/50 text-sidebar-foreground/70 hover:text-sidebar-foreground'}`}
                        >
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors
                            ${activeConversationId === conv.id ? 'bg-primary/20 text-primary' : 'bg-sidebar-accent/40 text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80'}`}>
                            <MessageSquare className="w-3.5 h-3.5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm truncate font-medium">{conv.title}</p>
                            <p className="text-[11px] text-sidebar-foreground/40">{format(new Date(conv.updated_at), 'MMM d, h:mm a')}</p>
                          </div>
                          {hoveredId === conv.id && (
                            <motion.button initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                              onClick={(e) => { e.stopPropagation(); onDeleteConversation(conv.id); }}
                              className="absolute right-2 p-1.5 rounded-lg bg-background/40 hover:bg-destructive/20 text-sidebar-foreground/50 hover:text-destructive transition-colors"
                              aria-label="Delete conversation">
                              <Trash2 className="w-3.5 h-3.5" />
                            </motion.button>
                          )}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="p-4 border-t border-sidebar-border">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-sidebar-accent/30">
              {user?.photoURL ? (
                <img src={user.photoURL} alt="Profile" className="w-9 h-9 rounded-full object-cover border border-primary/20" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center">
                  <span className="text-sm font-medium text-primary">{(user?.displayName || user?.email || '?').charAt(0).toUpperCase()}</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate text-sidebar-foreground">{user?.displayName || user?.email}</p>
                {user?.displayName && user?.email && (
                  <p className="text-xs text-sidebar-foreground/40 truncate">{user.email}</p>
                )}
              </div>
              <button onClick={() => setSettingsOpen(true)} className="p-2 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground/60 hover:text-sidebar-foreground transition-all duration-200" title="API Settings">
                <Settings className="w-4 h-4 hover:rotate-45 transition-transform" />
              </button>
              <button onClick={() => signOut()} className="p-2 rounded-lg hover:bg-destructive/20 text-sidebar-foreground/60 hover:text-destructive transition-colors" title="Sign out">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </motion.aside>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-[425px] border-white/10 bg-background/95 backdrop-blur-xl text-foreground rounded-2xl shadow-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <Settings className="w-5 h-5 text-primary animate-[spin_8s_linear_infinite]" />
              Configure API Keys
            </DialogTitle>
            <DialogDescription className="text-muted-foreground/80 text-xs">
              Provide your own API keys fo and Mistral AI. These keys are stored safely on your device and never sent to external servers other than the API proxy endpoints.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="nvidia-key" className="text-sm font-semibold text-foreground/80 flex items-center gap-1.5">
                🧠 NVIDIA API Key
              </Label>
              <Input
                id="nvidia-key"
                type="password"
                placeholder="nvapi-..."
                value={nvidiaKey}
                onChange={(e) => setNvidiaKey(e.target.value)}
                className="bg-secondary/40 border-border/40 focus:border-primary/40 focus:ring-primary/20 text-sm placeholder:text-muted-foreground/30 rounded-xl"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mistral-key" className="text-sm font-semibold text-foreground/80 flex items-center gap-1.5">
                🇫🇷 Mistral API Key
              </Label>
              <Input
                id="mistral-key"
                type="password"
                placeholder="Enter Mistral API Key"
                value={mistralKey}
                onChange={(e) => setMistralKey(e.target.value)}
                className="bg-secondary/40 border-border/40 focus:border-primary/40 focus:ring-primary/20 text-sm placeholder:text-muted-foreground/30 rounded-xl"
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0 border-t border-border/30 pt-4 mt-2">
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setNvidiaKey('');
                setMistralKey('');
              }}
              className="bg-destructive/10 hover:bg-destructive/20 border-destructive/20 text-destructive text-xs h-9 rounded-xl transition-all duration-200 mr-auto"
            >
              Clear Keys
            </Button>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="hover:bg-secondary/60 text-xs h-9 border border-border/40 rounded-xl"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleSaveKeys}
                className="  bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold h-9 rounded-xl transition-all duration-200"
              >
                Save Keys
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
