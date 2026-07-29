import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { firestoreDb } from '@/lib/firestore-db';
import ChatSidebar, { AI_MODELS } from '@/components/chat/ChatSidebar';
import ChatMessage from '@/components/chat/ChatMessage';
import ChatInput from '@/components/chat/ChatInput';
import ModelSelector from '@/components/chat/ModelSelector';
import WelcomeScreen from '@/components/chat/WelcomeScreen';
import { generateChatResponse, generateVisionResponse, generateImageResponse, craftImagePrompt, craftVisionPrompt, evaluateUserIntent, generateSmartChatTitle, isVisionModel, isVisionCapableModel, isImageModel, VISION_ENGINE_MODEL, type ChatMessage as AiChatMessage, type ContentPart } from '@/lib/ai';
import { evaluateSmartWebSearch, webSearch, buildSearchContext } from '@/lib/search';
import type { ChatAttachment } from '@/components/chat/types';
import { Menu, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { extractFirstMarkdownImage, isImageGenerationRequest, sanitizeAssistantText } from '@/lib/chat-format';

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
  // Arena Mode
  isArenaMode?: boolean;
  arenaResponses?: ArenaResponse[];
}

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  modelId?: string;
}

// Some flagship NIM models (qwen-3.5-397b, minimax-m3, llama-4-maverick,
// mistral-large/medium) cold-start 60-100s before the first token, then stream
// fine. The base timeout must clear that window or those models always error.
// Verified worst-case first-token was ~100s on 2026-07-21.
const REQUEST_TIMEOUT_MS = 130_000;
const SLOW_REQUEST_TIMEOUT_MS = 130_000;
const DEFAULT_VISION_MODEL = VISION_ENGINE_MODEL;
// Default renderer for a text-to-image request that fires from a Chat model,
// and the chat model used to author an image prompt when the user is on an
// Image model (so the prompt is always written by a chat model).
const DEFAULT_IMAGE_MODEL = 'flux';
const DEFAULT_CHAT_MODEL_ID = 'mistral-large-latest';

// Dynamic Brand Persona Prompt Generator
// Makes the assistant identify as Flyer, Powered by (modelName).
function buildFlyerSystemPrompt(modelName: string): string {
  return [
    `You are **Flyer**, a world-class AI assistant (Powered by ${modelName}).`,
    `When asked about your identity, say: "I am Flyer, powered by ${modelName}."`,
    '',
    '## RESPONSE STYLE',
    '- **Default: concise.** 1-3 short paragraphs or clean bullet points. No essays unless the user asks for detail.',
    '- **Lead with the answer.** Open with a direct 1-2 sentence answer or solution. Zero filler intros.',
    '- **Expand only when asked.** Provide step-by-step, multi-section responses only for complex code, math, architecture, or explicit "explain in detail" requests.',
    '',
    '## FORMATTING',
    '- Use `## ` headings to divide multi-section answers logically.',
    '- **Bold** key terms for skimmability.',
    '- All code in fenced blocks with language tags (```python, ```ts, ```bash). Production code should include error handling.',
    '- Use `inline code` for function names, variables, CLI commands, and paths.',
    '- Markdown tables for comparisons. Numbered lists for sequential steps. Bullet points for unordered lists.',
    '- Keep paragraphs to 1-3 sentences max with blank lines between them.',
    '',
    '## ACCURACY',
    '- Be factually precise. When web search context is provided, synthesize it and cite sources inline [1], [2].',
    '- Never output <think> blocks, scratchpad, or internal reasoning — final answer only.',
    '- If you are unsure, say so honestly rather than fabricating information.',
  ].join('\n');
}

