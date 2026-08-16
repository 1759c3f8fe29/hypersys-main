import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
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
import ChatInput, { ACCENT_COLORS } from '@/components/chat/ChatInput';
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
import { extractDocument, canExtract, buildDocumentContext } from '@/lib/documents';
import { extractArtifacts } from '@/lib/artifacts';
import { ingestArtifacts, resetArtifacts, openArtifact, useArtifacts } from '@/components/artifacts/ArtifactProvider';
import { ArtifactCanvas } from '@/components/artifacts/ArtifactCanvas';
import type { ChatAttachment, MessageFile, MessageSource } from '@/components/chat/types';
import { Menu, ArrowDown, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { extractFirstMarkdownImage, sanitizeAssistantText } from '@/lib/chat-format';
import { buildMessageForest, linearizeForest, switchBranch } from '@/lib/message-tree';

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
const DEFAULT_VISION_MODEL = VISION_ENGINE_MODEL;

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
  // openId drives the desktop right-padding on the messages column so the
  // overlay canvas never hides message text. The canvas hides itself below md.
  const { openId: openArtifactId } = useArtifacts();
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('Flyer_theme_color') || '172 66% 50%');

  useEffect(() => {
    localStorage.setItem('Flyer_theme_color', accentColor);
    document.documentElement.style.setProperty('--primary', accentColor);
    document.documentElement.style.setProperty('--ring', accentColor);
    document.documentElement.style.setProperty('--accent', accentColor);
    document.documentElement.style.setProperty('--sidebar-primary', accentColor);
  }, [accentColor]);

  const [conversations, setConversations] = useState<Conversation[]>([]);
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
  const messageForestRef = useRef<any[]>([]);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  // Explicit user overrides for the automatic intent classifier. DeepThink
  // forces extended step-by-step reasoning; forceWebSearch always grounds the
  // turn in live results instead of letting the classifier decide.
  const [deepThink, setDeepThink] = useState(false);
  const [forceWebSearch, setForceWebSearch] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
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
    if (!user) return;
    const data = await firestoreDb.getConversations(user.uid);
    setConversations(data.map(c => ({
      id: c.id,
      title: c.title,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      modelId: c.modelId
    })) || []);
  }, [user]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

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

  const loadMessages = useCallback(async () => {
    // Opening or switching a conversation disarms autoscroll so the freshly
    // loaded history renders from its natural position instead of snapping to
    // the bottom. Re-armed the moment the user sends in this conversation.
    hasSentThisSessionRef.current = false;
    isPinnedToBottomRef.current = true;
    setShowScrollToBottom(false);
    if (!activeConversationId) { setMessages([]); revokeObjectUrls(); return; }
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
      const forest = buildMessageForest(data.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        imageUrl: m.role === 'assistant' ? extractFirstMarkdownImage(m.content) : undefined,
        attachments: m.attachments,
        modelName: m.modelName,
        parentMessageId: m.parentMessageId ?? null,
        siblingIndex: m.siblingIndex ?? 0,
      })));
      messageForestRef.current = forest;
      setMessages(linearizeForest(forest) as Message[]);
    } catch (e) {
      console.error("Failed to load messages:", e);
    } finally {
      setIsMessagesLoading(false);
    }
  }, [activeConversationId]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

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
    parentMessageId?: string | null
  ) => {
    if (!user) return;
    try {
      await firestoreDb.saveMessage(conversationId, user.uid, role, content, modelName, attachments, parentMessageId);
    } catch (e) {
      console.error("Error saving message:", e);
    }
  };

  const handleSendMessage = async (content: string, files: File[] = []) => {
    if ((!content.trim() && files.length === 0) || isLoading) return;

    createSparkleBurst();

    const trimmedContent = content.trim();
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
    const documentFiles = files.filter((f) => !f.type.startsWith('image/') && canExtract(f));
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
    // the loop does not cover (no tool support, image understanding, Arena mode)
    // that means no search unless the toggle is on: those models cannot call the
    // tool themselves, so the toggle is the only grounding they get.
    const isImageGen = isImageModel(selectedModel);

    const useAgent =
      AGENT_TOOLS_ENABLED &&
      !hasImages &&
      !isArenaMode &&
      !isImageGen &&
      supportsTools(selectedModel);

    let effectiveModelId = selectedModel;
    if (!isImageGen && hasImages && !isVisionCapableModel(selectedModel)) {
      effectiveModelId = DEFAULT_VISION_MODEL;
    }
    const usedVisionFallback = effectiveModelId !== selectedModel;

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
    const isAuthenticated = !!user && !isGuest;

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
          firestoreDb.updateConversationTitle(currentConvId, smartTitle).catch(() => {});
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
        userMessage.parentMessageId
      );
    }

    setStatusText('Preparing response...');
    setIsLoading(true);
    abortControllerRef.current = new AbortController();

    const timeoutMs = isImageGen
      ? SLOW_REQUEST_TIMEOUT_MS
      : REQUEST_TIMEOUT_MS;

    let timeoutReached = false;
    let receivedAssistantContent = false;
    const timeoutId = setTimeout(() => {
      timeoutReached = true;
      abortControllerRef.current?.abort();
    }, timeoutMs);
    // Once the first token arrives the model is alive and streaming — cancel the
    // cold-start guard so a long-but-healthy answer is never cut off mid-stream.
    const clearColdStartGuard = () => clearTimeout(timeoutId);

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
          await saveMessage(convId, 'assistant', imageContent, selectedModelMeta.name, undefined, assistantMessage.parentMessageId);
        }
      } else {
        let fullContent = '';

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
            if (!receivedAssistantContent) clearColdStartGuard();
            receivedAssistantContent = true;
            const liveContent = sanitizeAssistantText(fullContent) || fullContent;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: liveContent } : m)),
            );
          };
          // Narration that preceded a tool call is not the answer — see
          // onDiscardPartial in lib/agent.ts. Clearing the buffer puts the
          // placeholder back so the real answer streams into an empty message.
          const discardStreamed = () => {
            fullContent = '';
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
              // edit_file resolves its attachment_id against these. Metadata only
              // — the file's text already reached the model via buildDocumentContext,
              // and edit_file never re-extracts. Non-image attachments only: image
              // attaches never carry a text attachment_id.
              attachments: pendingAttachments
                .filter((a) => a.type === 'file')
                .map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType })),
              onToolStart: ({ name, args }) => {
                // A tool call is proof of life just as much as a first token is:
                // the provider answered, it just answered with a call instead of
                // prose. Cancel the cold-start guard here rather than on tool end,
                // because one image generation can outlast the 130s budget by
                // itself and would otherwise be aborted mid-flight.
                clearColdStartGuard();
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
            // Only the text is persisted. A generated image is a data URL and a
            // file is a blob URL scoped to this tab — both are far too large or
            // too short-lived for a Firestore document, so a reloaded
            // conversation shows the reply without them.
            await saveMessage(convId, 'assistant', finalText, selectedModelMeta.name, undefined, assistantMessage.parentMessageId);
          }
        } else if (agentImageUrl || agentFiles.length) {
          // Tools delivered something the user can see even though the model
          // wrote no prose after them. Showing the artifact beats replacing it
          // with "formatting hiccup".
          const madeText = agentImageUrl ? 'Here you go.' : `Created ${agentFiles.map((f) => f.filename).join(', ')}.`;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMessage.id
              ? { ...m, content: madeText, imageUrl: agentImageUrl || m.imageUrl, files: agentFiles.length ? agentFiles : m.files }
              : m)),
          );
          ingestArtifacts(extractArtifacts(madeText, agentFiles, assistantMessage.id));
          if (convId && isAuthenticated) {
            await saveMessage(convId, 'assistant', madeText, selectedModelMeta.name, undefined, assistantMessage.parentMessageId);
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
        if (timeoutReached && !receivedAssistantContent) {
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

  const isAuthenticated = !!user && !isGuest;
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
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          selectedModel={selectedModel}
          onSelectModel={handleSelectModel}
        />
      )}

      <main className="flex-1 flex flex-col h-full relative w-full min-w-0">
        <div className="pointer-events-none absolute inset-0 overflow-hidden liquid-canvas">
          <div className="absolute inset-0 liquid-sheen" />
          <div className="absolute inset-0 liquid-grid opacity-45" />
        </div>

        {/* Header */}
        <header className="h-14 sm:h-16 liquid-header flex items-center px-3 sm:px-4 gap-3 sm:gap-4 relative z-20 flex-shrink-0">
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
            <motion.div className="flex w-10 h-10 rounded-xl items-center justify-center flex-shrink-0 bg-black/10 overflow-hidden" whileHover={{ scale: 1.1, rotate: 5 }}>
              <img src="/flyer-logo.png" alt="Flyer AI" className="w-full h-full object-cover" />
            </motion.div>
            <div className="min-w-0">
              <h1 className="font-display font-semibold text-base sm:text-lg truncate text-foreground/90">
                {activeConversationId ? conversations.find((c) => c.id === activeConversationId)?.title || 'Chat' : 'Flyer'}
              </h1>
              {!isGuest && (
                <span className="text-xs text-muted-foreground/70 truncate block">{selectedModelMeta?.name || 'Default'} · {selectedModelMeta?.kind || 'Chat'}</span>
              )}
              {isGuest && (
                <span className="text-xs text-muted-foreground/60">Guest mode • <a href="/auth" className="text-primary hover:underline">Sign in to save chats</a></span>
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

            {/* Accent Color Switcher */}
            <div className="hidden sm:flex items-center gap-1.5 bg-secondary/40 border border-border/30 rounded-xl p-1.5 backdrop-blur-md">
              {ACCENT_COLORS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setAccentColor(c.value)}
                  className={`w-3.5 h-3.5 rounded-full transition-all duration-200 hover:scale-125 ${c.bg} ${accentColor === c.value ? 'ring-2 ring-white scale-110 shadow-md shadow-white/30' : 'opacity-55 hover:opacity-100'}`}
                  title={`${c.name} Accent`}
                  aria-label={`Change accent color to ${c.name}`}
                />
              ))}
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
        <div ref={scrollContainerRef} className="relative z-10 flex-1 min-h-0 touch-scroll-y">
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
                    <div className={`${isArenaMode ? 'max-w-full px-2' : 'max-w-4xl px-3 sm:px-4 lg:px-6'} ${openArtifactId ? 'lg:pr-[34rem]' : ''} mx-auto py-4 sm:py-6 lg:py-8`}>
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
                          onFollowUp={(q) => handleSendMessage(q)}
                          onRegenerate={handleRegenerate}
                          canRegenerate={msg.role === 'assistant' && index === messages.length - 1 && !isLoading}
                          isArenaMode={msg.isArenaMode}
                          arenaResponses={msg.arenaResponses}
                          onOpenArtifact={(id) => openArtifact(id)}
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

        {/* Input. z-40 lifts the composer above the canvas overlay (z-30) so
            typing stays possible while an artefact is open on desktop. */}
        <div className="relative z-40 flex-shrink-0">
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
            modelName={selectedModelMeta?.name || 'AI'}
            modelKind={selectedModelMeta?.kind || 'Chat'}
            deepThink={deepThink}
            onToggleDeepThink={() => setDeepThink((v) => !v)}
            webSearch={forceWebSearch}
            onToggleWebSearch={() => setForceWebSearch((v) => !v)}
            accentColor={accentColor}
            onSelectAccent={setAccentColor}
          />
        </div>

        {/* Artifact canvas — overlays the right edge of <main> when an artifact
            is open; nothing rendered otherwise, so Arena mode keeps full width. */}
        <ArtifactCanvas
          filesForTurn={messages.flatMap((m) => m.files ?? [])}
          onEdit={(text) => {
            // Feed the artefact back into the chat as context for the next turn:
            // we wrap it and ask the model to treat it as the prior version, so
            // "edit this" becomes a follow-up the model can act on directly.
            const fenced = "```\n" + text + "\n```";
            handleSendMessage(`Here's the current version — make the changes I describe:\n${fenced}`);
          }}
        />
      </main>
    </div>
  );
}

