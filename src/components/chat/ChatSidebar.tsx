import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, MessageSquare, Trash2, LogOut, ChevronLeft, Sparkles, Bot, ChevronDown, ChevronUp, Search, History, Settings, Brain, Pencil, Copy, AlertTriangle, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { format, isToday, isYesterday, differenceInCalendarDays } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { copyText } from '@/lib/clipboard';

import { SELECTABLE_MODELS, type ModelSpec } from '@/lib/providers';
import { LOGO_URL } from '@/lib/assets';
import MemoriesPanel from './MemoriesPanel';

/**
 * The picker's view of a model.
 *
 * This used to be a second hardcoded catalogue whose ids had drifted from the
 * router's, so most selections resolved to nothing in getModel() and quietly
 * fell through to a legacy proxy — the user picked one model and another
 * answered. It is now a projection of MODELS in src/lib/providers.ts. Add
 * models there, not here.
 */
export interface AIModel {
  id: string;
  name: string;
  label: string;
  description: string;
  emoji: string;
  kind: 'Chat' | 'Vision' | 'Image';
  featured?: boolean;
}

const toAIModel = (spec: ModelSpec): AIModel => ({
  id: spec.id,
  name: spec.label,
  label: spec.shortLabel || spec.label,
  description: spec.description,
  emoji: spec.emoji,
  kind: spec.kind,
  featured: spec.featured,
});

export const AI_MODELS: AIModel[] = SELECTABLE_MODELS.map(toAIModel);




interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ChatSidebarProps {
  conversations: Conversation[];
  /**
   * Whether `conversations` can be believed yet (§14 item #10).
   *
   * Optional and defaulting to 'ready' so a caller that has its list in hand
   * synchronously — tests, a future local-first store — gets today's behaviour
   * without opting in. What it must never do is default to 'loading': a caller
   * that forgot the prop would render skeleton rows forever.
   */
  conversationsStatus?: 'loading' | 'ready' | 'error';
  /** Re-run the fetch behind the error state's Retry. Without it the error state
   *  still renders, just without a button — a dead-end message is worse than an
   *  honest one, but it is much better than a false empty state. */
  onRetryConversations?: () => void;
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  /**
   * Rename a conversation. Optional so a caller that has no persistence for it
   * simply gets no Rename item in the context menu, rather than one that fails.
   */
  onRenameConversation?: (id: string, title: string) => void | Promise<void>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  selectedModel: string;
  onSelectModel: (id: string) => void;
  // Refresh hooks so the parent's prompt-injection cache picks up panel edits
  // without waiting for a reload. Optional because the panel still owns its
  // own reads; without these the only consequence is a one-turn-stale snapshot.
  onMemoriesChanged?: () => void;
  onInstructionsChanged?: () => void;
}

/**
 * Placeholder rows shown while the history fetch is in flight (§14 item #10).
 *
 * WHY THIS ANIMATES WHEN ALMOST NOTHING ELSE IN THIS PASS DOES
 * The native-motion rule that governed the rest of task #14 is that a thing which
 * animates once as a view opens reads native, and a thing that never stops moving
 * reads as a web toy. Loading indicators are the stated exception, and they have
 * to be: the pulse is what distinguishes "waiting for data" from "three empty grey
 * boxes shipped by mistake". Every native list — Finder's, Mail's, the App Store's
 * — shows moving placeholder content for exactly this reason.
 *
 * The geometry deliberately matches a real row (h-7 icon block, two text lines,
 * same px-3 py-2.5 padding) so the list does not jump when the data lands. Three
 * rows rather than filling the panel: enough to read as a list, few enough that
 * the transition to a one-conversation account is not a collapse.
 */