function buildVisionSystemPrompt(modelName: string): string {
  return [
    `You are **Flyer**, an expert visual analysis assistant (Powered by ${modelName}).`,
    `When asked about your identity, say: "I am Flyer, powered by ${modelName}."`,
    '',
    '## VISION ANALYSIS RULES',
    '- **Lead with the answer.** If the user asked a specific question, answer it directly in 1-2 sentences first.',
    '- Structure detailed breakdowns under clear headings: **Overview**, **Key Details**, **Text/OCR in Image**, **Technical Analysis**.',
    '- Transcribe ALL visible text, numbers, code, labels, and headers verbatim.',
    '- Describe spatial layout, colors, objects, UI elements, diagrams, and relationships accurately.',
    '- Only describe what is genuinely visible. Never invent or hallucinate details.',
    '- Never output <think> blocks or internal reasoning — final analysis only.',
  ].join('\n');
}

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
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [selectedModel, setSelectedModel] = useState('mistral-large-latest');
  
  // Arena Mode state
  const [isArenaMode, setIsArenaMode] = useState(false);
  const [compareModels, setCompareModels] = useState<string[]>(['llama-8b']);

  // Drag and Drop File System state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isNewConversationRef = useRef(false);

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

  const loadMessages = useCallback(async () => {
    if (!activeConversationId) { setMessages([]); return; }
    if (isNewConversationRef.current) {
      isNewConversationRef.current = false;
      return;
    }
    setIsMessagesLoading(true);
    setMessages([]); // Clear stale messages immediately
    try {
      const data = await firestoreDb.getMessages(activeConversationId);
      setMessages(data.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        imageUrl: m.role === 'assistant' ? extractFirstMarkdownImage(m.content) : undefined,
        attachments: m.attachments,
        modelName: m.modelName,
      })) || []);
    } catch (e) {
      console.error("Failed to load messages:", e);
    } finally {
      setIsMessagesLoading(false);
    }
  }, [activeConversationId]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  // Restore the selected model when switching conversations. Older chats may
  // reference a model that has since been removed from the catalog — fall back
  // to the default so we never re-select an ID that no longer responds.
  useEffect(() => {
    if (activeConversationId) {
      const activeConv = conversations.find(c => c.id === activeConversationId);
      if (activeConv?.modelId) {
        const isKnown = AI_MODELS.some(m => m.id === activeConv.modelId);
        setSelectedModel(isKnown ? activeConv.modelId : 'mistral-large-latest');
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
    attachments?: ChatAttachment[]
  ) => {
    if (!user) return;
    try {
      await firestoreDb.saveMessage(conversationId, user.uid, role, content, modelName, attachments);
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

    const requestContent = trimmedContent || (pendingAttachments.length > 0 ? 'Describe this image in detail.' : '');

    const selectedModelMeta = AI_MODELS.find((model) => model.id === selectedModel) || AI_MODELS[0];
    const imageAttachments = pendingAttachments.filter((a) => a.type === 'image');
    const hasImages = imageAttachments.length > 0;

    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: trimmedContent, attachments: pendingAttachments };
    const assistantMessage: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', modelName: selectedModelMeta.name };

    // ── INSTANT UI UPDATE — show user message + thinking placeholder NOW ──
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

    // ── Run intent evaluation AFTER the UI has been updated ──
    const intentEval = await evaluateUserIntent(
      requestContent,
      selectedModel,
      abortControllerRef.current?.signal,
    );

    const isImageGen = intentEval.needsImage;

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
    const allMessages: AiChatMessage[] = [
      { role: 'system', content: hasImages ? buildVisionSystemPrompt(selectedModelMeta.name) : buildFlyerSystemPrompt(selectedModelMeta.name) },
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
        pendingAttachments
      );
    }

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

        // Which model actually renders the image: the selected model if it's an
        // Image model, otherwise our default renderer (FLUX).
        const renderModelId = isImageModel(selectedModel) ? selectedModel : DEFAULT_IMAGE_MODEL;

        // The 1000-word master prompt is crafted BY the chat model (ChatGPT-style).
        const promptAuthorModel = isImageModel(selectedModel) ? DEFAULT_CHAT_MODEL_ID : selectedModel;
        const imagePrompt = await craftImagePrompt(
          rawPrompt,
          promptAuthorModel,
          abortControllerRef.current.signal,
        );

        const { imageDataUrl, message } = await generateImageResponse(
          imagePrompt,
          renderModelId,
          imageAttachments.map(a => ({ dataUrl: a.url })),
          abortControllerRef.current.signal
        );

        const imageContent = `![Generated Image](${imageDataUrl})\n\n${message}`;

        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMessage.id ? { ...m, content: imageContent, imageUrl: imageDataUrl } : m)),
        );
        receivedAssistantContent = true;

        if (convId && isAuthenticated) {
          await saveMessage(convId, 'assistant', imageContent, selectedModelMeta.name);
        }
      } else {
        let fullContent = '';

        const messagesForModel = [...allMessages];

        // When images/files are uploaded, use the Chat model first to craft a 1000-word
        // master vision analysis prompt to supply internally to the vision engine.
        if (hasImages) {
          try {
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
                  { type: 'text', text: masterVisionPrompt },
                  ...contentArray.filter((part) => part.type === 'image_url'),
                ],
              };
            }
          } catch (e) {
            console.warn('Vision master prompt crafting fallback:', e);
          }
        }

        // Web search execution grounded by fast intent evaluator
        if (!hasImages && intentEval.needsSearch && intentEval.searchQuery) {
          try {
            setIsSearching(true);
            const search = await webSearch(intentEval.searchQuery, abortControllerRef.current?.signal);
            const context = buildSearchContext(search);
            if (context) {
              messagesForModel.splice(messagesForModel.length - 1, 0, {
                role: 'system',
                content: [
                  `[FAST INTENT CLASSIFIER (${intentEval.fastModelUsed}) TRIGGERED WEB SEARCH FOR QUERY: "${intentEval.searchQuery}"]`,
                  context
                ].join('\n\n')
              });
            }
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') throw err;
          } finally {
            setIsSearching(false);
          }
        }

        const selectedModelMeta = AI_MODELS.find((model) => model.id === selectedModel) || AI_MODELS[0];
        // Arena mode is disabled for image generation requests
        const activeArenaMode = isArenaMode && !isImageGen;

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessage.id
              ? {
                  ...m,
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

          if (hasImages) {
            // Step 1: Run Vision Engine (Mistral Pixtral 12B by default) to extract raw visual breakdown
            let rawVisionOutput = '';
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
                  buildFlyerSystemPrompt(selectedModelMeta.name),
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

            await generateChatResponse(
              refinedChatMessages,
              selectedModel,
              handleDelta,
              abortControllerRef.current!.signal,
            );
          } else {
            await generateChatResponse(messagesForModel, effectiveModelId, handleDelta, abortControllerRef.current!.signal);
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
                arenaResponses: activeArenaMode && m.arenaResponses
                  ? m.arenaResponses.map((ar, i) => ({ ...ar, content: secondaryResults[i] || ar.content }))
                  : undefined
              };
            })
          );

          if (convId && isAuthenticated) {
            await saveMessage(convId, 'assistant', finalText, selectedModelMeta.name);
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
      setIsSearching(false);
      abortControllerRef.current = null;
    }
  };

  const handleStopGeneration = () => { abortControllerRef.current?.abort(); };
  const handleNewConversation = () => { setActiveConversationId(null); setMessages([]); setSidebarCollapsed(true); };

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
      className="h-screen h-[100dvh] flex w-full bg-background overflow-hidden liquid-app relative"
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
          onSelectConversation={(id) => { setActiveConversationId(id); setSidebarCollapsed(true); }}
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
            <motion.div className="flex w-10 h-10 rounded-xl items-center justify-center flex-shrink-0 liquid-icon" whileHover={{ scale: 1.1, rotate: 5 }}>
              <Sparkles className="w-[18px] h-[18px] text-primary relative z-10" />
            </motion.div>
            <div className="min-w-0">
              <h1 className="font-display font-semibold text-base sm:text-lg truncate text-foreground/90">
                {activeConversationId ? conversations.find((c) => c.id === activeConversationId)?.title || 'Chat' : 'Flyer'}
              </h1>
              {isLoading && (
                <motion.div className="flex items-center gap-2" initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }}>
                  {isSearching ? (
                    <>
                      <motion.span
                        className="text-sm"
                        animate={{ rotate: [0, 360] }}
                        transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
                      >
                        🌐
                      </motion.span>
                      <span className="text-xs text-primary/90 font-medium">Searching the web…</span>
                    </>
                  ) : (
                    <>
                      <div className="flex gap-1">
                        {[0, 0.2, 0.4].map((d, i) => (
                          <motion.span key={i} className="w-1.5 h-1.5 rounded-full bg-primary" animate={{ scale: [1, 1.3, 1], opacity: [0.5, 1, 0.5] }} transition={{ duration: 1, repeat: Infinity, delay: d }} />
                        ))}
                      </div>
                      <span className="text-xs text-primary/80 font-medium">Generating...</span>
                    </>
                  )}
                </motion.div>
              )}
              {!isLoading && !isGuest && (
                <span className="text-xs text-muted-foreground/70 truncate block">{selectedModelMeta?.name || 'Default'} · {selectedModelMeta?.kind || 'Chat'}</span>
              )}
              {isGuest && !isLoading && (
                <span className="text-xs text-muted-foreground/60">Guest mode • <a href="/auth" className="text-primary hover:underline">Sign in to save chats</a></span>
              )}
            </div>
          </div>

          <div className="relative flex items-center gap-3 flex-shrink-0">
            {/* Arena Mode Toggle */}
            <div className="flex items-center gap-1.5 bg-secondary/40 border border-border/30 rounded-xl p-1 backdrop-blur-md">
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
              {[
                { name: 'Teal', value: '172 66% 50%', bg: 'bg-[#1ad1b9]' },
                { name: 'Blue', value: '210 90% 55%', bg: 'bg-[#258eff]' },
                { name: 'Purple', value: '270 85% 60%', bg: 'bg-[#984cff]' },
                { name: 'Rose', value: '340 85% 55%', bg: 'bg-[#ff2d74]' },
                { name: 'Amber', value: '30 95% 55%', bg: 'bg-[#ff8f1f]' },
                { name: 'Emerald', value: '145 75% 45%', bg: 'bg-[#1cb866]' },
              ].map((c) => (
                <button
                  key={c.value}
                  onClick={() => setAccentColor(c.value)}
                  className={`w-3.5 h-3.5 rounded-full transition-all duration-200 hover:scale-125 ${c.bg} ${accentColor === c.value ? 'ring-2 ring-white scale-110 shadow-md shadow-white/30' : 'opacity-55 hover:opacity-100'}`}
                  title={`${c.name} Accent`}
                  aria-label={`Change accent color to ${c.name}`}
                />
              ))}
            </div>

            <div className="flex items-center gap-2">
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
        <div ref={scrollContainerRef} className="relative z-10 flex-1 overflow-y-auto scrollbar-thin min-h-0 overflow-anchor-none" style={{ overscrollBehavior: 'none' }}>
          <AnimatePresence mode="wait">
            {isMessagesLoading ? (
              <div key="loading-messages" className="flex flex-col items-center justify-center h-full min-h-[50dvh]">
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
              <WelcomeScreen key="welcome" onSuggestionClick={handleSendMessage} modelName={selectedModelMeta?.name || 'AI'} />
            ) : (
              <motion.div key="messages" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`${isArenaMode ? 'max-w-full px-2' : 'max-w-4xl px-3 sm:px-4 lg:px-6'} mx-auto py-4 sm:py-6 lg:py-8 space-y-3 sm:space-y-4 transition-all duration-300`}>
                {messages.map((msg, index) => (
                  <ChatMessage
                    key={msg.id}
                    role={msg.role}
                    content={msg.content}
                    imageUrl={msg.imageUrl}
                    attachments={msg.attachments}
                    isStreaming={isLoading && msg.role === 'assistant' && index === messages.length - 1}
                    modelName={msg.modelName || 'AI'}
                    onRegenerate={handleRegenerate}
                    canRegenerate={msg.role === 'assistant' && index === messages.length - 1 && !isLoading}
                    isArenaMode={msg.isArenaMode}
                    arenaResponses={msg.arenaResponses}
                  />
                ))}
                <div ref={messagesEndRef} className="h-4" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Input */}
        <div className="relative z-20 flex-shrink-0">
          <ChatInput onSend={handleSendMessage} isLoading={isLoading} onStop={handleStopGeneration} modelName={selectedModelMeta?.name || 'AI'} modelKind={selectedModelMeta?.kind || 'Chat'} />
        </div>
      </main>
    </div>
  );
}
