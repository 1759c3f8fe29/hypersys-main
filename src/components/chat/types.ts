export interface ChatAttachment {
  id: string;
  name: string;
  url: string;
  type: 'image' | 'file';
  mimeType?: string;
  size?: number;
}

// Web-search results shown under an assistant reply that was grounded.
export interface MessageSource {
  title: string;
  link: string;
  source?: string | null;
}

// A file the create_file tool produced, offered as a download under the reply.
// `url` is an object URL owned by the tab that made it: valid until reload,
// which is why these are never written to Firestore with the message.
export interface MessageFile {
  filename: string;
  url: string;
  mimeType: string;
}