function ConversationSkeletons() {
  return (
    <div className="space-y-1" aria-hidden="true" data-testid="conversation-skeletons">
      {/* Widths differ per row so this reads as titles of varying length rather
          than as a progress bar chopped into three. */}
      {['w-3/4', 'w-1/2', 'w-2/3'].map((width, i) => (
        <div key={width} className="flex items-center gap-3 px-3 py-2.5">
          <div
            className="w-7 h-7 rounded-lg bg-sidebar-foreground/[0.07] animate-pulse flex-shrink-0"
            // Staggered so the three rows breathe out of phase. In phase they pulse
            // as one block, which looks like the whole panel flashing; out of phase
            // it reads as a list loading.
            style={{ animationDelay: `${i * 140}ms` }}
          />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div
              className={`h-3 rounded bg-sidebar-foreground/[0.07] animate-pulse ${width}`}
              style={{ animationDelay: `${i * 140}ms` }}
            />
            <div
              className="h-2 w-1/3 rounded bg-sidebar-foreground/[0.05] animate-pulse"
              style={{ animationDelay: `${i * 140 + 70}ms` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * How long the collapse/expand slide takes. Shared by the motion transition and
 * by the visibility timer below, which have to agree — see `offscreen`.
 */
const COLLAPSE_DURATION_S = 0.3;

export default function ChatSidebar({
  conversations, conversationsStatus = 'ready', onRetryConversations,
  activeConversationId, onSelectConversation,
  onNewConversation, onDeleteConversation, onRenameConversation, isCollapsed, onToggleCollapse,
  selectedModel, onSelectModel,
  onMemoriesChanged, onInstructionsChanged,
}: ChatSidebarProps) {
  const { user, signOut } = useAuth();
  const [showAllModels, setShowAllModels] = useState(false);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Filters the conversation list, not the model list — `searchQuery` above is the
  // model picker's. Separate state because they are separate fields serving separate
  // lists; sharing one would mean typing a model name silently hid every chat.
  const [historyQuery, setHistoryQuery] = useState('');
  // Which match the keyboard is currently on, as an index into the *displayed*
  // order (see `flatMatches` below). -1 means "nowhere yet", which is the state
  // the field is in as you type — the first ArrowDown is what commits to a row.
  //
  // An index rather than an id because the list it points into changes shape on
  // every keystroke: holding an id would keep pointing at a row that has just been
  // filtered out, and ArrowDown from there has no defined meaning. An index that
  // has fallen off the end is unambiguous, and is clamped back to -1 at the point
  // of use rather than corrected in an effect, which would be a second render.
  const [activeMatch, setActiveMatch] = useState(-1);

  /**
   * Is the panel fully out of the way, i.e. has the slide-out finished?
   *
   * THE BUG THIS FIXES
   * Collapsing the sidebar animates it to `width: 0` and translates it -280px
   * under `overflow-hidden`. That hides it visually and does nothing else: every
   * control inside stayed in the tab order and stayed visible to a screen reader.
   * Tabbing out of the chat header walked into sixteen invisible controls —
   * new-chat, the model picker and its search field, the history filter, every
   * conversation row and its delete button, settings, sign out — with the focus
   * ring being drawn 280px off the left edge of the window. No native app has a
   * closed drawer you can tab into.
   *
   * WHY A TIMER RATHER THAN `visibility` STRAIGHT AWAY
   * `visibility: hidden` is what actually removes descendants from the tab order
   * and from the accessibility tree (`aria-hidden` does only the second, and
   * `tabIndex` does not cascade to children). But applying it the instant
   * `isCollapsed` flips would blank the content before the panel has finished
   * sliding, so the drawer would pop empty and then shrink. So it is applied one
   * animation-length later, and removed immediately on expand — the asymmetry is
   * the point.
   *
   * `inert` would be the modern one-attribute answer. React 18 does not support
   * it as a boolean prop and @types/react 18 does not declare it, so it would
   * need a cast; revisit on the React 19 upgrade.
   */
  const [offscreen, setOffscreen] = useState(isCollapsed);
  useEffect(() => {
    if (!isCollapsed) {
      setOffscreen(false);
      return;
    }
    const timer = setTimeout(() => setOffscreen(true), COLLAPSE_DURATION_S * 1000);
    return () => clearTimeout(timer);
  }, [isCollapsed]);

  // ---- inline rename (task #14, item 7: app-level context menus) ---------
  // Which row is being renamed, and the draft. Inline rather than a modal because
  // renaming a list item in place is what every native file manager, mail client
  // and chat app does; a dialog for one short string is a web habit.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const beginRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameDraft(current);
  };

  const commitRename = async (id: string) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    // An empty title is not a rename, it is a mistake — a list row with no label
    // is unclickable in practice. Unchanged is a no-op rather than a write.
    const original = conversations.find((c) => c.id === id)?.title ?? '';
    if (!next || next === original) return;
    try {
      await onRenameConversation?.(id, next);
    } catch {
      toast.error('Could not rename this conversation');
    }
  };

  // Select the whole title on entry, like F2 in a file manager: renaming usually
  // means replacing, and requiring a manual select-all first is the difference
  // between the interaction feeling native and feeling like a form field.
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // Settings State for API Keys (NVIDIA + Mistral only)
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Memories + custom instructions panel (Part F.2/F.3). Self-contained — owns
  // its Firestore reads via useAuth — so no extra prop drilling here.
  const [memoriesOpen, setMemoriesOpen] = useState(false);
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

  // Filter, then group. The other order would produce empty date headings for the
  // periods the query matched nothing in, and a "Yesterday" label with no rows
  // under it reads as a rendering fault.
  //
  // Substring match on the title, case-insensitive, no fuzzy ranking. Titles here
  // are model-generated summaries of the first message, so the user is recalling a
  // phrase they saw rather than guessing at one — and a fuzzy matcher that surfaces
  // "Trip to Rome" for the query "tor" makes a short list feel unpredictable, which
  // is the opposite of what a filter field is for. Ranking would also fight the date
  // grouping below, which is the organising principle users actually navigate by.
  const historyNeedle = historyQuery.trim().toLowerCase();
  const matchingConversations = historyNeedle
    ? conversations.filter((c) => c.title.toLowerCase().includes(historyNeedle))
    : conversations;

  const groupedConversations = GROUP_ORDER
    .map((label) => ({
      label,
      items: matchingConversations.filter((c) => groupLabel(c.updated_at) === label),
    }))
    .filter((g) => g.items.length > 0);

  // The rows in the order they are painted, which is the order the arrow keys have
  // to walk. Flattening the groups rather than using `matchingConversations` is the
  // whole point: that array is in Firestore's order, so ArrowDown against it would
  // jump between date headings in a sequence that has nothing to do with what is on
  // screen. Cheap enough to redo each render — this list is a handful of rows.
  const flatMatches = groupedConversations.flatMap((g) => g.items);
  // Clamped here rather than reset in an effect: deleting a conversation, or typing
  // one more character, can shrink the list under a live index, and an effect that
  // fixes it up afterwards renders the out-of-range state first.
  const activeMatchId =
    activeMatch >= 0 && activeMatch < flatMatches.length ? flatMatches[activeMatch].id : null;

  // Keep the keyboard position on screen. The history pane scrolls, and an ArrowDown
  // that moves an invisible highlight is indistinguishable from one that does
  // nothing. `block: 'nearest'` is deliberate — 'center' would scroll on every step
  // even when the row is already comfortably visible, which turns a walk down the
  // list into a lurching one.
  //
  // Queried by attribute rather than held in a ref map: the row is wrapped in
  // ContextMenuTrigger asChild *and* is a motion.div, so a ref would have to survive
  // two forwarding layers to reach the DOM node. Conversation ids are Firestore
  // document ids (alphanumeric), so they need no escaping inside the selector.
  useEffect(() => {
    if (!activeMatchId) return;
    document
      .querySelector(`[data-flyer-conv-id="${activeMatchId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeMatchId]);

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
        transition={{ duration: COLLAPSE_DURATION_S, ease: 'easeInOut' }}
        className="fixed lg:relative app-shell-height liquid-sidebar border-r border-sidebar-border z-50 flex flex-col overflow-hidden"
      >
        {/* Hidden once the slide-out has finished: `visibility: hidden` is what
            takes the panel's sixteen controls out of the tab order and out of the
            accessibility tree. See the `offscreen` note above for why it is
            delayed on the way out and immediate on the way in.

            `isCollapsed &&` as well as `offscreen` is not redundant. `offscreen`
            is cleared from an effect, which runs after the commit that re-rendered
            this component with `isCollapsed: false` — so for one commit the panel
            would be expanding and still unfocusable. Reading `isCollapsed`
            directly makes the hide lift in the same render that opens the panel,
            which is what lets Chat's mod+K handler focus the search field on the
            next frame rather than having to wait for the effect.

            An inline style rather than Tailwind's `invisible` for one reason:
            jsdom does not load the stylesheet, so a utility class here would make
            this untestable and the assertions would have to check for a class name
            instead of for the behaviour. One computed property is a legitimate
            inline style — same call as the skeleton rows' animationDelay. */}
        <div
          className="flex flex-col h-full w-[280px]"
          style={{ visibility: isCollapsed && offscreen ? 'hidden' : undefined }}
        >
          <div className="p-4 border-b border-sidebar-border">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden bg-black/10">
                  <img src={LOGO_URL} alt="Flyer" className="w-full h-full object-cover" />
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
                  {/* The match count while filtering, the total otherwise. A badge
                      that keeps reading "47" beside three visible rows is the kind
                      of small untruth that makes a UI feel careless. */}
                  {historyNeedle ? `${matchingConversations.length}/${conversations.length}` : conversations.length}
                </span>
              )}
            </div>

            {/* Filter the history. Rendered only once there is a list worth
                filtering — a search field above "No conversations yet" is furniture
                offering to search nothing. The threshold is deliberately low rather
                than zero: with two chats the field is still the fastest route once
                you have five, and a control that appears at some unannounced count
                feels arbitrary. */}
            {conversations.length > 0 && (
              <div className="relative mb-2 px-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sidebar-foreground/35 pointer-events-none" />
                <input
                  /* Queried by this attribute from Chat.tsx's mod+K handler, matching
                     how focusComposer finds the message box: a `data-` hook placed for
                     the purpose, not a class or an aria-label someone could rename in
                     good faith. */
                  data-flyer-history-search
                  type="search"
                  value={historyQuery}
                  onChange={(e) => {
                    setHistoryQuery(e.target.value);
                    // Editing the query abandons the keyboard position. Keeping the
                    // index across a keystroke would leave the highlight on whatever
                    // row happens to land at that slot in the new results, which is
                    // an arbitrary row the user did not choose.
                    setActiveMatch(-1);
                  }}
                  onKeyDown={(e) => {
                    // Escape clears the filter and, if it is already clear, gives the
                    // key back to the app-level handler (which stops generation or
                    // closes a panel). Stopping propagation unconditionally would
                    // make Escape do nothing here once the field was empty, which is
                    // the sort of dead key that gets reported as "Escape is broken".
                    if (e.key === 'Escape' && historyQuery) {
                      e.stopPropagation();
                      setHistoryQuery('');
                      setActiveMatch(-1);
                      return;
                    }

                    // Walk the results without leaving the field.
                    //
                    // Focus deliberately stays here rather than moving into the list,
                    // even though the rows are focusable and already answer Enter. If
                    // ArrowDown moved real focus, the next character typed would go to
                    // a row instead of refining the search — and type, look, refine is
                    // the actual loop. So the position is a highlight the field owns,
                    // which is what Spotlight and every editor's quick-open do.
                    //
                    // The cost of that choice is the ARIA: a screen reader is not told
                    // the highlight moved. The honest fix is combobox + listbox +
                    // option roles, and it is not available here — an option's children
                    // are meant to be presentational and these rows contain a real
                    // delete button, so declaring the roles would break the row
                    // semantics that already work. Screen-reader users reach the rows
                    // by Tab, where each one announces its own label and aria-current.
                    // Recorded as a trade-off, not an oversight.
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      if (flatMatches.length === 0) return;
                      // Otherwise the caret jumps to the end or start of the query,
                      // so the highlight moves *and* the text cursor does.
                      e.preventDefault();
                      const last = flatMatches.length - 1;
                      setActiveMatch((i) =>
                        e.key === 'ArrowDown'
                          // Wrapping, as quick-open does: from nowhere (-1) down is the
                          // first row, and from the last row down is the first again.
                          ? (i >= last ? 0 : i + 1)
                          // From nowhere, up is the *last* row — the same asymmetry
                          // Spotlight has, and the reason it feels right is that "up
                          // from the top of nothing" has no other sensible answer.
                          : (i <= 0 ? last : i - 1),
                      );
                      return;
                    }

                    if (e.key === 'Enter') {
                      // With no highlight, Enter takes the first match. Typing a few
                      // characters and pressing Enter is the fast path people expect
                      // from a filter field, and it is non-destructive here — it opens
                      // a conversation.
                      const pick = activeMatchId
                        ? flatMatches[activeMatch]
                        : flatMatches[0];
                      if (!pick) return;
                      e.preventDefault();
                      onSelectConversation(pick.id);
                      // The query survives on purpose. This is a persistent sidebar,
                      // not a modal picker: the matches stay listed so the next
                      // ArrowDown continues from where this one left off, which is how
                      // you compare two chats you were looking for.
                    }
                  }}
                  /* Off because ArrowDown in a search input otherwise opens the
                     browser's own saved-values dropdown over the list, and then the
                     first arrow key both opens that menu and moves the highlight. */
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Search chats"
                  aria-label="Search conversations"
                  /* `focus:` and not `focus-visible:` — this is a text field, and a
                     focused field should show it however focus arrived. See the note
                     on ModelSelector's trigger for the button case, which is the
                     opposite. */
                  className="w-full pl-9 pr-3 py-1.5 bg-sidebar-accent/20 hover:bg-sidebar-accent/40 border border-sidebar-border/40 focus:border-primary/40 focus:ring-1 focus:ring-primary/20 rounded-lg text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/30 focus:outline-none transition-all [&::-webkit-search-cancel-button]:appearance-none"
                />
              </div>
            )}

            {/* Four states, in the order they can be true (§14 item #10). The two
                new branches are both gated on the list ALSO being empty, which is
                the whole subtlety here: loadConversations runs again after every
                turn to pick up the new title, and a refresh that is slow or that
                fails must not blank out a list the user is currently reading.
                Stale rows beat a spinner over content that is already on screen —
                that is the difference between a refresh and a load. */}
            {conversationsStatus === 'loading' && conversations.length === 0 ? (
              <ConversationSkeletons />
            ) : conversationsStatus === 'error' && conversations.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center justify-center text-center py-12 px-4"
                role="alert"
              >
                {/* Amber, not destructive red. Failing to read the history list
                    loses nothing and breaks nothing — the composer still works and
                    a new chat still sends. Red would claim a severity the situation
                    does not have. */}
                <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-3">
                  <AlertTriangle className="w-5 h-5 text-amber-400/80" />
                </div>
                <p className="text-sm font-medium text-sidebar-foreground/60">
                  Couldn&apos;t load your chats
                </p>
                {/* Names the two things it could be, because the user can act on
                    one of them. "Something went wrong" is the message that makes
                    people reload the whole app. */}
                <p className="text-xs text-sidebar-foreground/35 mt-1 max-w-[15rem]">
                  Your connection dropped, or the server is having a moment. Your
                  conversations are safe.
                </p>
                {onRetryConversations && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRetryConversations}
                    className="mt-4 gap-1.5 text-xs"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    Try again
                  </Button>
                )}
              </motion.div>
            ) : conversations.length === 0 ? (
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
            ) : groupedConversations.length === 0 ? (
              /* Filtered down to nothing. A distinct state from "no conversations
                 yet" and it has to be: the reassuring empty state would read here as
                 "your chats are gone" at the exact moment the user is typing, which
                 is the same false-empty trap as #10 arriving by a different route.
                 The needle is echoed back so it is obvious *what* matched nothing,
                 and clearing it is one click away. */
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center justify-center text-center py-10 px-4"
              >
                <div className="w-12 h-12 rounded-2xl bg-sidebar-accent/30 border border-sidebar-border/40 flex items-center justify-center mb-3">
                  <Search className="w-5 h-5 text-sidebar-foreground/40" />
                </div>
                <p className="text-sm font-medium text-sidebar-foreground/60">No chats match</p>
                <p className="text-xs text-sidebar-foreground/35 mt-1 max-w-[15rem] break-words">
                  Nothing titled &ldquo;{historyQuery.trim()}&rdquo;. Titles are written
                  from the first message, so try a word you actually typed.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setHistoryQuery(''); setActiveMatch(-1); }}
                  className="mt-3 gap-1.5 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground"
                >
                  <X className="w-3.5 h-3.5" />
                  Clear search
                </Button>
              </motion.div>
            ) : (
              <div className="space-y-3">
                {groupedConversations.map((group) => (
                  <div key={group.label} className="space-y-1">
                    <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/35">{group.label}</p>
                    {/* No AnimatePresence and no enter animation on the rows any more,
                        which the search field forced a decision on.

                        The rows used to slide in from -20px on mount and slide out
                        again on removal. Two things were wrong with that. The whole
                        history swept in from the left every time the sidebar mounted —
                        a web-app entrance, and the same kind of decorative motion this
                        pass has been taking out everywhere else. And an exit animation
                        turns a *filter* into a wobble: type four characters quickly and
                        AnimatePresence holds four overlapping sets of fading rows,
                        which reads as lag. No native list filter animates rows out;
                        Finder, Mail and every editor's file switcher all update on the
                        keystroke.

                        `layout` stays. That one is motion that explains a change rather
                        than decorating one: when a conversation moves from "Yesterday"
                        to "Today" after a new turn, seeing it travel is the difference
                        between understanding the reorder and being confused by it. */}
                    {group.items.map((conv) => (
                        <ContextMenu key={conv.id}>
                          <ContextMenuTrigger asChild>
                            <motion.div
                              layout
                              /* Read by the scroll-into-view effect above, which cannot
                                 use a ref here: this node is a motion.div rendered
                                 through ContextMenuTrigger asChild, so a ref would have
                                 to survive two forwarding layers. */
                              data-flyer-conv-id={conv.id}
                              onClick={() => { if (renamingId !== conv.id) onSelectConversation(conv.id); }}
                              /* The row was a bare div with an onClick: not focusable, not
                                 reachable by Tab, and inert to Enter and Space. Its own
                                 delete button carried a focus-visible style, which is only
                                 reachable if the row before it is — so the intent was
                                 there and the row had been missed. role/tabIndex/keydown
                                 rather than a real <button> because the row *contains* a
                                 button, and a button inside a button is invalid HTML that
                                 browsers silently reparent. */
                              role="button"
                              tabIndex={0}
                              aria-current={activeConversationId === conv.id ? 'true' : undefined}
                              onKeyDown={(e) => {
                                if (renamingId === conv.id) return;
                                if (e.key === 'Enter' || e.key === ' ') {
                                  // Space scrolls the list otherwise, which moves the row
                                  // out from under the user at the moment they act on it.
                                  e.preventDefault();
                                  onSelectConversation(conv.id);
                                } else if (e.key === 'F2' && onRenameConversation) {
                                  e.preventDefault();
                                  beginRename(conv.id, conv.title);
                                }
                              }}
                              /* The arrow-key highlight uses the *same* ring as
                                 focus-visible, deliberately. It is the keyboard's
                                 position in the list either way — whether it got there
                                 by Tab or by ArrowDown from the search field — and a
                                 second, different treatment for the same idea is how a
                                 list ends up with two things that both look selected.
                                 It layers over the active-conversation styling below
                                 rather than replacing it, because "the chat you are in"
                                 and "the row you are about to open" are different facts
                                 and can be true of different rows at once. */
                              className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-200 border outline-none focus-visible:ring-2 focus-visible:ring-primary/50
                                ${activeMatchId === conv.id ? 'ring-2 ring-primary/50' : ''}
                                ${activeConversationId === conv.id
                                  ? 'bg-gradient-to-r from-primary/15 to-primary/5 text-sidebar-foreground border-primary/25 shadow-sm shadow-primary/10'
                                  : 'border-transparent hover:bg-sidebar-accent/50 text-sidebar-foreground/70 hover:text-sidebar-foreground'}`}
                            >
                              <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors
                                ${activeConversationId === conv.id ? 'bg-primary/20 text-primary' : 'bg-sidebar-accent/40 text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80'}`}>
                                <MessageSquare className="w-3.5 h-3.5" />
                              </div>
                              <div className="flex-1 min-w-0">
                                {renamingId === conv.id ? (
                                  <input
                                    ref={renameInputRef}
                                    value={renameDraft}
                                    onChange={(e) => setRenameDraft(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    onBlur={() => commitRename(conv.id)}
                                    onKeyDown={(e) => {
                                      // Stop these reaching the row's handler above, which
                                      // would select the conversation on Enter.
                                      e.stopPropagation();
                                      if (e.key === 'Enter') commitRename(conv.id);
                                      // Escape abandons the edit. Clearing renamingId
                                      // before blur fires is what makes it a cancel rather
                                      // than a commit — onBlur runs either way.
                                      if (e.key === 'Escape') setRenamingId(null);
                                    }}
                                    aria-label="Conversation title"
                                    maxLength={120}
                                    className="w-full bg-sidebar-accent/60 border border-primary/40 rounded px-1.5 py-0.5 text-sm font-medium text-sidebar-foreground outline-none"
                                  />
                                ) : (
                                  <p className="text-sm truncate font-medium">{conv.title}</p>
                                )}
                                <p className="text-[11px] text-sidebar-foreground/40">{format(new Date(conv.updated_at), 'MMM d, h:mm a')}</p>
                              </div>
                              {/* Rendered unconditionally rather than gated on the JS
                                  `hoveredId` state: mouseenter never fires on touch,
                                  so that version left no way at all to delete a
                                  conversation from a phone. Desktop still gets the
                                  reveal-on-hover behaviour, now via CSS. */}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onDeleteConversation(conv.id); }}
                                className="absolute right-2 p-2 rounded-lg bg-background/40 hover:bg-destructive/20 text-sidebar-foreground/50 hover:text-destructive transition-all opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100 focus-visible:opacity-100 focus-visible:scale-100 max-hover:opacity-100 max-hover:scale-100"
                                aria-label={`Delete conversation: ${conv.title}`}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </motion.div>
                          </ContextMenuTrigger>

                          {/* Right-click is a reflex on a list row in every desktop app,
                              and until now it produced Electron's generic text menu —
                              "Copy", greyed out, on a row with nothing selected. That
                              reads as an app that does not know what its own list is. */}
                          <ContextMenuContent className="w-48">
                            {onRenameConversation && (
                              <ContextMenuItem onSelect={() => beginRename(conv.id, conv.title)}>
                                <Pencil className="mr-2 h-3.5 w-3.5" />
                                Rename
                                {/* Advertised because the row implements it — see the
                                    F2 branch in onKeyDown. */}
                                <span className="ml-auto text-[10px] text-muted-foreground/50">F2</span>
                              </ContextMenuItem>
                            )}
                            <ContextMenuItem
                              onSelect={() => {
                                // Routed through the same helper as every other
                                // copy in the app so there is one clipboard path
                                // with one fallback, not two that drift.
                                void copyText(conv.title).then((ok) => {
                                  if (ok) toast.success('Title copied');
                                });
                              }}
                            >
                              <Copy className="mr-2 h-3.5 w-3.5" />
                              Copy title
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onSelect={() => onDeleteConversation(conv.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              Delete
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      ))}
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
              <button onClick={() => setMemoriesOpen(true)} className="p-2 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground/60 hover:text-sidebar-foreground transition-all duration-200" title="Memory & Instructions">
                <Brain className="w-4 h-4" />
              </button>
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
              {/* `type="password"` here is masking, not a credential field: these
                  are provider API keys, not this site's password. Without
                  `autoComplete="off"` a browser manager treats the dialog as a
                  login form — it will offer to fill the user's saved website
                  password into a key field, and offer to save an API key as a
                  password for this origin. Honest about the limit: Chrome has
                  historically ignored `off` on password inputs in some versions,
                  so this states the intent rather than guaranteeing the behaviour.
                  `spellCheck` off because a key is not prose, and a red squiggle
                  under a 70-character token is noise. */}
              <Input
                id="nvidia-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
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
                autoComplete="off"
                spellCheck={false}
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

      <MemoriesPanel
        open={memoriesOpen}
        onOpenChange={setMemoriesOpen}
        onMemoriesChanged={onMemoriesChanged}
        onInstructionsChanged={onInstructionsChanged}
      />
    </>
  );
}
