import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
  setDoc
} from 'firebase/firestore';
import { db } from './firebase';
import type { ChatAttachment } from '@/components/chat/types';

export interface FirestoreConversation {
  id: string;
  title: string;
  userId: string;
  createdAt: any;
  updatedAt: any;
  modelId?: string; // the model selected when active/updated
}

// One persisted fact about the user (Part F.2). `source` distinguishes facts
// the model auto-extracted after a turn ('auto') from ones the user typed in
// the memories panel ('manual') — the panel surfaces manual ones as editable
// and auto ones as dismissable, so a user can prune wrong inferences.
export interface FirestoreMemory {
  id: string;
  userId: string;
  content: string;
  source: 'auto' | 'manual';
  createdAt: any;
}

// Per-user custom instructions (Part F.3). Singleton doc at users/{uid}.
// `aboutMe` = who the user is; `howToRespond` = style/format directives.
export interface UserSettings {
  userId: string;
  aboutMe: string;
  howToRespond: string;
  updatedAt: string | null;
}

export interface FirestoreMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: any;
  modelName?: string; // The model used to generate/respond to this message
  attachments?: ChatAttachment[];
  // Threading: a message is a node in a tree, not a slot in a list. Each
  // message points at its parent — the user message it replies to (for an
  // assistant message), or the assistant message the user is continuing
  // from (for a user message). Roots (the first message of a conversation)
  // carry null. Old conversation imported before this field existed read
  // back as null and are treated as roots, so existing history keeps working.
  parentMessageId?: string | null;
  // Sibling index within the parent's children. When a user edits a message
  // or regenerates a reply, the new node is a *new* child of the same parent
  // rather than an in-place mutation — old branches are preserved. This index
  // orders the siblings and drives the < 1/3 > branch switcher.
  siblingIndex?: number;
}

