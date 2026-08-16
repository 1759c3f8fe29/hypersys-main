// Memories + Custom Instructions panel (Part F.2 / F.3).
//
// Two things live here:
//   1. Custom instructions — "About me" and "How to respond", a per-user
//      singleton (users/{uid} doc). Hand-authored, saved on a button.
//   2. Memories — a growing list of facts (auto-extracted after turns or
//      added here). Each row: edit inline, delete. source:'auto' rows get a
//      little "auto" tag so the user can tell what the model inferred vs what
//      they wrote, and prune wrong inferences.
//
// Both feed the system prompt through the existing contextBlocks() slots
// (# User's Instructions, # User Memories). This panel is the only authoring
// surface for custom instructions and the only pruning surface for memories.
//
// The component owns its Firestore reads/writes (via useAuth + firestoreDb),
// so it can be dropped in anywhere without prop-drilling cache state. The
// parent's own memories cache (used for live prompt injection) is given a
// `onMemoriesChanged` callback so it can refetch and stay in sync.

import { useEffect, useState, useCallback } from 'react';
import { Brain, Trash2, Plus, Pencil, Check, X, Sparkles, User, MessageSquareWarning } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { firestoreDb, type FirestoreMemory, type UserSettings } from '@/lib/firestore-db';
import { useAuth } from '@/hooks/useAuth';

interface MemoriesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Notify the parent that memories/instructions changed so its prompt-injection
  // cache can refetch. Without this the parent keeps injecting a stale snapshot
  // until the next auth-driven reload.
  onMemoriesChanged?: () => void;
  onInstructionsChanged?: () => void;
}

