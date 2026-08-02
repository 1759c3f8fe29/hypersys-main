import { 
  collection, 
  doc, 
  addDoc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  updateDoc, 
  deleteDoc, 
  serverTimestamp,
  writeBatch
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

export interface FirestoreMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: any;
  modelName?: string; // The model used to generate/respond to this message
  attachments?: ChatAttachment[];
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
          attachments: data.attachments || []
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
    attachments: ChatAttachment[] = []
  ): Promise<string> {
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
  }
};
