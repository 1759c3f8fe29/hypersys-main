import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { Link } from 'react-router-dom';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useAuth } from '@/hooks/useAuth';
import { firestoreDb, type FirestoreMemory, type UserSettings } from '@/lib/firestore-db';
import ChatSidebar, { AI_MODELS } from '@/components/chat/ChatSidebar';
import {
  DEFAULT_MODEL_ID,
  canonicalModelId,
  supportsTools,
} from '@/lib/providers';
import ChatMessage from '@/components/chat/ChatMessage';
import ChatInput from '@/components/chat/ChatInput';
import ModelSelector from '@/components/chat/ModelSelector';
import WelcomeScreen from '@/components/chat/WelcomeScreen';
import { generateChatResponse, generateVisionResponse, generateImageResponse, buildImagePrompt, craftVisionPrompt, generateSmartChatTitle, isVisionModel, isVisionCapableModel, isImageModel, VISION_ENGINE_MODEL, type ChatMessage as AiChatMessage, type ContentPart } from '@/lib/ai';
import {
  buildFlyerSystemPrompt,
  buildFlyerThinkingPrompt,
  buildVisionSystemPrompt,
  buildDeepThinkDirective,
} from '@/lib/prompts';
import { webSearch, buildSearchContext } from '@/lib/search';
import { runAgentTurn, AGENT_TOOLS_ENABLED, MAX_STEPS } from '@/lib/agent';
import type { ToolArtifacts } from '@/lib/tools';
import { LOGO_URL } from '@/lib/assets';
import { extractDocument, canExtract, buildDocumentContext } from '@/lib/documents';
import { extractArtifacts, artifactsFromHistory } from '@/lib/artifacts';
import { clearFinishedRuns } from '@/lib/code-runs';
import { ingestArtifacts, resetArtifacts, useArtifacts, closeArtifact, openFirstArtifact, readArtifactState } from '@/components/artifacts/ArtifactProvider';
import { ArtifactCanvas } from '@/components/artifacts/ArtifactCanvas';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { UNAVAILABLE_REASONS } from '@/lib/shortcuts';
import { conversationDocumentTitle } from '@/hooks/useDocumentTitle';
import { ShortcutsDialog } from '@/components/chat/ShortcutsDialog';
import { Button } from '@/components/ui/button';
import type { ChatAttachment, MessageCodeRun, MessageFile, MessageSource } from '@/components/chat/types';
import { Menu, ArrowDown, Sparkles, AlertTriangle, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { extractFirstMarkdownImage, sanitizeAssistantText, withPersistedImage, closeUnterminatedFence } from '@/lib/chat-format';
import { buildMessageForest, linearizeForest, switchBranch, toTreeMessages, type TreeNode } from '@/lib/message-tree';
import { extractMemories, dedupeMemories } from '@/lib/memory';

interface ArenaResponse {
  modelId: string;
  modelName: string;
  content: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
  attachments?: ChatAttachment[];
  modelName?: string;
  // Web pages this reply was grounded on, shown as source chips.
  sources?: MessageSource[];
  // Related questions surfaced by web search, shown as clickable follow-up
  // chips. The data already comes back from the search provider; this just
  // carries it to the message so it can be rendered.
  followUps?: string[];
  // Files the create_file tool produced, shown as download links. Blob URLs,
  // so they live only as long as this tab — not persisted with the message.
  files?: MessageFile[];
  // Python the run_code tool staged this turn (Part G). Execution is user-gated:
  // these carry the script, not its output, and the block's Run button is the only
  // thing that starts the interpreter. Session-only, like `files`.
  codeRuns?: MessageCodeRun[];
  // Arena Mode
  isArenaMode?: boolean;
  arenaResponses?: ArenaResponse[];
  // Threading (Part F). Mirrors FirestoreMessage.parentMessageId: each node
  // points at its parent, roots are null. Carried on the UI message so the
  // linearizer and the branch switcher can walk the tree without re-reading DB.
  parentMessageId?: string | null;
  siblingIndex?: number;
  // The children of this node, grouped as alternative branches. Populated by
  // buildMessageForest from the flat DB list; empty for leaves. Enables the
  // < 1/3 > branch switcher on a parent that has several replies (an edited
  // user message, or a regenerated assistant answer).
  children?: Message[];
  // Which child branch is currently expanded/visible. Defaults to the last
  // child (the most recent edit/regenerate), matching ChatGPT's "latest wins"
  // behaviour. The switcher mutates this index.
  activeChildIndex?: number;
  // Branch-switcher metadata, stamped on by linearizeForest: this node's
  // 1-based position among its siblings and the total sibling count. When
  // branchCount > 1 the row shows a < 2/3 > switcher. Roots report 1/1, so
  // the switcher only appears where a real branch exists.
  __branchIndex?: number;
  __branchCount?: number;
}

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  modelId?: string;
}

// The large NIM models (nemotron-ultra, minimax-m3, kimi-k2.6)
// and the Mistral large/medium tiers cold-start 60-100s before the first token,
// then stream fine. The base timeout must clear that window or those models
// always error. Verified worst-case first-token was ~100s on 2026-07-21.
const REQUEST_TIMEOUT_MS = 130_000;
const SLOW_REQUEST_TIMEOUT_MS = 130_000;
// How long a stream may sit silent between chunks before we treat the
// connection as dead. Distinct from REQUEST_TIMEOUT_MS, which guards only the
// cold-start wait (cleared on the first token). This one arms AFTER streaming
// starts and resets on every chunk, so it catches the failure the cold-start
// guard structurally cannot — a model that streams one token then hangs. 60s is
// above the pauses reasoning models take between their thinking block and the
// answer, which measured at ~30s on minimax-m3; below it, healthy answers would
// be cut. The abort it triggers reuses the existing AbortError path, so no new
// teardown is needed.
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_VISION_MODEL = VISION_ENGINE_MODEL;

/** Whether the conversations panel was collapsed when the app was last closed.
 *  Namespaced like `Flyer_guest`, the only other app-owned key in localStorage —
 *  the `VITE_*` ones are user-supplied API keys and follow a different convention
 *  because they shadow build-time variable names. */
const SIDEBAR_COLLAPSED_KEY = 'Flyer_sidebar_collapsed';

// Open-ended requests benefit from the crafted master analysis prompt; targeted
// questions do not (see the call site in handleSendMessage).
const OPEN_ENDED_VISION_REQUEST = /\b(describe|analy[sz]e|explain|breakdown|break down|what(?:'s| is) (?:in|this|going on)|tell me about|review|critique|summari[sz]e|extract everything|full details?)\b/i;

function wantsFullVisionAnalysis(request: string): boolean {
  const text = (request || '').trim();
  // The default text used when a file is attached with no message.
  if (!text || text === 'Describe this image in detail.') return true;
  // A short prompt is almost always a pointed question ("what colour?", "read this").
  if (text.length < 24 && !OPEN_ENDED_VISION_REQUEST.test(text)) return false;
  return OPEN_ENDED_VISION_REQUEST.test(text);
}

// The system prompts live in src/lib/prompts.ts. They used to be three inline
// builders here; they are structural ports of the reference prompts in
// src/custom.md (instant) and src/custumthink.md (thinking), carrying only the
// tool and rendering machinery Flyer actually has.

const compressImage = (file: File, maxWidth = 1024, maxHeight = 1024, quality = 0.8): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve(dataUrl);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(img.src);
      reject(err);
    };
  });
};

const fileToDataUrl = (file: File): Promise<string> => {
  if (file.type.startsWith('image/')) {
    // Send the image at full quality (no downscaling / re-encoding). Only fall
    // back to compression if the raw image is large enough to risk hitting the
    // Firestore 1MB per-document limit or the model's payload cap.
    const RAW_LIMIT_BYTES = 900_000; // ~0.9MB — safely under Firestore's 1MB doc limit
    if (file.size <= RAW_LIMIT_BYTES) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        reader.readAsDataURL(file);
      });
    }
    return compressImage(file, 2048, 2048, 0.92).catch(() => {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        reader.readAsDataURL(file);
      });
    });
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
};

