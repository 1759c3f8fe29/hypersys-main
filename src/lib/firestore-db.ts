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
  setDoc,
  deleteField,
  type FieldValue
} from 'firebase/firestore';
import { db } from './firebase';
import type { ChatAttachment } from '@/components/chat/types';

// ---------------------------------------------------------------------------
// A note on the timestamp fields below, which were all `any`.
//
// `createdAt`/`updatedAt` carry a different type in each direction, which is why
// one loose annotation looked like the only option: a Firestore `FieldValue`
// sentinel goes IN (`createdAt: serverTimestamp()`), and a Timestamp comes back
// OUT. These interfaces describe the OUT shape only — every read path normalizes
// with `data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString()`
// before the value reaches the app, so an ISO-8601 `string` is what a consumer
// actually receives, always, with a fallback that guarantees never undefined.
//
// The write paths are unaffected by tightening this: each passes a bare inline
// literal to addDoc/setDoc/updateDoc and is not annotated with these interfaces,
// so the sentinel never has to satisfy them. UserSettings.updatedAt below was
// already declared `string | null` on exactly this reasoning.
//
// The payoff is downstream: message-tree's nodeTime() does `typeof c === 'string'`
// then Date.parse on this field to break ties between sibling branches, and under
// `any` nothing connected the two ends. If a read path ever stops normalizing,
// that is now a build error here rather than a sibling sort that silently
// degrades to insertion order.
// ---------------------------------------------------------------------------

export interface FirestoreConversation {
  id: string;
  title: string;
  userId: string;
  /** ISO-8601; normalized on read. See the note above. */
  createdAt: string;
  /** ISO-8601; normalized on read. Sorted on descending for the sidebar. */
  updatedAt: string;
  modelId?: string; // the model selected when active/updated
  /** Server timestamp (ms) of the most recent pin, or undefined when the
   *  conversation was never pinned. A timestamp rather than a boolean: pins
   *  keep a stable recency order among themselves (most recently pinned
   *  first), and unpinning is a field delete rather than a write of false —
   *  a doc that never carried the field reads the same as one that was
   *  unpinned, so there is no third state to mishandle. Absent on documents
   *  written before pinning shipped, which is the same "never pinned"
   *  state as far as any reader is concerned. */
  pinnedAt?: number;
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
  /** ISO-8601; normalized on read. See the note above. */
  createdAt: string;
}

// Per-user custom instructions (Part F.3). Singleton doc at users/{uid}.
// `aboutMe` = who the user is; `howToRespond` = style/format directives.
export interface UserSettings {
  userId: string;
  aboutMe: string;
  howToRespond: string;
  updatedAt: string | null;
}

/**
 * Ceiling on the base64 data URL stored with an attachment.
 *
 * A Firestore document must stay under ~1 MiB across every field, so this is a
 * fraction of it: the message content, the thread metadata and up to ten
 * attachments all share that budget. See the note at the write site for what is
 * lost when the cap trips (the thumbnail) and what is saved (the message).
 */
const MAX_PERSISTED_ATTACHMENT_CHARS = 200_000;

