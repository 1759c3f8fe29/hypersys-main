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