export default function Chat() {
  const { user, isGuest } = useAuth();
  /**
   * Hoisted to the top of the component because three separate things need it and
   * one of them is a keyboard handler registered above where this used to be
   * declared — see the `toggle-sidebar` handler and §14.2 #20. It also used to be
   * computed twice from the same two values, once here and once inside
   * `handleSendMessage`, which is one definition too many for the predicate that
   * decides whether anything is persisted at all.
   */
  const isAuthenticated = !!user && !isGuest;
  // The canvas is absolutely docked inside <main>, so every full-width row in
  // that column (header, message scroller, composer) has to reserve the space it
  // occupies or it renders underneath the panel. The width comes from the store
  // because the panel is drag-resizable: a fixed gutter and a variable panel
  // disagree the moment the user drags, and the conversation loses its right
  // edge. The reservation cannot go on <main> itself — `right-0` on the canvas
  // resolves against main's padding box, so padding there would move the panel
  // rather than make room for it.
  const { openId: openArtifactId, canvasWidth } = useArtifacts();
  const canvasGutter = openArtifactId
    ? ({ ["--canvas-gutter" as string]: `${canvasWidth}px` } as React.CSSProperties)
    : undefined;
  // Applied unconditionally; with the variable unset the fallback is 0px, so
  // there is no conditional-class path that can go stale.
  const canvasGutterClass = "lg:pr-[var(--canvas-gutter,0px)]";

  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Whether the history list can be believed yet (§14 item #10).
  //
  // Without this the sidebar's "No conversations yet" empty state doubled as the
  // loading state AND as the error state, which made it a false statement in two
  // different ways: a returning user with fifty chats was told they had none for
  // as long as the Firestore read took, and a read that failed outright looked
  // identical to a brand-new account. An empty state has to mean "empty".
  //
  // Starts at 'loading' when there is a user, because Chat sits behind two auth
  // guards in App.tsx that both short-circuit on `loading` from useAuth() — so by
  // the time this component first renders, `user` is already resolved and a fetch
  // is genuinely about to happen. A guest starts 'ready': there is nothing to
  // fetch for them, and "no conversations yet" is the truthful thing to show.
  const [conversationsStatus, setConversationsStatus] = useState<
    'loading' | 'ready' | 'error'
  >(() => (user ? 'loading' : 'ready'));
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // ── Persistent memory + custom instructions (Part F.2/F.3) ──
  //
  // Memories are short facts about the user auto-extracted after each turn
  // and/or added manually. Custom instructions are the user's "about me" and
  // "how to respond" directives. Both are injected into the system prompt via
  // the existing # User Memories / # User's Instructions slots in
  // contextBlocks() — which were wired but never fed.
  //
  // Kept in a ref too because the async send handler reads them and a state
  // value would be stale across awaits; the state copy drives the management
  // panel UI.
  const [memories, setMemories] = useState<FirestoreMemory[]>([]);
  const memoriesRef = useRef<FirestoreMemory[]>([]);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const userSettingsRef = useRef<UserSettings | null>(null);
  // The threaded forest backing `messages`. Kept in a ref so the branch
  // switcher can re-linearize a different active child without re-reading the
  // DB: switching branches is a pure tree reshape (the data didn't change,
  // only which sibling is visible). A fresh conversation load rebuilds this;
  // a live send appends into it. See switchBranch() in message-tree.ts.
  const messageForestRef = useRef<TreeNode[]>([]);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  // Whether the last history read for the open conversation failed (§14 item #10).
  //
  // Without it, a failed getMessages() left `messages` empty and the render fell
  // straight through to the WelcomeScreen — so an existing conversation whose read
  // had errored greeted the user with "how can I help you today?". That is the
  // worst variant of this bug family in the app: it is not merely a false empty
  // state, it invites the user to type into what looks like a fresh chat, and the
  // outgoing request would carry none of the history that is still sitting in
  // Firestore. Silent context loss, presented as a normal screen.
  const [messagesError, setMessagesError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  // Explicit user overrides for the automatic intent classifier. DeepThink
  // forces extended step-by-step reasoning; forceWebSearch always grounds the
  // turn in live results instead of letting the classifier decide.
  const [deepThink, setDeepThink] = useState(false);
  const [forceWebSearch, setForceWebSearch] = useState(false);
  // The conversations panel: remembered across launches, and open by default on a
  // window wide enough to hold it (§14 native look-and-feel).
  //
  // This was `useState(true)` — collapsed on every single launch, at every window
  // size. Two problems, and the second is the bad one:
  //
  //   1. No native app forgets which panels you had open. Finder, Mail, VS Code and
  //      Slack all restore sidebar visibility, because it is a statement about how
  //      you work rather than a transient view state.
  //   2. On a 1400px desktop window it hid the entire conversation history behind a
  //      toggle the user had to find first. A returning user's chats appeared to be
  //      gone — which, combined with the false empty state fixed in #10, was two
  //      independent reasons to think the app had lost your data.
  //
  // The fallback is keyed on the `lg` breakpoint (1024px) rather than on a taste
  // call, because that is the exact width at which the sidebar stops being `fixed`
  // and overlaying the chat: open-by-default below it would cover the conversation
  // the user is reading, which is why the collapsed default existed in the first
  // place. So: remember the choice, and when there is no choice to remember, let the
  // layout decide.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (saved === 'true') return true;
      if (saved === 'false') return false;
    } catch {
      // Private-browsing Safari throws on localStorage access rather than returning
      // null. A remembered panel state is not worth a blank page, so fall through.
    }
    return window.innerWidth < 1024;
  });

  // Persisted on change rather than on unmount: the desktop shell is normally closed
  // by killing the window, and an unmount-time write would never run.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
    } catch {
      // Same reasoning as the read above — this is a convenience, not state the app
      // depends on.
    }
  }, [sidebarCollapsed]);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  
  // Arena Mode state
  const [isArenaMode, setIsArenaMode] = useState(false);
  const [compareModels, setCompareModels] = useState<string[]>(['llama-8b']);

  // Drag and Drop File System state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // The virtuoso scroller for the message list. Owns its own viewport, so the
  // manual scrollTop/scrollHeight math below is replaced by Virtuoso's
  // followOutput + atBottomStateChange. Kept for the loading/welcome states.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isNewConversationRef = useRef(false);

  // Every object URL create_file handed out this session. Blob URLs pin their
  // blob in memory until revoked, and an xlsx can be megabytes — a long session
  // of "make me a spreadsheet" leaks all of them otherwise. Revoked when the
  // conversation is left or the page unloads, not when the chip unmounts: the
  // user may still be mid-download.
  const objectUrlsRef = useRef<string[]>([]);

  const revokeObjectUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current = [];
  }, []);

  // Unmount and hard navigation both end the tab's use of those blobs.
  useEffect(() => revokeObjectUrls, [revokeObjectUrls]);

  // ── Streaming autoscroll ──────────────────────────────────────────────
  // Follow the stream only while the user is actually parked at the bottom.
  // The moment they scroll up to re-read something, stop yanking the view
  // back down — that fight is the single most un-native thing a chat UI can
  // do. Scrolling back to the bottom re-arms it.
  const isPinnedToBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Separate from isPinnedToBottomRef, which only tracks "is the user parked at
  // the bottom right now". This one gates autoscroll off entirely until the user
  // sends in this conversation, so opening a chat lands at the natural top of
  // the loaded history instead of snapping to the newest message. Re-armed on
  // send, disarmed again on conversation switch.
  const hasSentThisSessionRef = useRef(false);

  // Pinning + the jump-to-latest button now come from Virtuoso's
  // atBottomStateChange, so the old onScroll math (PIN_THRESHOLD_PX, the 240px
  // gate) is gone. isPinnedToBottomRef is still written by atBottomStateChange
  // so the streaming autoscroll effect can keep its "only while pinned" gate.

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    // Prefer the virtualized scroller when it is mounted (the normal chat path);
    // fall back to the plain container for the loading/welcome states. Virtuoso's
    // scrollToIndex only accepts 'auto' | 'smooth', so coerce 'instant' → 'auto'.
    const vBehavior = behavior === 'smooth' ? 'smooth' : 'auto';
    if (virtuosoRef.current && messages.length > 0) {
      virtuosoRef.current.scrollToIndex({ index: 'LAST', behavior: vBehavior });
    } else {
      const el = scrollContainerRef.current;
      if (!el) return;
      // scrollTop rather than scrollIntoView: scrollIntoView on a child can also
      // scroll ancestor containers and shift the whole page on mobile.
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
    isPinnedToBottomRef.current = true;
    setShowScrollToBottom(false);
  }, [messages.length]);

  // Runs after every message mutation, including each streamed delta. Layout
  // effect so the adjustment happens in the same frame the new text paints —
  // in a passive effect the old scroll position shows for one frame and the
  // text visibly judders as it streams.
  useLayoutEffect(() => {
    // Don't touch scroll before the user has sent anything this session: this
    // effect also runs when a conversation's history finishes loading, and
    // scrolling there is what made the screen open already-scrolled-down.
    if (!hasSentThisSessionRef.current) return;
    if (!isPinnedToBottomRef.current) return;
    // During streaming the last item's height grows as tokens arrive; Virtuoso's
    // followOutput handles the data-array case but an in-place content bump can
    // leave the tail a frame behind, so we nudge it to the last index. 'auto'
    // (not smooth) because a smooth animation per token queues dozens of
    // overlapping animations and lags behind the text.
    if (virtuosoRef.current && messages.length > 0) {
      virtuosoRef.current.scrollToIndex({ index: messages.length - 1, behavior: 'auto', align: 'end' });
      return;
    }
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    dragCounterRef.current = 0;

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      handleSendMessage('', files);
    }
  };

  const createSparkleBurst = () => {
    const sendBtn = document.querySelector('button[aria-label="Send message"]');
    let x = window.innerWidth / 2;
    let y = window.innerHeight - 80;

    if (sendBtn) {
      const rect = sendBtn.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    } else {
      const inputEl = document.querySelector('textarea');
      if (inputEl) {
        const rect = inputEl.getBoundingClientRect();
        x = rect.right - 20;
        y = rect.top + rect.height / 2;
      }
    }

    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = `${x}px`;
    container.style.top = `${y}px`;
    container.style.pointerEvents = 'none';
    container.style.zIndex = '9999';
    document.body.appendChild(container);

    const colors = ['#1ad1b9', '#258eff', '#984cff', '#ff2d74', '#ff8f1f', '#1cb866'];
    for (let i = 0; i < 20; i++) {
      const particle = document.createElement('div');
      particle.style.position = 'absolute';
      particle.style.width = `${Math.random() * 8 + 4}px`;
      particle.style.height = particle.style.width;
      particle.style.borderRadius = '50%';
      particle.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      particle.style.boxShadow = `0 0 10px ${particle.style.backgroundColor}`;
      
      const angle = Math.random() * Math.PI * 2;
      const velocity = Math.random() * 90 + 40;
      const dx = Math.cos(angle) * velocity;
      const dy = Math.sin(angle) * velocity;

      particle.animate([
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0)`, opacity: 0 }
      ], {
        duration: Math.random() * 600 + 500,
        easing: 'cubic-bezier(0.1, 0.8, 0.3, 1)',
        fill: 'forwards'
      });

      container.appendChild(particle);
    }

    setTimeout(() => container.remove(), 1200);
  };


  const loadConversations = useCallback(async () => {
    if (!user) {
      // Not an early bail-out any more. A guest has no stored history, so the
      // list is genuinely empty and genuinely finished loading — returning
      // without saying so would leave the status stuck at whatever it was and
      // show skeleton rows forever on a signed-out shell.
      setConversations([]);
      setConversationsStatus('ready');
      return;
    }
    setConversationsStatus('loading');
    try {
      const data = await firestoreDb.getConversations(user.uid);
      setConversations(data.map(c => ({
        id: c.id,
        title: c.title,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        modelId: c.modelId
      })));
      setConversationsStatus('ready');
    } catch (error) {
      // Was an unhandled rejection: the promise died, the list stayed empty, and
      // the user was shown the empty state as if the account were new. Console
      // rather than a toast because the sidebar now renders the failure inline
      // with its own Retry — a toast on top of that is the same news twice, and
      // this also fires on the post-turn refresh at the end of handleSendMessage
      // where a toast would interrupt reading the answer.
      console.error('[chat] could not load conversations', error);
      setConversationsStatus('error');
    }
  }, [user]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // Name the window after the open conversation (§14 native look-and-feel).
  //
  // A native document app puts the document in its title bar, its taskbar entry and
  // its window switcher; an app whose window is called the same thing no matter
  // what is open is a browser tab wearing a frame. This one effect drives all three
  // plus the in-app strip, because Chromium fires `page-title-updated` on a
  // `document.title` write and Electron's default handler applies it to the
  // BrowserWindow — see src/hooks/useDocumentTitle.ts for why the DOM is the
  // transport rather than a context.
  //
  // Note this deliberately overrides index.html's `<title>`, which is a search-
  // result sentence ("Flyer AI: Chat, Work, Create, Search & Code with AI"). That is
  // the right thing to *serve* and the wrong thing for a window switcher to show.
  // Crawlers read the served HTML; this runs after mount, so both get what they
  // need. It also means the packaged window stops being titled with a marketing
  // line, which the `title: "Flyer AI"` option in main.cjs never prevented — that
  // option only holds until the page loads.
  useEffect(() => {
    const active = conversations.find((c) => c.id === activeConversationId);
    document.title = conversationDocumentTitle(active?.title);
    // No cleanup that restores the old title: the next run overwrites it, and on
    // unmount the app is going away. Resetting to the SEO sentence on the way out
    // would put it back in the window switcher for the final frame.
  }, [conversations, activeConversationId]);

  // Load the user's persisted memories + custom instructions once they're
  // authenticated. Guest mode has no Firestore writes (isAuthenticated gate
  // below), so for guests these stay empty and the prompt slots render nothing —
  // matching the existing `if (isAuthenticated)` guard on conversations.
  // Mirrored into refs because handleSendMessage reads them from an async
  // context where the state value would be stale.
  useEffect(() => {
    if (!user || isGuest) { setMemories([]); memoriesRef.current = []; setUserSettings(null); userSettingsRef.current = null; return; }
    (async () => {
      const [m, s] = await Promise.all([
        firestoreDb.getMemories(user.uid),
        firestoreDb.getUserSettings(user.uid),
      ]);
      setMemories(m); memoriesRef.current = m;
      setUserSettings(s); userSettingsRef.current = s;
    })();
  }, [user, isGuest]);

  // The system-prompt injection uses a single concatenated string for each
  // slot, matching how contextBlocks() consumes them (one `# User Memories`
  // block carrying all facts at once). Manual + auto memories are combined;
  // a memory is one line. Kept as a helper so the send path and the panel
  // both derive the same rendering.
  const memoriesAsPromptBlock = useCallback((list: FirestoreMemory[]): string => {
    if (list.length === 0) return '';
    return list.map((m) => `- ${m.content}`).join('\n');
  }, []);
  const instructionsAsPromptBlock = useCallback((s: UserSettings | null): string => {
    if (!s) return '';
    const parts: string[] = [];
    if (s.aboutMe.trim()) parts.push(`About me:\n${s.aboutMe.trim()}`);
    if (s.howToRespond.trim()) parts.push(`How to respond:\n${s.howToRespond.trim()}`);
    return parts.join('\n\n');
  }, []);

  // Refresh hooks the Memories panel calls after it mutates memories or
  // instructions. Re-reads from Firestore and updates both the state (panel
  // UI) and the ref (prompt injection), so the next send picks up the change.
  const reloadMemories = useCallback(async () => {
    if (!user || isGuest) return;
    const m = await firestoreDb.getMemories(user.uid);
    setMemories(m); memoriesRef.current = m;
  }, [user, isGuest]);
  const reloadInstructions = useCallback(async () => {
    if (!user || isGuest) return;
    const s = await firestoreDb.getUserSettings(user.uid);
    setUserSettings(s); userSettingsRef.current = s;
  }, [user, isGuest]);

  const loadMessages = useCallback(async () => {
    // Opening or switching a conversation disarms autoscroll so the freshly
    // loaded history renders from its natural position instead of snapping to
    // the bottom. Re-armed the moment the user sends in this conversation.
    hasSentThisSessionRef.current = false;
    isPinnedToBottomRef.current = true;
    setShowScrollToBottom(false);
    // Cleared here rather than only in the try block, so it also resets on the two
    // early returns below: leaving a stale error set would make "New chat" render
    // the failure state for a conversation that no longer exists.
    setMessagesError(false);
    // resetArtifacts() here as well as in the load path below, because this early
    // return is the "New chat" case and it was leaking the canvas: messages and
    // object URLs were cleared but the artefact store was not, so starting a fresh
    // chat left the *previous* conversation's files and code still listed in the
    // right-hand canvas — and still open, if it was open. The two paths look
    // interchangeable but only one of them was doing the full teardown.
    if (!activeConversationId) { setMessages([]); revokeObjectUrls(); resetArtifacts(); return; }
    if (isNewConversationRef.current) {
      isNewConversationRef.current = false;
      return;
    }
    setIsMessagesLoading(true);
    setMessages([]); // Clear stale messages immediately
    revokeObjectUrls(); // old downloads die with the old conversation
    resetArtifacts(); // canvas history and open panel die with the old conversation too
    try {
      const data = await firestoreDb.getMessages(activeConversationId);
      // Messages come back as a flat list. buildMessageForest assembles them
      // into a tree, then linearizeForest walks the active branch of each node
      // to produce the ordered array we render. Old conversations imported
      // before parentMessageId existed read back as all-roots — a forest of
      // single-node trees — which linearizes in createdAt order, preserving
      // the original flat history exactly.
      //
      // The row mapping lives in message-tree.ts as `toTreeMessages` rather than
      // inline here, so `message-threading-roundtrip.test.ts` drives the same code
      // this path does. It was inline, and it was quietly dropping `createdAt`.
      const forest = buildMessageForest(toTreeMessages(data));
      messageForestRef.current = forest;
      setMessages(linearizeForest(forest) as Message[]);
      // Re-derive the canvas from the history we just loaded. `resetArtifacts()`
      // above empties the store, and until this line nothing refilled it — so
      // reopening a conversation full of code left the canvas claiming there was
      // none (see artifactsFromHistory for what that cost).
      //
      // Fed the *flat* list rather than the linearized branch, and that is the
      // faithful set rather than the convenient one: the store "accumulates
      // artifacts across a whole conversation" (its own header comment), and live
      // it does — every regeneration ingested as it completed, so the older
      // sibling's block stays listed after a regenerate replaces it on screen.
      // Restoring only the visible branch would quietly drop the rest, and the
      // seam would show: switching to a sibling would render its code full-height
      // inline while its neighbour showed a card, because `CodeBlock` collapses on
      // the store holding the id and only one of them would be in there.
      //
      // One ingest for the conversation rather than one per message: the store
      // emits on every call and every subscribed code block re-renders on each.
      ingestArtifacts(artifactsFromHistory(data));
    } catch (e) {
      console.error("Failed to load messages:", e);
      setMessagesError(true);
    } finally {
      setIsMessagesLoading(false);
    }
    // revokeObjectUrls is a useCallback with empty deps, so its identity never
    // changes: listing it satisfies the exhaustive-deps rule without making
    // loadMessages unstable, which would re-fire the effect below and refetch
    // the conversation on every render.
  }, [activeConversationId, revokeObjectUrls]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  // Finished runs hold matplotlib PNGs as data URLs, so a long session of "plot
  // this" turns into megabytes of retained strings. Switching conversations is
  // the natural point to drop them: the blocks that displayed them are gone.
  // Only finished ones — a run still executing belongs to the user who started
  // it and survives navigation on purpose (see lib/code-runs.ts).
  useEffect(() => { clearFinishedRuns(); }, [activeConversationId]);

  // Restore the selected model when switching conversations. Older chats carry
  // ids that have since been renamed or retired, so resolve through the
  // catalogue's legacy map first and only fall back to the default when the id
  // is genuinely unknown — otherwise reopening an old chat silently moves it to
  // a different model.
  useEffect(() => {
    if (activeConversationId) {
      const activeConv = conversations.find(c => c.id === activeConversationId);
      if (activeConv?.modelId) {
        setSelectedModel(canonicalModelId(activeConv.modelId) ?? DEFAULT_MODEL_ID);
      }
    }
  }, [activeConversationId, conversations]);

  const handleSelectModel = async (modelId: string) => {
    setSelectedModel(modelId);
    if (activeConversationId && user && !isGuest) {
      try {
        await firestoreDb.updateConversationModel(activeConversationId, modelId);
        setConversations(prev => prev.map(c => c.id === activeConversationId ? { ...c, modelId } : c));
      } catch (e) {
        console.error("Failed to update conversation model:", e);
        // Not reverted, and that is the point of the message. setSelectedModel
        // above already succeeded, so this turn *will* use the model the user
        // picked — what failed is only remembering it. Reverting the picker here
        // would contradict the model the next reply is actually going to come
        // from, which is a worse lie than the one being reported.
        //
        // Worth reporting rather than logging because the divergence is invisible
        // and delayed: the picker reads correctly all session, and then the chat
        // reopens tomorrow on the old model, so the next reply in a long thread
        // comes from somewhere else with nothing on screen having changed.
        toast.error("Switched for now, but couldn't save this chat's model.", {
          id: 'model-pref-failed',
        });
      }
    }
  };

  const createConversation = async (firstMessage: string): Promise<string | null> => {
    if (!user) return null;
    const title = firstMessage.slice(0, 50) + (firstMessage.length > 50 ? '...' : '');
    try {
      const convId = await firestoreDb.createConversation(user.uid, title, selectedModel);
      setConversations((prev) => [
        { id: convId, title, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), modelId: selectedModel },
        ...prev
      ]);
      return convId;
    } catch (e) {
      console.error(e);
      toast.error('Failed to create conversation');
      return null;
    }
  };

  const saveMessage = async (
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    modelName?: string,
    attachments?: ChatAttachment[],
    parentMessageId?: string | null,
    // The on-screen message's own id. Persisted alongside parentMessageId so the
    // two are drawn from the same namespace after a reload — see the `clientId`
    // comment in firestore-db.getMessages. Optional so a caller that has no local
    // message (there is none today) still compiles, but every call site passes it.
    clientId?: string
  ) => {
    if (!user) return false;
    try {
      await firestoreDb.saveMessage(conversationId, user.uid, role, content, modelName, attachments, parentMessageId, clientId);
      return true;
    } catch (e) {
      console.error("Error saving message:", e);
      // This used to log and return, which made a failed write indistinguishable
      // from a successful one to everything downstream — the message is already
      // in React state and on screen, so the turn carried on and looked fine.
      //
      // Both halves of the failure are silent and both corrupt the thread:
      //   the user's turn fails  → the reply saves against a parentMessageId that
      //                            no longer resolves, so the reload shows an
      //                            answer with no question
      //   the reply fails        → the reload shows a question with no answer, and
      //                            the next turn sends the model a history where
      //                            its own previous answer is missing
      //
      // One toast, not one per call: sonner treats a repeated `id` as an update to
      // the same toast, so a turn where both writes fail reports once. The wording
      // names the consequence rather than the cause, because "reopen this chat and
      // it may be gone" is the part the user can act on — copying the reply out.
      toast.error("Couldn't save that message. It may be missing when you reopen this chat.", {
        id: 'save-message-failed',
      });
      return false;
    }
  };

  const handleSendMessage = async (content: string, files: File[] = []) => {
    if ((!content.trim() && files.length === 0) || isLoading) return;

    createSparkleBurst();

    const trimmedContent = content.trim();

    // Fire-and-forget memory extraction (Part F.2). After a successful turn we
    // ask a cheap model to pull out durable facts about the user from THIS
    // turn, dedupe them against the memories already cached in memory, and
    // persist any new ones to Firestore. Fully non-blocking and failure-proof:
    // it never awaits here, never throws into the send flow, and a wrong extract
    // is recoverable from the Memories panel. Only fires for authenticated
    // users — guests have no Firestore writes.
    const maybeExtractMemories = (assistantText: string) => {
      if (!user || isGuest) return;
      const userText = trimmedContent;
      // Read the latest memories from the ref (state would be stale across the
      // await below) and dedupe against it.
      const existing = memoriesRef.current.map((m) => m.content);
      void (async () => {
        try {
          const candidates = await extractMemories(userText, assistantText);
          const fresh = dedupeMemories(existing, candidates);
          if (fresh.length === 0) return;
          // Persist each new fact and merge into the cache so the NEXT turn in
          // this same session sees it without a reload.
          const saved: FirestoreMemory[] = [];
          for (const c of fresh) {
            const id = await firestoreDb.addMemory(user.uid, c, 'auto');
            if (id) saved.push({ id, userId: user.uid, content: c, source: 'auto', createdAt: new Date().toISOString() });
          }
          if (saved.length === 0) return;
          setMemories((prev) => [...saved, ...prev]);
          memoriesRef.current = [...saved, ...memoriesRef.current];
        } catch {
          // best-effort — never surface a memory error to the user
        }
      })();
    };

    const pendingAttachments: ChatAttachment[] = await Promise.all(
      files.map(async (file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        url: await fileToDataUrl(file),
        type: file.type.startsWith('image/') ? 'image' as const : 'file' as const,
        mimeType: file.type,
        size: file.size,
      })),
    );

    // Non-image uploads have to be parsed into text before the model can use
    // them. Previously they were only base64-encoded, so a PDF reached the model
    // as an opaque blob and it answered by guessing. The attachment id each File
    // received above is threaded into extraction, so the text block the model
    // reads carries an attachment_id it can hand to edit_file.
    //
    // `canExtract` is every non-image file now, which is the point: it used to be
    // a closed format list, and this line *silently dropped* whatever it rejected.
    // The attachment still rendered and its name still reached the model, so an
    // upload outside the list produced a confident answer about a file nobody had
    // opened. documents.ts is total now — unknown types are sniffed, read as text
    // when they are text, and identified when they are not — so nothing is lost
    // here any more.
    const documentFiles = files.filter(canExtract);
    const extractedDocs = documentFiles.length > 0
      ? await Promise.all(
          // pendingAttachments maps 1:1 with files by index, so the matching
          // attachment carries the same id this doc will surface.
          documentFiles.map((file) => {
            const idx = files.indexOf(file);
            const id = pendingAttachments[idx]?.id;
            return extractDocument(file, id);
          }),
        )
      : [];

    for (const doc of extractedDocs) {
      if (doc.error) toast.error(`${doc.name}: ${doc.error}`);
      else if (doc.truncated) toast.warning(`${doc.name} was truncated to fit the context window.`);
    }

    const requestContent = trimmedContent || (pendingAttachments.length > 0 ? 'Describe this image in detail.' : '');

    const selectedModelMeta = AI_MODELS.find((model) => model.id === selectedModel) || AI_MODELS[0];
    const imageAttachments = pendingAttachments.filter((a) => a.type === 'image');
    const hasImages = imageAttachments.length > 0;

    // Threading (Part F): the new user message replies to the last assistant
    // message in the visible path (what the user is continuing from). For the
    // very first turn of a conversation there is no assistant message yet, so
    // this user message is a root (parentMessageId null). The assistant reply
    // then replies to this user message. This parent linkage is what lets a
    // later edit/regenerate append a sibling branch rather than mutate.
    //
    // "Last assistant" means the last assistant message that actually has
    // content — the streaming placeholder we're about to append isn't one
    // yet, and a mid-flight empty placeholder from a previous (failed) turn
    // shouldn't become a branch root either.
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim() !== '');
    const userParentId = lastAssistant?.id ?? null;

    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: trimmedContent, attachments: pendingAttachments, parentMessageId: userParentId };
    const assistantMessage: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', modelName: selectedModelMeta.name, parentMessageId: userMessage.id };

    // ── INSTANT UI UPDATE — show user message + thinking placeholder NOW ──
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    // Sending arms autoscroll and re-pins: you sent it, you want to watch the
    // answer arrive.
    hasSentThisSessionRef.current = true;
    isPinnedToBottomRef.current = true;
    scrollToBottom('smooth');
    setStatusText('Understanding your request...');

    // ── What this turn needs is now the model's call, not a pre-flight guess ──
    //
    // The classifier that used to run here (evaluateUserIntent) is gone. Two
    // signals decide the shape of the turn, and both are things the user did
    // rather than things a regex inferred:
    //
    //   isImageGen — they picked an Image model in the sidebar.
    //   forceWebSearch — they pressed the Search toggle.
    //
    // Everything else the model decides mid-turn by calling a tool. On the paths
    // the loop does not cover (no tool support, Arena mode) that means no search
    // unless the toggle is on: those models cannot call the tool themselves, so
    // the toggle is the only grounding they get.
    const isImageGen = isImageModel(selectedModel);

    let effectiveModelId = selectedModel;
    if (!isImageGen && hasImages && !isVisionCapableModel(selectedModel)) {
      effectiveModelId = DEFAULT_VISION_MODEL;
    }
    const usedVisionFallback = effectiveModelId !== selectedModel;

    // Tools are on for every turn the provider will accept them on — the point
    // of the loop is that the model reaches for one whenever it judges one
    // useful, so the only legitimate reasons to withhold them are mechanical.
    //
    // Gated on effectiveModelId, not selectedModel: on a vision fallback the
    // request goes to a different model, and asking THAT model for tools when it
    // has none is a provider-level rejection.
    //
    // Attached images used to disable the loop outright. That was wrong on the
    // default model, which is both vision- and tool-capable on one route: "read
    // this chart and compute the CAGR" needs run_code exactly as much as a text
    // turn does, and "what is this landmark, and what does it cost to visit now"
    // needs web_search. supportsTools() already withholds them from the
    // vision-only engines, so the mechanical check is sufficient on its own.
    const useAgent =
      AGENT_TOOLS_ENABLED &&
      !isArenaMode &&
      !isImageGen &&
      supportsTools(effectiveModelId);

    // Build the API message history (text only) and the current turn (multimodal
    // when the effective model can accept images).
    const historyMessages: AiChatMessage[] = messages.map((message) => ({ role: message.role, content: message.content }));
    const currentTurn: AiChatMessage =
      hasImages && isVisionCapableModel(effectiveModelId)
        ? {
            role: 'user',
            content: [
              { type: 'text' as const, text: requestContent },
              ...imageAttachments.map((a) => ({ type: 'image_url' as const, image_url: { url: a.url } })),
            ],
          }
        : { role: 'user', content: requestContent };
    // Prompt-render options shared by all three builders (vision / thinking /
    // instant). The memories + custom-instructions slots are fed here from the
    // persisted cache (loaded on auth, see the [user] effect above); for
    // unauthenticated/guest users they are empty strings and contextBlocks()
    // renders nothing, preserving the previous behaviour exactly.
    const promptOpts = {
      modelName: selectedModelMeta.name,
      memories: memoriesAsPromptBlock(memoriesRef.current),
      userInstructions: instructionsAsPromptBlock(userSettingsRef.current),
      // Renders the tool-use policy section. Passed the SAME expression that
      // decides whether the schemas actually go out, because the two disagreeing
      // is what produces fabricated tool output (block without tools) or a model
      // that hedges instead of searching (tools without block).
      toolsAvailable: useAgent,
    };

    const allMessages: AiChatMessage[] = [
      {
        role: 'system',
        content: [
          // The thinking prompt already carries the DeepThink override, so it
          // replaces the instant prompt rather than being appended to it. The
          // vision path keeps its own prompt and takes the override separately.
          hasImages
            ? buildVisionSystemPrompt(promptOpts)
            : deepThink
              ? buildFlyerThinkingPrompt(promptOpts)
              : buildFlyerSystemPrompt(promptOpts),
          hasImages && deepThink ? buildDeepThinkDirective() : '',
          // Extracted document text, when the user attached files.
          buildDocumentContext(extractedDocs) || '',
        ].filter(Boolean).join('\n\n'),
      },
      ...historyMessages,
      currentTurn,
    ];

    let convId = activeConversationId;

    if (!convId && isAuthenticated) {
      isNewConversationRef.current = true;
      const initialTitle = (trimmedContent || pendingAttachments[0]?.name || 'New chat').slice(0, 30);
      convId = await createConversation(initialTitle);
      if (!convId) {
        isNewConversationRef.current = false;
        // Revert messages on UI if creation failed
        setMessages((prev) => prev.slice(0, -2));
        return;
      }
      setActiveConversationId(convId);

      // Asynchronously generate a smart, concise 2-4 word title (like ChatGPT)
      const currentConvId = convId;
      generateSmartChatTitle(trimmedContent || requestContent).then((smartTitle) => {
        if (smartTitle && currentConvId) {
          // Swallowed on purpose, and the asymmetry with its two neighbours is
          // the reasoning. `handleRenameConversation` rolls back and toasts;
          // `handleSelectModel` keeps the local value and toasts (§14.2 #11).
          // Both of those changes were *asked for*, so silence would hide the
          // failure of something the user is waiting on. This one nobody asked
          // for: it is an automatic tidy-up of a title the app generated. If it
          // fails, the truncated first-50-characters title stays in Firestore,
          // and that still names the same conversation — the degradation carries
          // no false information, so there is no reassuring empty state to be
          // shown by mistake. Reporting it would be a toast about a background
          // nicety the user never requested.
          //
          // Logged rather than dropped, though: the empty `.catch(() => {})`
          // this replaces left no trail anywhere, which is the one thing every
          // deliberate swallow in this codebase is not allowed to do.
          firestoreDb.updateConversationTitle(currentConvId, smartTitle).catch((e) => {
            console.warn('[chat] auto title did not save:', e);
          });
          setConversations((prev) =>
            prev.map((c) => (c.id === currentConvId ? { ...c, title: smartTitle } : c)),
          );
        }
      });
    }

    if (convId && isAuthenticated) {
      await saveMessage(
        convId,
        'user',
        trimmedContent || (pendingAttachments.length > 0 ? `[Image uploaded] ${pendingAttachments.map((attachment) => attachment.name).join(', ')}` : requestContent),
        undefined,
        pendingAttachments,
        userMessage.parentMessageId,
        userMessage.id,
      );
    }

    setStatusText('Preparing response...');
    setIsLoading(true);
    abortControllerRef.current = new AbortController();

    const timeoutMs = isImageGen
      ? SLOW_REQUEST_TIMEOUT_MS
      : REQUEST_TIMEOUT_MS;

    let timeoutReached = false;
    let stalledMidStream = false;
    let receivedAssistantContent = false;
    const timeoutId = setTimeout(() => {
      timeoutReached = true;
      abortControllerRef.current?.abort();
    }, timeoutMs);
    // Once the first token arrives the model is alive and streaming — cancel the
    // cold-start guard so a long-but-healthy answer is never cut off mid-stream.
    const clearColdStartGuard = () => clearTimeout(timeoutId);

    // A second guard the cold-start one cannot cover: the provider that stalls
    // AFTER streaming begins. The cold-start timer is cleared on the first token,
    // so a connection that sends one token then hangs (the NVIDIA POST black-
    // hole: GET /v1/models returns in 0.3s while POST /v1/chat/completions gives
    // http_code=000 after 45s) leaves reader.read() awaiting forever and the turn
    // wedged until Stop is clicked. This is a self-resetting idle timer: it arms
    // once streaming starts, resets on every chunk, and aborts if no chunk
    // arrives within STREAM_IDLE_TIMEOUT_MS. A token every few hundred ms keeps
    // it alive indefinitely, which is correct — a healthy stream is never cut,
    // only a dead one. Sized above the cold-start window because reasoning
    // models sometimes pause between the thinking block and the answer.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalledMidStream = true;
        abortControllerRef.current?.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    const disarmIdleWatchdog = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    };

    // The partial answer the model streamed before a stall. Hoisted to this
    // scope (rather than living only in runPrimary) so the AbortError handler
    // can persist it: without this, a mid-stream stall sets React state with the
    // partial + a stall note but never calls saveMessage, and the whole bubble
    // is lost on reload. runPrimary's handleDelta appends to this.
    let runPrimaryPartialText = '';

    try {
      if (isImageGen) {
        const rawPrompt = trimmedContent || 'a beautiful, highly detailed artistic image';

        // isImageGen means the user picked this Image model, so it renders.
        //
        // The prompt is enriched locally by buildImagePrompt rather than by a
        // round-trip through a chat model (the old craftImagePrompt): it reads
        // the request type — logo, photo, anime, UI, 3D — and appends the
        // descriptors that steer a diffusion model toward it. Same intent, no
        // second model call in front of the image.
        setStatusText('Generating image...');
        const { imageDataUrl, message } = await generateImageResponse(
          buildImagePrompt(rawPrompt),
          selectedModel,
          imageAttachments.map(a => ({ dataUrl: a.url })),
          abortControllerRef.current.signal
        );

        const imageContent = `![Generated Image](${imageDataUrl})\n\n${message}`;

        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: imageContent, imageUrl: imageDataUrl } : m)),
        );
        receivedAssistantContent = true;

        if (convId && isAuthenticated) {
          await saveMessage(convId, 'assistant', imageContent, selectedModelMeta.name, undefined, assistantMessage.parentMessageId, assistantMessage.id);
        }
      } else {
        const messagesForModel = [...allMessages];

        // When images/files are uploaded, use the Chat model first to craft a 1000-word
        // master vision analysis prompt to supply internally to the vision engine.
        // Only worth the extra round-trip for open-ended "describe / analyse this"
        // turns: for a specific question ("what does line 3 say?") the generic
        // master prompt buries the actual question and the engine answers the
        // wrong thing, so the user's own words are sent instead.
        if (hasImages && wantsFullVisionAnalysis(requestContent)) {
          try {
            setStatusText('Analyzing image...');
            const masterVisionPrompt = await craftVisionPrompt(
              requestContent,
              pendingAttachments.map((a) => a.name),
              selectedModel,
              abortControllerRef.current.signal,
            );
            const lastIdx = messagesForModel.length - 1;
            if (lastIdx >= 0 && typeof messagesForModel[lastIdx].content !== 'string') {
              const contentArray = messagesForModel[lastIdx].content as ContentPart[];
              messagesForModel[lastIdx] = {
                role: 'user',
                content: [
                  // The user's literal request stays first and last so the engine
                  // answers *it*, using the master prompt only as guidance.
                  { type: 'text', text: [
                    `USER'S REQUEST: ${requestContent}`,
                    '',
                    'Analysis guidance:',
                    masterVisionPrompt,
                    '',
                    `Answer the user's request above ("${requestContent}") directly and first.`,
                  ].join('\n') },
                  ...contentArray.filter((part) => part.type === 'image_url'),
                ],
              };
            }
          } catch (e) {
            console.warn('Vision master prompt crafting fallback:', e);
          }
        }

        // Web search execution — the Search toggle only. There is no classifier
        // left to infer grounding, and on the agent path the model calls
        // web_search itself; forcing a pre-flight search there would pre-empt the
        // query it would have written, so the toggle becomes an instruction to
        // call the tool instead (below).
        //
        // What remains here is the fallback for models that cannot call tools at
        // all — `flyer-free`, the vision engines, Arena mode. For them the toggle
        // is the only way to ground a turn, so it still runs a real search and
        // splices the context in.
        let turnSources: MessageSource[] = [];
        let turnFollowUps: string[] = [];
        // Filled in by the agent loop's tools; merged onto the message when the
        // turn finishes, alongside anything this pre-flight search produced.
        let agentArtifacts: ToolArtifacts = {};
        const shouldSearch = !hasImages && !useAgent && !isImageGen && forceWebSearch;
        const searchQuery = requestContent.trim();
        if (shouldSearch && searchQuery) {
          try {
            setIsSearching(true);
            setStatusText('Searching the web...');
            const search = await webSearch(searchQuery, abortControllerRef.current?.signal);
            const context = buildSearchContext(search);
            if (search?.results?.length) {
              turnSources = search.results
                .filter((r) => r.link)
                .slice(0, 8)
                .map((r) => ({ title: r.title || r.link, link: r.link, source: r.source }));
            }
            // Related questions the search provider surfaced — offered to the
            // user as one-tap follow-ups, the way Gemini and Perplexity do.
            if (search?.related?.length) {
              turnFollowUps = search.related.filter(Boolean).slice(0, 3);
            }
            if (context) {
              messagesForModel.splice(messagesForModel.length - 1, 0, {
                role: 'system',
                content: [
                  `[USER ENABLED WEB SEARCH — QUERY: "${searchQuery}"]`,
                  context
                ].join('\n\n')
              });
            } else {
              // Search ran but produced nothing usable (dead fallback, bad key,
              // quota). Tell the model explicitly so it says "couldn't retrieve
              // live results" instead of inventing an answer or claiming the web
              // is empty.
              messagesForModel.splice(messagesForModel.length - 1, 0, {
                role: 'system',
                content: [
                  `[WEB SEARCH ATTEMPTED FOR "${searchQuery}" BUT RETURNED NO USABLE RESULTS${search?.error ? ` (reason: ${search.error})` : ''}.]`,
                  'Tell the user you could not retrieve live web results for this, then answer from your own knowledge while clearly flagging it may be out of date. Do NOT fabricate headlines, prices, scores, or dates.',
                ].join('\n')
              });
            }
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') throw err;
            // The `else` twelve lines up exists to stop the model inventing
            // headlines when a search comes back empty. Everything it prevents was
            // still reachable through here: both splices live *inside* the try,
            // after the await, so a thrown search added no note at all. The user
            // saw the Search toggle lit, the model was told nothing, and the answer
            // came out of training data reading exactly like a grounded one.
            //
            // Worse than the empty-result case it was written beside, not better —
            // that one at least left a trail. This swallowed the error without even
            // logging it.
            console.warn('[chat] web search failed; telling the model so', err);
            const reason = err instanceof Error ? err.message : String(err);
            messagesForModel.splice(messagesForModel.length - 1, 0, {
              role: 'system',
              // Deliberately the same sentence the empty-result branch sends. The
              // model does not need to distinguish "returned nothing" from "threw"
              // — the instruction is identical either way — and two wordings for
              // one situation is two sets of behaviour to keep in step.
              content: [
                `[WEB SEARCH ATTEMPTED FOR "${searchQuery}" BUT FAILED (reason: ${reason}).]`,
                'Tell the user you could not retrieve live web results for this, then answer from your own knowledge while clearly flagging it may be out of date. Do NOT fabricate headlines, prices, scores, or dates.',
              ].join('\n')
            });
          } finally {
            setIsSearching(false);
          }
        }

        // The Search toggle on the agent path. The model owns the query, so the
        // toggle becomes a requirement to call the tool rather than a pre-flight
        // search whose results would arrive before the model had read the turn.
        if (useAgent && forceWebSearch) {
          messagesForModel.splice(messagesForModel.length - 1, 0, {
            role: 'system',
            content: '[USER ENABLED WEB SEARCH] Call web_search before answering this turn, with a query you write yourself from the user\'s message. Ground the answer in what comes back and cite the sources.',
          });
        }

        const selectedModelMeta = AI_MODELS.find((model) => model.id === selectedModel) || AI_MODELS[0];
        // Arena mode is disabled for image generation requests
        const activeArenaMode = isArenaMode && !isImageGen;

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessage.id
              ? {
                  ...m,
                  sources: turnSources.length ? turnSources : undefined,
                  followUps: turnFollowUps.length ? turnFollowUps : undefined,
                  isArenaMode: activeArenaMode,
                  arenaResponses: activeArenaMode
                    ? compareModels.map(modelId => ({
                        modelId,
                        modelName: AI_MODELS.find(x => x.id === modelId)?.name || 'AI',
                        content: ''
                      }))
                    : undefined,
                }
              : m
          )
        );

        const runPrimary = async () => {
          let fullContent = '';
          const handleDelta = (delta: string) => {
            fullContent += delta;
            if (!receivedAssistantContent) {
              clearColdStartGuard();
              receivedAssistantContent = true;
            }
            // The cold-start guard is gone after the first token; the idle
            // watchdog takes over and resets on every chunk, so only a genuine
            // stall — not a model that is simply slow between tokens — trips it.
            armIdleWatchdog();
            const liveContent = sanitizeAssistantText(fullContent) || fullContent;
            runPrimaryPartialText = liveContent;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: liveContent } : m)),
            );
          };
          // Narration that preceded a tool call is not the answer — see
          // onDiscardPartial in lib/agent.ts. Clearing the buffer puts the
          // placeholder back so the real answer streams into an empty message.
          const discardStreamed = () => {
            fullContent = '';
            runPrimaryPartialText = '';
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: '' } : m)),
            );
          };

          if (hasImages && isVisionCapableModel(selectedModel)) {
            // The selected model can read the image itself, so answer in one hop.
            // The old two-hop path (vision engine → text-only synthesis) dropped
            // the image before the second call, so the model that actually wrote
            // the reply had never seen it and could only paraphrase.
            setStatusText(deepThink ? 'Thinking deeply...' : 'Analyzing image...');
            await generateChatResponse(
              messagesForModel,
              selectedModel,
              handleDelta,
              abortControllerRef.current!.signal,
              { deepThink },
            );
          } else if (hasImages) {
            // Step 1: Run Vision Engine (Mistral Pixtral 12B by default) to extract raw visual breakdown
            let rawVisionOutput = '';
            setStatusText('Running vision analysis...');
            await generateVisionResponse(
              messagesForModel,
              (delta) => { rawVisionOutput += delta; },
              abortControllerRef.current!.signal,
            );

            // Step 2: Pass raw vision output directly into Chat Model for final synthesis & refinement
            const refinedChatMessages: AiChatMessage[] = [
              {
                role: 'system',
                content: [
                  deepThink
                    ? buildFlyerThinkingPrompt(promptOpts)
                    : buildFlyerSystemPrompt(promptOpts),
                  '',
                  '=== INTERNAL VISION ENGINE ANALYSIS ===',
                  'Our internal vision engine analyzed the user\'s uploaded image(s)/file(s) and produced this detailed visual breakdown:',
                  '---',
                  rawVisionOutput,
                  '---',
                  '',
                  'TASK FOR FLYER:',
                  'Synthesize and refine the raw visual breakdown above. Address the user\'s specific request with maximum accuracy, clarity, structure, and depth. Provide the absolute best result as requested by the user, formatted cleanly with headers, bullet points, bold key terms, and code blocks where applicable.',
                ].join('\n'),
              },
              ...historyMessages,
              { role: 'user', content: requestContent },
            ];

            setStatusText(deepThink ? 'Thinking deeply...' : 'Synthesizing analysis...');
            await generateChatResponse(
              refinedChatMessages,
              selectedModel,
              handleDelta,
              abortControllerRef.current!.signal,
              { deepThink },
            );
          } else if (useAgent) {
            // The agent path. The model decides whether it needs to search,
            // render an image, or write a file, and this runs whatever it asks
            // for before it writes the answer.
            setStatusText(deepThink ? 'Thinking deeply...' : 'Generating response...');
            const run = await runAgentTurn({
              messages: messagesForModel,
              modelId: effectiveModelId,
              onChunk: handleDelta,
              signal: abortControllerRef.current!.signal,
              deepThink,
              // Tools that name an attachment resolve it against these.
              //
              // Documents carry metadata only: their text already reached the
              // model via buildDocumentContext, and edit_file never re-extracts.
              // Images additionally carry their data URL, because ocr_image has
              // no earlier extraction to reuse — an image has no text layer, so
              // reading it means sending the bytes. edit_file rejects an image id
              // rather than rewriting one.
              attachments: pendingAttachments
                .filter((a) => a.type === 'file' || a.type === 'image')
                .map((a) => ({
                  id: a.id,
                  name: a.name,
                  mimeType: a.mimeType,
                  ...(a.type === 'image' ? { url: a.url } : {}),
                })),
              onToolStart: ({ name, args }) => {
                // A tool call is proof of life just as much as a first token is:
                // the provider answered, it just answered with a call instead of
                // prose. Cancel the cold-start guard here rather than on tool end,
                // because one image generation can outlast the 130s budget by
                // itself and would otherwise be aborted mid-flight.
                clearColdStartGuard();
                // A tool is not a streamed token, so the idle watchdog must not
                // count the tool's runtime against the stream. An image gen that
                // takes 45s would else trip the 60s idle timer and abort the
                // turn mid-tool. handleDelta re-arms it when the model resumes.
                disarmIdleWatchdog();
                // The answer is not being written yet, so the status line has to
                // say what is actually happening — otherwise it reads
                // "Generating response" through a five-second search.
                if (name === 'web_search') {
                  const q = typeof args.query === 'string' ? args.query : '';
                  setIsSearching(true);
                  setStatusText(q ? `Searching for "${q}"...` : 'Searching the web...');
                } else if (name === 'generate_image') {
                  setStatusText('Generating image...');
                } else if (name === 'create_file') {
                  setStatusText('Creating file...');
                } else if (name === 'edit_file') {
                  setStatusText('Editing file...');
                } else if (name === 'run_code') {
                  // Not "Running Python" — the tool no longer runs anything, it
                  // stages a script for the user to run. Saying otherwise here
                  // would be the interface telling the same lie the prompt
                  // forbids the model from telling.
                  setStatusText('Writing Python...');
                } else if (name === 'ocr_image') {
                  setStatusText('Reading text from the image...');
                } else {
                  setStatusText('Working...');
                }
              },
              onToolEnd: ({ name }) => {
                if (name === 'web_search') setIsSearching(false);
                setStatusText(deepThink ? 'Thinking deeply...' : 'Generating response...');
              },
              onDiscardPartial: discardStreamed,
            });
            agentArtifacts = run.artifacts;
            if (run.hitStepLimit) {
              // Not surfaced to the user: the loop still forces a prose answer
              // from whatever it gathered, so the reply is complete, just
              // possibly less researched than the model intended.
              console.warn(`[agent] hit the ${MAX_STEPS}-step ceiling on ${effectiveModelId}`);
            }
          } else {
            setStatusText(deepThink ? 'Thinking deeply...' : 'Generating response...');
            await generateChatResponse(messagesForModel, effectiveModelId, handleDelta, abortControllerRef.current!.signal, { deepThink });
          }

          return sanitizeAssistantText(fullContent);
        };

        const secondaryPromises = activeArenaMode ? compareModels.map(async (modelId) => {
          let fullContent2 = '';
          await generateChatResponse(
            messagesForModel, 
            modelId,
            (delta) => {
              fullContent2 += delta;
              const liveContent2 = sanitizeAssistantText(fullContent2) || fullContent2;
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantMessage.id || !m.arenaResponses) return m;
                  return {
                    ...m,
                    arenaResponses: m.arenaResponses.map(ar => 
                      ar.modelId === modelId ? { ...ar, content: liveContent2 } : ar
                    )
                  };
                })
              );
            },
            abortControllerRef.current!.signal
          );
          return sanitizeAssistantText(fullContent2);
        }) : [];

        const [cleaned, ...secondaryResults] = await Promise.all([runPrimary(), ...secondaryPromises]);

        // What the tools produced, folded into the shapes the message already
        // renders. The classifier path fills turnSources/turnFollowUps before
        // the model runs; the agent path fills artifacts during it. Only one of
        // the two is ever populated, so this is a merge rather than a choice.
        const agentSources: MessageSource[] = (agentArtifacts.sources || [])
          .filter((r) => r.link)
          .slice(0, 8)
          .map((r) => ({ title: r.title || r.link, link: r.link, source: r.source }));
        const mergedSources = turnSources.length ? turnSources : agentSources;
        const mergedFollowUps = turnFollowUps.length ? turnFollowUps : (agentArtifacts.followUps || []);
        // First image only: the message carries one imageUrl, and a model that
        // rendered several has already described them in prose.
        const agentImageUrl = agentArtifacts.images?.[0];
        const agentFiles = agentArtifacts.files || [];
        objectUrlsRef.current.push(...agentFiles.map((f) => f.url));
        const agentCodeRuns = agentArtifacts.codeRuns || [];

        if (cleaned) {
          const finalText = usedVisionFallback
            ? `${cleaned}\n\n*🔎 Analyzed with ${AI_MODELS.find(m => m.id === DEFAULT_VISION_MODEL)?.name || 'a vision model'} since ${selectedModelMeta.name} can't read images.*`
            : cleaned;

          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantMessage.id) return m;
              return {
                ...m,
                content: finalText,
                imageUrl: agentImageUrl || m.imageUrl,
                files: agentFiles.length ? agentFiles : m.files,
                codeRuns: agentCodeRuns.length ? agentCodeRuns : m.codeRuns,
                sources: mergedSources.length ? mergedSources : undefined,
                followUps: mergedFollowUps.length ? mergedFollowUps : undefined,
                arenaResponses: activeArenaMode && m.arenaResponses
                  ? m.arenaResponses.map((ar, i) => ({ ...ar, content: secondaryResults[i] || ar.content }))
                  : undefined
              };
            })
          );

          // Surface substantial code blocks and any emitted files in the canvas.
          // Ingest is additive and dedupes by id, so a re-render streaming the
          // same final text just confirms the running set rather than polling it.
          ingestArtifacts(extractArtifacts(finalText, agentFiles, assistantMessage.id));

          if (convId && isAuthenticated) {
            // A file is a blob URL scoped to this tab and a matplotlib PNG is a
            // multi-megabyte data URL — neither belongs in a Firestore document,
            // so a reloaded conversation shows the reply without them.
            //
            // A *generated* image is different, and used to be lost for no
            // reason: generate_image returns a short, permanently-addressable
            // https URL (the endpoint sends `immutable`), and the loader already
            // recovers one from the text via extractFirstMarkdownImage. It was
            // dropped only because the tool's schema tells the model not to write
            // the link, so nothing put it in the text. Appending it here is what
            // the explicit Image-model path has always done, and it renders the
            // same: ChatMessage hoists the markdown image out of the prose with
            // stripMarkdownImages, so this adds nothing visible to the reply.
            await saveMessage(convId, 'assistant', withPersistedImage(finalText, agentImageUrl), selectedModelMeta.name, undefined, assistantMessage.parentMessageId, assistantMessage.id);
            maybeExtractMemories(finalText);
          }
        } else if (agentImageUrl || agentFiles.length) {
          // Tools delivered something the user can see even though the model
          // wrote no prose after them. Showing the artifact beats replacing it
          // with "formatting hiccup".
          const madeText = agentImageUrl ? 'Here you go.' : `Created ${agentFiles.map((f) => f.filename).join(', ')}.`;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMessage.id
              ? { ...m, content: madeText, imageUrl: agentImageUrl || m.imageUrl, files: agentFiles.length ? agentFiles : m.files, codeRuns: agentCodeRuns.length ? agentCodeRuns : m.codeRuns }
              : m)),
          );
          ingestArtifacts(extractArtifacts(madeText, agentFiles, assistantMessage.id));
          if (convId && isAuthenticated) {
            await saveMessage(convId, 'assistant', withPersistedImage(madeText, agentImageUrl), selectedModelMeta.name, undefined, assistantMessage.parentMessageId, assistantMessage.id);
            maybeExtractMemories(madeText);
          }
        } else {
          const fallback = 'I had a formatting hiccup—please send that once more 🙏';
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: fallback } : m)),
          );
        }
      }



      if (isAuthenticated) loadConversations();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        if (stalledMidStream) {
          // The stream started and then fell silent for STREAM_IDLE_TIMEOUT_MS.
          // Keep what was already streamed so the user keeps the partial answer,
          // and append a note that the connection died rather than leaving the
          // bubble looking done-but-incomplete with no explanation. Persisted
          // too: without a save the partial would be lost on reload, since the
          // success-path saveMessage is skipped on the abort.
          //
          // The fence is closed first, because a stream that dies mid-code-block
          // is the likely shape of this failure — long code is where the silence
          // falls — and an unterminated fence renders everything after it as code.
          // So the one sentence explaining why the answer stops mid-line was being
          // shown in monospace as the last line of the script, which is where a
          // reader is least likely to read it as an explanation of anything.
          const stallSuffix = '\n\n_The stream stalled partway through. Send it again if you want the rest._';
          const persistedPartial = withPersistedImage(
            closeUnterminatedFence((runPrimaryPartialText || '').replace(/\s*$/, '')) + stallSuffix,
            undefined,
          );
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessage.id ? { ...m, content: persistedPartial } : m,
            ),
          );
          if (convId && isAuthenticated) {
            await saveMessage(
              convId,
              'assistant',
              persistedPartial,
              selectedModelMeta.name,
              undefined,
              assistantMessage.parentMessageId,
              assistantMessage.id,
            );
            // No `.catch` here, deliberately, and it used to have one.
            // `saveMessage` catches its own failure, toasts it and returns false
            // (§14.2 #12) — so it cannot reject, and a `.catch` on it claimed to
            // handle a failure that could never arrive there. That is §14.2 #15's
            // shape in miniature: a handler a reader trusts, sitting off the
            // actual failure path. The boolean is discarded on purpose — the
            // partial is already on screen and the toast has already named the
            // consequence, and there is no better recovery available for a
            // connection that has just died.
          }
        } else if (timeoutReached && !receivedAssistantContent) {
          const timeoutMessage = 'That took too long on my side—please send it again and I’ll keep it short.';
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: timeoutMessage } : m)),
          );
        }
      } else {
        console.error('Chat error:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to send message');
        const errContent = 'Oops, something went wrong. Please try again!';
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: errContent } : m)),
        );
      }
    } finally {
      clearTimeout(timeoutId);
      disarmIdleWatchdog();
      setIsLoading(false);
      setStatusText('');
      setIsSearching(false);
      abortControllerRef.current = null;
    }
  };

  const handleStopGeneration = () => { abortControllerRef.current?.abort(); };
  const handleNewConversation = () => {
    if (isLoading) {
      handleStopGeneration();
      setIsLoading(false);
      setStatusText('');
      setIsSearching(false);
    }
    setActiveConversationId(null);
    setMessages([]);
    revokeObjectUrls();
    if (window.innerWidth < 1024) setSidebarCollapsed(true);
  };

  // ---- keyboard accelerators (task #14, item 8) --------------------------
  // The table of chords is src/lib/shortcuts.ts; only the actions live here,
  // because they need state this component owns.
  const [showShortcuts, setShowShortcuts] = useState(false);

  /**
   * Find the composer, focus it, and hand it back.
   *
   * Queried from the DOM rather than held as a ref threaded down into ChatInput.
   * The composer is unmounted entirely in some states (arena mode, and while the
   * conversation list is still loading), so a ref would be null exactly as often
   * and would additionally require ChatInput to accept and forward one. The
   * selector is a `data-` attribute placed for this purpose, not a class or an
   * aria-label that someone could reasonably rename.
   *
   * Returns the element so the type-to-focus path in the hook can tell "no
   * composer on screen" from "focused it" and leave the keystroke alone in the
   * first case.
   */
  const focusComposer = useCallback((): HTMLElement | null => {
    const el = document.querySelector<HTMLTextAreaElement>('textarea[data-flyer-composer]');
    if (!el || el.disabled) return null;
    el.focus();
    return el;
  }, []);

  /**
   * mod+K — put the cursor in the sidebar's history filter.
   *
   * Three wrinkles, all worth the comment.
   *
   * The sidebar is never unmounted: collapsed means `width: 0` plus a -280px
   * translate on an `overflow-hidden` aside, so the field is in the DOM the whole
   * time and querySelector finds it even while it is invisible. That is why this
   * can expand and focus without threading a ref down — but it is also why
   * `preventScroll` is needed. Focusing an element that is currently off to the
   * left of the viewport otherwise invites the browser to scroll an ancestor to
   * reveal it, and the ancestor here is the app shell.
   *
   * The focus is deferred by one frame, and that is load-bearing. A collapsed
   * panel is `visibility: hidden` (ChatSidebar's `offscreen`, which is what keeps
   * a closed drawer out of the tab order), and `.focus()` on a
   * `visibility: hidden` element silently does nothing. React has not committed
   * the expand by the time this handler returns, so focusing here would expand the
   * sidebar and leave the cursor where it was — a shortcut that half-works, which
   * is worse than one that does not, because the failure is invisible.
   *
   * The field only renders once there is history to filter, so an empty account
   * finds nothing. Expanding anyway is the honest response — it shows the user the
   * empty list, which is the answer to "search my chats" — and the toast explains
   * why the cursor did not land anywhere, following the same reasoning as the
   * artifact-canvas shortcut below.
   */
  const focusHistorySearch = useCallback(() => {
    setSidebarCollapsed(false);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>('input[data-flyer-history-search]');
      if (!el) {
        toast(UNAVAILABLE_REASONS['find-conversation']);
        return;
      }
      el.focus({ preventScroll: true });
      // Select rather than append: pressing the chord again is how you start a
      // different search, and a cursor parked after the old query means the second
      // attempt silently searches for both.
      el.select();
    });
  }, []);

  useKeyboardShortcuts({
    // While the shortcuts sheet is open, Radix's dialog owns the keyboard: it
    // traps focus and handles Escape itself. Leaving this layer armed would mean
    // Ctrl+B toggling a sidebar the user cannot see behind the modal.
    disabled: showShortcuts,
    handlers: {
      'new-chat': handleNewConversation,
      // Guarded, not silent. `ChatSidebar` is behind `isAuthenticated &&` further
      // down, so for a guest this boolean has no reader: the pre-fix handler
      // flipped it and the app did not move, while the help sheet went on
      // promising "Show or hide conversations" (§14.2 #20).
      'toggle-sidebar': () => {
        if (!isAuthenticated) {
          toast(UNAVAILABLE_REASONS['toggle-sidebar']);
          return;
        }
        setSidebarCollapsed((v) => !v);
      },
      'show-shortcuts': () => setShowShortcuts(true),
      'focus-composer': () => focusComposer(),
      'find-conversation': focusHistorySearch,
      'toggle-artifact-canvas': () => {
        if (openArtifactId) {
          closeArtifact();
        } else if (readArtifactState().artifacts.length > 0) {
          openFirstArtifact();
        } else {
          // Silence here would read as a broken shortcut. The canvas only has
          // content once a reply has produced a file or a code block, and that is
          // not guessable from the outside.
          toast(UNAVAILABLE_REASONS['toggle-artifact-canvas']);
        }
      },
      // Precedence, most-urgent first. Stopping a run is what the user almost
      // certainly means if one is in flight; only once nothing is generating does
      // Escape start closing things, and the sidebar comes last because on
      // desktop it is docked and closing it on Escape would be surprising.
      escape: () => {
        if (isLoading) {
          handleStopGeneration();
          return;
        }
        if (openArtifactId) {
          closeArtifact();
          return;
        }
        if (!sidebarCollapsed && window.innerWidth < 1024) setSidebarCollapsed(true);
      },
    },
    focusComposerOnType: focusComposer,
  });

  // Regenerate: strip the last user+assistant turn, then resend the user's text.
  // Uses an effect so handleSendMessage runs against the trimmed message state.
  const [regenText, setRegenText] = useState<string | null>(null);
  const handleRegenerate = () => {
    if (isLoading) return;
    const lastUserIdx = [...messages].map((m) => m.role).lastIndexOf('user');
    if (lastUserIdx === -1) return;
    const lastUserText = messages[lastUserIdx].content;
    setMessages((prev) => prev.slice(0, lastUserIdx));
    setRegenText(lastUserText || ' ');
  };

  useEffect(() => {
    if (regenText !== null && !isLoading) {
      const text = regenText;
      // Keep regenText set (as an in-flight flag) until handleSendMessage has
      // appended the new user + assistant placeholders, so the empty message
      // list never falls through to the WelcomeScreen ("homepage") mid-retry.
      handleSendMessage(text).finally(() => setRegenText(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenText]);

  // ── Branching (Part F) ──
  //
  // Switching branches is a pure reshape of the in-memory forest: the data
  // hasn't changed, only which sibling of a given parent is the visible one.
  // We mutate the forest ref (only the activeChildIndex of the parent node)
  // and re-linearize. No DB round-trip — the whole tree is already loaded.
  const handleSwitchBranch = useCallback((parentMessageId: string | null | undefined, direction: 'prev' | 'next') => {
    if (!parentMessageId || messageForestRef.current.length === 0) return;
    const next = switchBranch(messageForestRef.current, parentMessageId, direction);
    setMessages(next as Message[]);
  }, []);

  // Editing a user message creates a NEW branch: we truncate the visible path
  // back to just before the edited message, then resend the EDITED text. The
  // resend runs through the same handleSendMessage, whose parent computation
  // settles on exactly the edited message's original parent (the last assistant
  // message before it) — so the new user message is a SIBLING of the original
  // under that parent, not an in-place mutation. The old wording is preserved
  // in the DB and reachable via the branch switcher after the conversation is
  // reloaded (see buildMessageForest in message-tree.ts). Reusing the regen
  // effect's "deferred send" avoids racing the state truncation with the read.
  const handleEditMessage = useCallback((messageId: string, newContent: string) => {
    if (isLoading) return;
    const trimmed = newContent.trim();
    if (!trimmed) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    setMessages((prev) => prev.slice(0, idx));
    // setRegenText arms the regen effect (handleRegenerate uses the same flag),
    // which calls handleSendMessage(trimmed) once the truncated state is committed.
    setRegenText(trimmed);
  }, [isLoading, messages]);

  const handleDeleteConversation = async (id: string) => {
    try {
      await firestoreDb.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeConversationId === id) { setActiveConversationId(null); setMessages([]); }
      toast.success('Conversation deleted');
    } catch {
      toast.error('Failed to delete conversation');
    }
  };

  /**
   * Rename a conversation from the sidebar's context menu (or F2 on the row).
   *
   * Optimistic: the list updates before the write lands, and rolls back if it
   * fails. Renaming is a zero-risk, high-frequency edit — waiting on a network
   * round-trip to see your own typing is what makes an app feel like a website.
   *
   * The rollback captures the previous title rather than refetching, because a
   * refetch on failure is a second thing that can fail, and the state it would
   * restore is already in hand.
   */
  const handleRenameConversation = async (id: string, title: string) => {
    const previous = conversations.find((c) => c.id === id)?.title;
    if (previous === undefined) return;

    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      await firestoreDb.updateConversationTitle(id, title);
    } catch {
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: previous } : c)));
      toast.error('Could not rename this conversation');
    }
  };

  const selectedModelMeta = AI_MODELS.find((model) => model.id === selectedModel) || AI_MODELS[0];

  return (
    <div 
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className="app-shell-height safe-area-inset-top safe-area-inset-x flex w-full bg-background overflow-hidden liquid-app relative"
    >
      {/* Full screen Drag and Drop Overlay */}
      <AnimatePresence>
        {isDraggingOver && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/85 backdrop-blur-2xl border-4 border-dashed border-primary/70 p-6 pointer-events-none shadow-[0_0_80px_hsla(var(--primary)/0.3)]"
          >
            <div className="w-20 h-20 rounded-3xl bg-primary/20 border border-primary/40 flex items-center justify-center shadow-2xl shadow-primary/30 mb-4 animate-bounce">
              <Sparkles className="w-10 h-10 text-primary" />
            </div>
            <h3 className="text-2xl font-bold bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent mb-2">
              Drop Files to Analyze
            </h3>
            <p className="text-sm text-muted-foreground max-w-md text-center">
              Release image or document files anywhere to attach and send to Flyer AI.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {isAuthenticated && (
        <ChatSidebar
          conversations={conversations}
          conversationsStatus={conversationsStatus}
          onRetryConversations={loadConversations}
          activeConversationId={activeConversationId}
          onSelectConversation={(id) => {
            if (isLoading) {
              handleStopGeneration();
              setIsLoading(false);
              setStatusText('');
              setIsSearching(false);
            }
            setActiveConversationId(id);
            if (window.innerWidth < 1024) setSidebarCollapsed(true);
          }}
          onNewConversation={handleNewConversation}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameConversation}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          selectedModel={selectedModel}
          onSelectModel={handleSelectModel}
          onMemoriesChanged={reloadMemories}
          onInstructionsChanged={reloadInstructions}
        />
      )}

      <main className="flex-1 flex flex-col h-full relative w-full min-w-0">
        <div className="pointer-events-none absolute inset-0 overflow-hidden liquid-canvas">
          <div className="absolute inset-0 liquid-sheen" />
          <div className="absolute inset-0 liquid-grid opacity-45" />
        </div>

        {/* Header */}
        <header style={canvasGutter} className={`h-14 sm:h-16 liquid-header flex items-center px-3 sm:px-4 gap-3 sm:gap-4 relative z-20 flex-shrink-0 ${canvasGutterClass}`}>
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/[0.02] to-transparent pointer-events-none" />

          {isAuthenticated && (
            <motion.button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="relative p-2.5 rounded-xl bg-secondary/40 hover:bg-secondary/70 border border-border/30 transition-all duration-200 group"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Menu className="w-5 h-5 text-foreground/70 group-hover:text-foreground transition-colors" />
            </motion.button>
          )}
          
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {/* `whileHover={{ scale: 1.1, rotate: 5 }}` came off this. A 10% jump
                plus a 5-degree tilt on the app's own logo in the header is a web
                flourish — the same `rotate: 5` was removed from the WelcomeScreen
                tile for the same reason. This is also not a button: it has no
                onClick, so it was offering feedback for an interaction that does
                not exist, which is worse than overdoing it. Now a plain element. */}
            <div className="flex w-10 h-10 rounded-xl items-center justify-center flex-shrink-0 bg-black/10 overflow-hidden">
              <img src={LOGO_URL} alt="Flyer AI" className="w-full h-full object-cover" />
            </div>
            <div className="min-w-0">
              <h1 className="font-display font-semibold text-base sm:text-lg truncate text-foreground/90">
                {activeConversationId ? conversations.find((c) => c.id === activeConversationId)?.title || 'Chat' : 'Flyer'}
              </h1>
              {!isGuest && (
                <span className="text-xs text-muted-foreground/70 truncate block">{selectedModelMeta?.name || 'Default'} · {selectedModelMeta?.kind || 'Chat'}</span>
              )}
              {isGuest && (
                /* `<Link>`, not `<a href="/auth">`. The raw anchor was a genuine
                   break in the desktop build rather than a style preference: a
                   plain href does a full document navigation, so under file:// it
                   resolved to `file:///auth`, which does not exist. That fails the
                   main frame, and main.cjs's did-fail-load handler turns a
                   main-frame failure into a modal "Flyer could not start" error box
                   — so a guest clicking "Sign in to save chats" in the packaged app
                   got an error dialog and a dead window, with no way back.

                   It was also already wrong on the web: a full navigation there
                   throws away the React tree and re-runs the whole Firebase auth
                   bootstrap to reach a route the router could have rendered in
                   place. `<Link>` goes through the router, which is what makes it
                   correct under HashRouter (`#/auth`) and BrowserRouter alike. */
                <span className="text-xs text-muted-foreground/60">Guest mode • <Link to="/auth" className="text-primary hover:underline">Sign in to save chats</Link></span>
              )}
            </div>
          </div>

          <div className="relative flex items-center gap-3 flex-shrink-0">
            {/* Arena Mode Toggle — desktop only; it needs side-by-side width to
                be usable, and the model pickers it spawns overflow on mobile. */}
            <div className="hidden md:flex items-center gap-1.5 bg-secondary/40 border border-border/30 rounded-xl p-1 backdrop-blur-md">
              <button
                onClick={() => setIsArenaMode(!isArenaMode)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-300 ${
                  isArenaMode
                    ? 'bg-gradient-to-r from-primary/25 via-accent/20 to-primary/25 text-primary border border-primary/40 shadow-[0_0_16px_hsla(var(--primary)/0.35)]'
                    : 'hover:bg-secondary/80 text-foreground/70'
                }`}
                title="AI Arena: Compare models side-by-side"
              >
                <span className="text-sm">⚔️</span>
                <span>ARENA MODE</span>
                {isArenaMode && (
                  <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                )}
              </button>
            </div>

            {/* Model pickers — desktop only. On mobile the sidebar's model list
                is the way in, so the header stays uncluttered. */}
            <div className="hidden md:flex items-center gap-2">
              <ModelSelector selectedModel={selectedModel} onSelectModel={handleSelectModel} />
              <AnimatePresence>
                {isArenaMode && compareModels.map((mId, idx) => (
                  <motion.div key={`compare-${idx}`} initial={{ opacity: 0, width: 0, scale: 0.8 }} animate={{ opacity: 1, width: 'auto', scale: 1 }} exit={{ opacity: 0, width: 0, scale: 0.8 }} transition={{ duration: 0.3 }} className="flex items-center gap-2 overflow-hidden">
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-gradient-to-r from-primary/20 via-accent/20 to-primary/20 text-primary border border-primary/30 shadow-sm flex-shrink-0">VS</span>
                    <ModelSelector 
                      selectedModel={mId} 
                      onSelectModel={(newId) => {
                        const newModels = [...compareModels];
                        newModels[idx] = newId;
                        setCompareModels(newModels);
                      }} 
                    />
                    <button 
                      onClick={() => setCompareModels(prev => prev.filter((_, i) => i !== idx))}
                      className="w-5 h-5 rounded-full bg-secondary/50 flex items-center justify-center text-muted-foreground hover:bg-destructive hover:text-destructive-foreground transition-all flex-shrink-0"
                      title="Remove model"
                    >
                      <span className="text-xs leading-none">×</span>
                    </button>
                  </motion.div>
                ))}
                {isArenaMode && compareModels.length < 4 && (
                  <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="flex-shrink-0 ml-1">
                    <button
                      onClick={() => setCompareModels(prev => [...prev, 'llama-8b'])}
                      className="w-7 h-7 rounded-xl border border-dashed border-border hover:border-primary/50 text-muted-foreground hover:text-primary transition-colors flex items-center justify-center"
                      title="Add another model"
                    >
                      <span className="text-lg leading-none">+</span>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>

        {/* Messages */}
        {/* touch-scroll-y replaces the old inline overscrollBehavior:'none': it
            keeps scroll from chaining to the document while re-enabling iOS
            momentum, which the document-level -webkit-overflow-scrolling reset
            had killed for this region too. */}
        <div ref={scrollContainerRef} style={canvasGutter} className={`relative z-10 flex-1 min-h-0 touch-scroll-y ${canvasGutterClass}`}>
          <AnimatePresence mode="wait">
            {isMessagesLoading ? (
              <div key="loading-messages" className="flex flex-col items-center justify-center h-full min-h-[50dvh] overflow-y-auto scrollbar-thin">
                <div className="flex gap-1.5 justify-center items-center">
                  {[0, 0.2, 0.4].map((d, i) => (
                    <motion.span
                      key={i}
                      className="w-3 h-3 rounded-full bg-primary"
                      animate={{ scale: [1, 1.4, 1], opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 1, repeat: Infinity, delay: d }}
                    />
                  ))}
                </div>
                <span className="text-xs text-primary/80 font-medium mt-3">Loading messages...</span>
              </div>
            ) : messagesError ? (
              /* Checked before the welcome branch, which is the entire point: a
                 failed read leaves `messages` empty, so without this the next
                 branch matches and the user is shown a greeting for a conversation
                 that has history. See the messagesError declaration for why that
                 is worse than an ordinary undesigned error state. */
              <div
                key="messages-error"
                role="alert"
                className="flex flex-col items-center justify-center h-full min-h-[50dvh] px-6 text-center"
              >
                {/* Amber rather than red, matching the sidebar's failure state:
                    nothing has been lost, the read just did not arrive. */}
                <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4">
                  <AlertTriangle className="w-6 h-6 text-amber-400/80" />
                </div>
                <h3 className="text-base font-semibold text-foreground/80">
                  Couldn&apos;t load this conversation
                </h3>
                <p className="text-sm text-muted-foreground mt-1.5 max-w-sm">
                  Your messages are still saved — the app just couldn&apos;t reach them.
                  Check your connection and try again.
                </p>
                <Button variant="outline" size="sm" onClick={loadMessages} className="mt-5 gap-1.5">
                  <RotateCw className="w-4 h-4" />
                  Retry
                </Button>
                {/* Retry only — no "start a new chat" link. The composer below is
                    disabled while this state is showing (see the `disabled` prop on
                    ChatInput), so the one action offered here is the one that can
                    actually resolve it. */}
              </div>
            ) : (messages.length === 0 && regenText === null) ? (
              <div key="welcome" className="h-full overflow-y-auto scrollbar-thin">
                <WelcomeScreen onSuggestionClick={handleSendMessage} modelName={selectedModelMeta?.name || 'AI'} />
              </div>
            ) : (
              <motion.div key="messages" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full transition-all duration-300">
                {/* react-virtuoso: only the visible message rows are mounted, so a
                    500-message thread no longer re-renders off-screen markdown every
                    keystroke of streaming. followOutput keeps the view pinned to the
                    tail while at the bottom; atBottomStateChange drives the
                    jump-to-latest button (replacing the old onScroll math). */}
                <Virtuoso
                  ref={virtuosoRef}
                  data={messages}
                  className="h-full scrollbar-thin"
                  followOutput={(isAtBottom) => {
                    // Respect hasSentThisSessionRef: don't snap to bottom on
                    // initial history load before the user has sent. Once they
                    // have, keep the tail in view while pinned.
                    if (!hasSentThisSessionRef.current) return false;
                    return isAtBottom ? 'auto' : false;
                  }}
                  atBottomStateChange={(atBottom) => {
                    isPinnedToBottomRef.current = atBottom;
                    // Mirror the old 240px gate: hide the jump button while near
                    // bottom, show it once there's meaningful distance above.
                    setShowScrollToBottom(!atBottom);
                  }}
                  atTopStateChange={() => {
                    // No-op: leaving the surface for future "load older" hooks.
                  }}
                  increaseViewportBy={{ top: 400, bottom: 400 }}
                  computeItemKey={(_index, msg) => msg.id}
                  itemContent={(index, msg) => (
                    <div className={`${isArenaMode ? 'max-w-full px-2' : 'max-w-4xl px-3 sm:px-4 lg:px-6'} mx-auto py-4 sm:py-6 lg:py-8`}>
                      {/* Each row owns its own vertical rhythm instead of the old
                          gap-y on a flex parent: Virtuoso lays items flush, so the
                          spacing must live inside each rendered row. */}
                      <div className="pt-3 sm:pt-4 first:pt-0 last:pb-0">
                        <ChatMessage
                          role={msg.role}
                          content={msg.content}
                          imageUrl={msg.imageUrl}
                          attachments={msg.attachments}
                          isStreaming={isLoading && msg.role === 'assistant' && index === messages.length - 1}
                          modelName={msg.modelName || 'AI'}
                          statusText={isLoading && msg.role === 'assistant' && index === messages.length - 1 ? statusText : undefined}
                          sources={msg.sources}
                          followUps={msg.followUps}
                          files={msg.files}
                          codeRuns={msg.codeRuns}
                          onFollowUp={(q) => handleSendMessage(q)}
                          onRegenerate={handleRegenerate}
                          canRegenerate={msg.role === 'assistant' && index === messages.length - 1 && !isLoading}
                          isArenaMode={msg.isArenaMode}
                          arenaResponses={msg.arenaResponses}
                          branchIndex={msg.__branchIndex}
                          branchCount={msg.__branchCount}
                          onSwitchBranch={(dir) => handleSwitchBranch(msg.parentMessageId, dir)}
                          canEdit={msg.role === 'user' && !isLoading}
                          onEdit={(text) => handleEditMessage(msg.id, text)}
                        />
                      </div>
                    </div>
                  )}
                  components={{
                    // A trailing spacer so the last message isn't flush against the
                    // composer. Replaces the old messagesEndRef h-4 sentinel.
                    Footer: () => <div className="h-4" />,
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Input. The composer reserves the canvas width like the rest of the
            column rather than being lifted above the panel: overlapping it kept
            typing possible but drew the composer bar straight across the bottom
            of the artefact, which reads as a rendering fault. z-40 still stacks
            it above the message list. */}
        <div style={canvasGutter} className={`relative z-40 flex-shrink-0 ${canvasGutterClass}`}>
          {/* Jump-to-latest. Anchored to the composer so it sits clear of the
              home indicator on mobile, and only mounts once there is a real
              distance to travel — see the 240px gate in handleScroll. */}
          <AnimatePresence>
            {showScrollToBottom && (
              <motion.button
                type="button"
                onClick={() => scrollToBottom('smooth')}
                initial={{ opacity: 0, y: 8, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.9 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                aria-label="Scroll to latest message"
                className="absolute -top-12 left-1/2 -translate-x-1/2 z-30 w-10 h-10 rounded-full bg-secondary/90 backdrop-blur-md border border-border shadow-lg flex items-center justify-center text-foreground/80 hover:text-foreground hover:bg-secondary transition-colors"
              >
                <ArrowDown className="w-4 h-4" />
              </motion.button>
            )}
          </AnimatePresence>
          <ChatInput
            onSend={handleSendMessage}
            isLoading={isLoading}
            onStop={handleStopGeneration}
            /* Sending is blocked while the history read is failed, and this is the
               half of the fix that matters. The error state above stops the app
               *claiming* the conversation is empty; this stops it acting as if it
               were. `messages` is empty in this state, so a send would reach the
               model with no prior turns — it would answer a follow-up question as
               if it were the first thing ever said, and then that answer would be
               persisted into the middle of a thread it never saw. A disabled
               composer next to a Retry button is the honest pair. */
            disabled={messagesError}
            modelName={selectedModelMeta?.name || 'AI'}
            modelKind={selectedModelMeta?.kind || 'Chat'}
            deepThink={deepThink}
            onToggleDeepThink={() => setDeepThink((v) => !v)}
            webSearch={forceWebSearch}
            onToggleWebSearch={() => setForceWebSearch((v) => !v)}
          />
        </div>

        {/* Artifact canvas — overlays the right edge of <main> when an artifact
            is open; nothing rendered otherwise, so Arena mode keeps full width. */}
        <ArtifactCanvas
          // The message id rides along because a file artifact's id is its
          // filename alone, so two turns generating `report.xlsx` are two
          // versions of one artifact and the canvas cannot otherwise tell which
          // version's bytes to serve (§14.2 #18).
          filesForTurn={messages.flatMap((m) =>
            (m.files ?? []).map((f) => ({ ...f, messageId: m.id })),
          )}
          onEdit={(text) => {
            // Feed the artefact back into the chat as context for the next turn:
            // we wrap it and ask the model to treat it as the prior version, so
            // "edit this" becomes a follow-up the model can act on directly.
            const fenced = "```\n" + text + "\n```";
            handleSendMessage(`Here's the current version — make the changes I describe:\n${fenced}`);
          }}
        />
      </main>

      {/* Rendered here, outside <main>, because Radix portals it to <body> anyway
          and putting it inside a flex child that owns the canvas gutter invites
          someone to "fix" its width later. */}
      <ShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />
    </div>
  );
}