export interface FirestoreMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO-8601; normalized on read. Read by message-tree's sibling tiebreak. */
  createdAt: string;
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
          modelId: data.modelId,
          // Timestamps come back as Firestore Timestamp objects with a
          // toMillis(); the bare-number case covers documents written by a
          // client that serialized it as a plain number. Both read as
          // undefined when the field is absent — which is "never pinned".
          pinnedAt: typeof data.pinnedAt?.toMillis === 'function'
            ? data.pinnedAt.toMillis()
            : (typeof data.pinnedAt === 'number' ? data.pinnedAt : undefined)
        };
      });
      // Sort client-side to avoid needing a composite index
      return docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } catch (error) {
      // Rethrown, and this is the whole point of the two reads below and above
      // being different from everything else in this file.
      //
      // This used to `return []`, which made the caller's own error handling
      // unreachable. Chat.tsx wraps this call in a try/catch that sets
      // conversationsStatus('error') so the sidebar can render its failure panel
      // and Retry — and none of that could ever fire, because a rejected read
      // arrived as a successful empty one. The sidebar showed "No conversations
      // yet" to a user with fifty chats, which is the exact bug (§14.2 #6) whose
      // fix lives one layer up and had been sitting dead ever since.
      //
      // A swallowed read is fine for data the app can do without — see getMemories
      // and getUserSettings, which stay lenient on purpose. It is not fine when
      // "no data" is also a meaningful, reassuring UI state, because then the two
      // are indistinguishable and the reassuring one wins by default.
      console.error('Error fetching conversations from Firestore:', error);
      throw error;
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
          // `clientId` first, and this is the whole of the threading fix.
          //
          // `parentMessageId` is written by the client, and the client only knows its
          // own ids — the UUIDs it minted when it put the message on screen. But the
          // document id here comes from `addDoc`, which generates its own. So every
          // parent pointer read back from Firestore referenced an id that did not
          // exist in the batch, `buildMessageForest` promoted all of them to roots
          // (its documented orphan behaviour — nothing was lost, but nothing was
          // *threaded* either), and a reload flattened the tree completely: three
          // regenerations of one turn came back as three consecutive replies with no
          // branch switcher, and the next branch created after that reload started
          // its sibling numbering over from zero.
          //
          // Persisting the client's own id and reading it back makes message identity
          // stable across a reload, which is what the parent pointers assumed all
          // along. Nothing in the app addresses a message document by its Firestore
          // id — messages are only ever added and bulk-read by conversationId — so
          // the doc id was never load-bearing. Documents written before this field
          // existed have no clientId and fall back to `d.id`, exactly as before.
          id: data.clientId || d.id,
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
      // Rethrown for the same reason as getConversations above, except that the
      // consequence here is not cosmetic. `return []` left `messages` empty, which
      // the render treats as a brand-new conversation, so the WelcomeScreen
      // appeared over a thread that has history and the composer stayed live.
      // Sending from there reaches the model with **no prior turns**, so a
      // mid-thread follow-up gets answered as if it were the opening line — and
      // that reply is then persisted into the middle of a thread the model never
      // saw.
      //
      // §14.2 #7 built the fix for exactly that: setMessagesError(true), a Retry
      // panel, and `disabled` on the composer. All of it was unreachable. The
      // dangerous half of that bug was still live in production with the fix
      // shipped, tested and inert — which is a worse position than not having
      // fixed it, because the tests said it was handled.
      console.error('Error fetching messages from Firestore:', error);
      throw error;
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
    parentMessageId?: string | null,
    // The id this message already has in the client's own state, persisted so it
    // survives a reload. See the comment on `id` in getMessages — without it, the
    // parentMessageId written above pointed at nothing after a refresh.
    clientId?: string | null
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
        // A Firestore document is capped at ~1 MiB across all of its fields, and
        // `url` here is the whole file base64-encoded. So an attachment much over
        // a megabyte does not merely fail to store its own preview: it makes the
        // *message* write fail, and the caller's error path then tells the user
        // their turn will not survive a reload. A 3 MB phone photo was already
        // enough to do it; now that the picker accepts any file type, so is an
        // ordinary spreadsheet.
        //
        // Dropping just the url keeps the message. The attachment still renders
        // with its name and type on reload, only without the thumbnail, and the
        // reply — which is what the user came for, and which was generated from
        // the extracted text rather than from this field — is intact. Losing a
        // preview beats losing the turn.
        url: (a.url?.length ?? 0) > MAX_PERSISTED_ATTACHMENT_CHARS ? '' : a.url,
        type: a.type,
        mimeType: a.mimeType || null,
        size: a.size || null
      })),
      parentMessageId: parentMessageId ?? null,
      siblingIndex,
      clientId: clientId ?? null,
      createdAt: serverTimestamp()
    });

    // Update conversation timestamp & possibly active model
    const convRef = doc(db, 'conversations', conversationId);
    // Heterogeneous by design — a serverTimestamp() sentinel plus, sometimes, a
    // plain model name — which is why this is a Record rather than a named shape.
    // Union-typed rather than `any` so a stray object (an unserializable Date, a
    // nested literal Firestore would reject) fails here instead of at the wire.
    const updateData: Record<string, FieldValue | string> = {
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

  // ── Pin (§8 Part F conversation management) ──
  //
  // Pin and unpin write the field rather than the whole document, so a
  // concurrent title change or model switch can never be clobbered by a pin.
  // Deliberately NOT touching `updatedAt`: that field feeds the sidebar's date
  // grouping and the list's recency sort, and moving a conversation to "Today"
  // because the user pinned it would silently re-file every row the user
  // navigates by date. A pin is a label, not activity — the conversation did
  // not become recent, it became important.

  async pinConversation(conversationId: string): Promise<void> {
    await updateDoc(doc(db, 'conversations', conversationId), {
      pinnedAt: serverTimestamp(),
    });
  },

  async unpinConversation(conversationId: string): Promise<void> {
    // deleteField rather than a false write, per the note on FirestoreConversation.pinnedAt.
    await updateDoc(doc(db, 'conversations', conversationId), {
      pinnedAt: deleteField(),
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