export const firestoreDb = {
  // Load all conversations for a user
  async getConversations(userId: string): Promise<FirestoreConversation[]> {
    try {
      const q = query(
        collection(db, 'conversations'),
        where('userId', '==', userId)
      );
      const snapshot = await getDocs(q);
      const docs = snapshot.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          title: data.title || 'New Chat',
          userId: data.userId,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
          updatedAt: data.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
          modelId: data.modelId
        };
      });
      // Sort client-side to avoid needing a composite index
      return docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } catch (error) {
      console.error('Error fetching conversations from Firestore:', error);
      return [];
    }
  },

  // Load all messages for a conversation
  async getMessages(conversationId: string): Promise<FirestoreMessage[]> {
    try {
      const q = query(
        collection(db, 'messages'),
        where('conversationId', '==', conversationId)
      );
      const snapshot = await getDocs(q);
      const docs = snapshot.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          conversationId: data.conversationId,
          role: data.role,
          content: data.content || '',
          createdAt: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
          modelName: data.modelName,
          attachments: data.attachments || [],
          // Provide a stable null for the threading fields when absent, so the
          // tree-linearization code never has to distinguish "missing" from
          // "root" at runtime.
          parentMessageId: data.parentMessageId ?? null,
          siblingIndex: typeof data.siblingIndex === 'number' ? data.siblingIndex : 0
        };
      });
      // Sort client-side to avoid needing a composite index
      return docs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } catch (error) {
      console.error('Error fetching messages from Firestore:', error);
      return [];
    }
  },

  // Create a conversation doc
  async createConversation(userId: string, title: string, modelId?: string): Promise<string> {
    const docRef = await addDoc(collection(db, 'conversations'), {
      userId,
      title: title.slice(0, 80),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      modelId: modelId || 'default'
    });
    return docRef.id;
  },

  // Save a message doc
  async saveMessage(
    conversationId: string,
    userId: string,
    role: 'user' | 'assistant',
    content: string,
    modelName?: string,
    attachments: ChatAttachment[] = [],
    // Threading. For a normal continuation, parentMessageId is the id of the
    // most recent assistant message (user is replying to it) or the most recent
    // user message (assistant is replying to it). Omit it only for the first
    // message of a conversation, which is a root. For an edit/regenerate, pass
    // the *same* parentMessageId the original branch shared — this creates a
    // new sibling under that parent rather than mutating the original.
    parentMessageId?: string | null
  ): Promise<string> {
    // Compute the sibling index: how many children this parent already has.
    // This is a read-then-write (not transactional), which is fine here —
    // branch creation is a user action, not a high-concurrency path, and the
    // worst case of a colliding index is two branches with equal ordering
    // (tiebroken by createdAt), not data loss.
    let siblingIndex = 0;
    if (parentMessageId) {
      try {
        const q = query(
          collection(db, 'messages'),
          where('conversationId', '==', conversationId),
          where('parentMessageId', '==', parentMessageId)
        );
        const snap = await getDocs(q);
        siblingIndex = snap.size;
      } catch {
        // Non-fatal: a missing index or transient error just places the new
        // branch at index 0; the tree still renders.
        siblingIndex = 0;
      }
    }

    // Add the message. `userId` is required so Firestore security rules can
    // scope reads/writes to the owning user.
    const msgRef = await addDoc(collection(db, 'messages'), {
      conversationId,
      userId,
      role,
      content,
      modelName: modelName || null,
      attachments: attachments.map(a => ({
        id: a.id,
        name: a.name,
        url: a.url,
        type: a.type,
        mimeType: a.mimeType || null,
        size: a.size || null
      })),
      parentMessageId: parentMessageId ?? null,
      siblingIndex,
      createdAt: serverTimestamp()
    });

    // Update conversation timestamp & possibly active model
    const convRef = doc(db, 'conversations', conversationId);
    const updateData: Record<string, any> = {
      updatedAt: serverTimestamp()
    };
    if (role === 'assistant' && modelName) {
      // Keep track of the last assistant model name used
      updateData.lastModelUsed = modelName;
    }
    await updateDoc(convRef, updateData);

    return msgRef.id;
  },

  // Delete a conversation and all its messages.
  // IMPORTANT: delete the messages FIRST. The security rule for deleting a
  // message calls ownsConversation(), which get()s the parent conversation
  // doc — if the conversation is already gone, every message delete is denied
  // and the messages are orphaned. So messages must go while the parent lives.
  async deleteConversation(conversationId: string): Promise<void> {
    // Batch delete messages while the parent conversation still exists.
    const q = query(collection(db, 'messages'), where('conversationId', '==', conversationId));
    const snapshot = await getDocs(q);

    if (snapshot.size > 0) {
      const batch = writeBatch(db);
      snapshot.docs.forEach((d) => {
        batch.delete(d.ref);
      });
      await batch.commit();
    }

    // Now remove the conversation doc itself.
    await deleteDoc(doc(db, 'conversations', conversationId));
  },

  // Update the active model on a conversation
  async updateConversationModel(conversationId: string, modelId: string): Promise<void> {
    await updateDoc(doc(db, 'conversations', conversationId), { modelId });
  },

  // Update the title of a conversation
  async updateConversationTitle(conversationId: string, title: string): Promise<void> {
    await updateDoc(doc(db, 'conversations', conversationId), {
      title: title.slice(0, 60),
      updatedAt: serverTimestamp(),
    });
  },

  // ── Persistent memory (Part F.2) ──
  //
  // A `memories` collection, one doc per fact, scoped by userId. Facts are the
  // kind of thing a person would want recalled across conversations: name,
  // preferences, ongoing projects, how-tos they keep re-explaining. They're
  // surfaced into the system prompt via the `# User Memories` block in
  // contextBlocks() (prompts.ts), so the model leans on them silently.
  //
  // Distinguished from custom instructions (F.3, below): a memory is a FACT
  // (what's true), an instruction is a DIRECTIVE (how to respond). Memories
  // get auto-extracted after a turn; instructions are hand-authored.

  async getMemories(userId: string): Promise<FirestoreMemory[]> {
    try {
      const q = query(collection(db, 'memories'), where('userId', '==', userId));
      const snap = await getDocs(q);
      const out = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          userId: data.userId,
          content: data.content || '',
          source: data.source || 'auto',
          createdAt: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        } as FirestoreMemory;
      });
      // Sort newest-first client-side to avoid a composite index requirement
      // (same pattern getMessages uses).
      return out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch (e) {
      console.error('Error fetching memories:', e);
      return [];
    }
  },

  async addMemory(userId: string, content: string, source: 'auto' | 'manual' = 'manual'): Promise<string | null> {
    const trimmed = content.trim();
    if (!trimmed) return null;
    try {
      const ref = await addDoc(collection(db, 'memories'), {
        userId,
        content: trimmed.slice(0, 2000),
        source,
        createdAt: serverTimestamp(),
      });
      return ref.id;
    } catch (e) {
      console.error('Error adding memory:', e);
      return null;
    }
  },

  async updateMemory(memoryId: string, content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    await updateDoc(doc(db, 'memories', memoryId), { content: trimmed.slice(0, 2000) });
  },

  async deleteMemory(memoryId: string): Promise<void> {
    await deleteDoc(doc(db, 'memories', memoryId));
  },

  // ── Custom instructions (Part F.3) ──
  //
  // A single doc per user at users/{uid}. Two free-text fields: `aboutMe`
  // (who the user is — name, role, context) and `howToRespond` (style/tone/
  // format directives). Both are injected via the `# User's Instructions`
  // block in contextBlocks() (prompts.ts); the model follows them silently.
  // Stored on a per-user doc rather than a collection because instructions are
  // a singleton, not a growing list.

  async getUserSettings(userId: string): Promise<UserSettings | null> {
    try {
      const snap = await getDoc(doc(db, 'users', userId));
      if (!snap.exists()) return null;
      const data = snap.data();
      return {
        userId,
        aboutMe: data.aboutMe || '',
        howToRespond: data.howToRespond || '',
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
      };
    } catch (e) {
      console.error('Error fetching user settings:', e);
      return null;
    }
  },

  async saveUserSettings(userId: string, settings: { aboutMe?: string; howToRespond?: string }): Promise<void> {
    // setDoc semantics: create-or-overwrite the per-user doc. The id == userId
    // so each user owns exactly one instructions doc.
    const ref = doc(db, 'users', userId);
    await setDoc(ref, {
      aboutMe: settings.aboutMe ?? '',
      howToRespond: settings.howToRespond ?? '',
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }
};