export default function MemoriesPanel({ open, onOpenChange, onMemoriesChanged, onInstructionsChanged }: MemoriesPanelProps) {
  const { user, isGuest } = useAuth();

  // Custom instructions local form state.
  const [aboutMe, setAboutMe] = useState('');
  const [howToRespond, setHowToRespond] = useState('');
  const [savingInstructions, setSavingInstructions] = useState(false);

  // Memories list state.
  const [memories, setMemories] = useState<FirestoreMemory[]>([]);
  const [newMemory, setNewMemory] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const loadAll = useCallback(async () => {
    if (!user || isGuest) return;
    const [m, s] = await Promise.all([
      firestoreDb.getMemories(user.uid),
      firestoreDb.getUserSettings(user.uid),
    ]);
    setMemories(m);
    setAboutMe(s?.aboutMe ?? '');
    setHowToRespond(s?.howToRespond ?? '');
  }, [user, isGuest]);

  useEffect(() => {
    if (open) loadAll();
  }, [open, loadAll]);

  const saveInstructions = async () => {
    if (!user || isGuest) return;
    setSavingInstructions(true);
    try {
      await firestoreDb.saveUserSettings(user.uid, { aboutMe, howToRespond });
      toast.success('Custom instructions saved');
      onInstructionsChanged?.();
    } catch {
      toast.error('Could not save instructions');
    } finally {
      setSavingInstructions(false);
    }
  };

  const addMemory = async () => {
    const content = newMemory.trim();
    if (!content || !user || isGuest) return;
    try {
      const id = await firestoreDb.addMemory(user.uid, content, 'manual');
      if (id) {
        const row: FirestoreMemory = { id, userId: user.uid, content, source: 'manual', createdAt: new Date().toISOString() };
        setMemories((prev) => [row, ...prev]);
        setNewMemory('');
        onMemoriesChanged?.();
      }
    } catch {
      toast.error('Could not add memory');
    }
  };

  const startEdit = (m: FirestoreMemory) => { setEditingId(m.id); setEditDraft(m.content); };
  const cancelEdit = () => { setEditingId(null); setEditDraft(''); };
  const commitEdit = async (m: FirestoreMemory) => {
    const content = editDraft.trim();
    if (!content || !user) { cancelEdit(); return; }
    try {
      await firestoreDb.updateMemory(m.id, content);
      setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, content } : x)));
      cancelEdit();
      onMemoriesChanged?.();
    } catch {
      toast.error('Could not update memory');
    }
  };

  const removeMemory = async (m: FirestoreMemory) => {
    if (!user) return;
    try {
      await firestoreDb.deleteMemory(m.id);
      setMemories((prev) => prev.filter((x) => x.id !== m.id));
      onMemoriesChanged?.();
    } catch {
      toast.error('Could not delete memory');
    }
  };

  const guest = !user || isGuest;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[85vh] flex flex-col border-white/10 bg-background/95 backdrop-blur-xl text-foreground rounded-2xl shadow-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            <Brain className="w-5 h-5 text-primary" />
            Memory & Instructions
          </DialogTitle>
          <DialogDescription className="text-muted-foreground/80 text-xs">
            What Flyer should remember about you, and how it should respond. These are injected silently into every conversation.
          </DialogDescription>
        </DialogHeader>

        {guest ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground">
            <User className="w-8 h-8 opacity-50" />
            <p className="text-sm max-w-xs">
              Sign in to save memories and custom instructions. Guest sessions aren't persisted.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6 overflow-y-auto pr-1 -mr-1">

            {/* ── Custom instructions ── */}
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground/90">
                <Sparkles className="w-4 h-4 text-primary" />
                Custom Instructions
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">About me</label>
                <Textarea
                  value={aboutMe}
                  onChange={(e) => setAboutMe(e.target.value)}
                  placeholder="Your name, role, what you work on, anything that gives useful context…"
                  rows={3}
                  className="resize-none bg-background/60 border-border/40 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">How to respond</label>
                <Textarea
                  value={howToRespond}
                  onChange={(e) => setHowToRespond(e.target.value)}
                  placeholder="Tone, format, length, what to avoid… e.g. “Keep answers concise, prefer bullet points, don't use headers for short replies.”"
                  rows={3}
                  className="resize-none bg-background/60 border-border/40 text-sm"
                />
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={saveInstructions}
                  disabled={savingInstructions}
                  className="h-8"
                >
                  {savingInstructions ? 'Saving…' : 'Save instructions'}
                </Button>
              </div>
            </section>

            <div className="h-px bg-border/30" />

            {/* ── Memories ── */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground/90">
                  <Brain className="w-4 h-4 text-primary" />
                  Memories
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">{memories.length}</span>
              </div>

              {/* Add new */}
              <div className="flex gap-2">
                <Textarea
                  value={newMemory}
                  onChange={(e) => setNewMemory(e.target.value)}
                  placeholder="Add a fact to remember…"
                  rows={1}
                  className="resize-none bg-background/60 border-border/40 text-sm min-h-[40px]"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addMemory(); }
                  }}
                />
                <Button size="sm" onClick={addMemory} disabled={!newMemory.trim()} className="h-auto self-stretch px-3 shrink-0">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>

              {/* List */}
              <div className="space-y-2">
                {memories.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                    <MessageSquareWarning className="w-6 h-6 text-muted-foreground/40" />
                    <p className="text-xs text-muted-foreground max-w-[280px]">
                      No memories yet. Flyer will infer facts from your chats and list them here so you can keep or delete them.
                    </p>
                  </div>
                ) : (
                  memories.map((m) => (
                    <div
                      key={m.id}
                      className="group/mem flex items-start gap-2 rounded-xl border border-border/30 bg-background/40 p-2.5"
                    >
                      {editingId === m.id ? (
                        <>
                          <Textarea
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            autoFocus
                            rows={Math.min(6, Math.max(1, editDraft.split('\n').length))}
                            className="resize-none bg-background/70 border-border/40 text-sm flex-1"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(m); }
                              if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                            }}
                          />
                          <div className="flex flex-col gap-1 shrink-0">
                            <button onClick={() => commitEdit(m)} className="p-1.5 rounded-lg hover:bg-primary/10 text-primary" title="Save"><Check className="w-3.5 h-3.5" /></button>
                            <button onClick={cancelEdit} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground" title="Cancel"><X className="w-3.5 h-3.5" /></button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">{m.content}</p>
                            {m.source === 'auto' && (
                              <span className="inline-block mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 border border-border/30 rounded px-1.5 py-0.5">
                                auto
                              </span>
                            )}
                          </div>
                          <div className="flex flex-col gap-1 shrink-0 opacity-0 group-hover/mem:opacity-100 transition-opacity">
                            <button onClick={() => startEdit(m)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                            <button onClick={() => removeMemory(m)} className="p-1.5 rounded-lg hover:bg-destructive/15 text-muted-foreground hover:text-destructive" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
