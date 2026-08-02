export interface ChatAttachment {
  id: string;
  name: string;
  url: string;
  type: 'image' | 'file';
  mimeType?: string;
  size?: number;
}