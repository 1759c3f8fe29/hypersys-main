import type { ImageResult } from '@/lib/search';
import type { InteractiveComponent } from '@/lib/interactive-types';

export type { InteractiveComponent };

export interface ChatAttachment {
  id: string;
  name: string;
  url: string;
  type: 'image' | 'file';
  mimeType?: string;
  size?: number;
}

// Tool call being executed during streaming - for real-time display
export interface StreamingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// Web-search results shown under an assistant reply that was grounded.
export interface MessageSource {
  title: string;
  link: string;
  source?: string | null;
}

// A searched image shown in a gallery under an assistant reply.
//
// Distinct from a generated image (`imageUrl` on the message) on purpose: these are
// REAL pictures retrieved from the web, each with its own source page for
// attribution, and the app must never swap one for a generated picture. `imageUrl`
// and `thumbnailUrl` are the provider's own URLs — the grid loads the thumbnail,
// the lightbox opens the original.
//
// Unlike generated images (data URLs held in tab memory) these are remote http(s)
// URLs, so they are safe to persist on the Firestore doc and re-render on reload.
//
// An alias rather than a second declaration: the transport layer already models this
// row (`ImageResult`, src/lib/search.ts) and `sanitizeImages` is the one place that
// validates it. Two copies of the shape would be two places to add a field and one
// place to forget — the drift this file's neighbours have been bitten by before.
export type MessageImage = ImageResult;

// A file the create_file tool produced, offered as a download under the reply.
// `url` is an object URL owned by the tab that made it: valid until reload,
// which is why these are never written to Firestore with the message.
export interface MessageFile {
  filename: string;
  url: string;
  mimeType: string;
}

// One entry per `run_code` call in a turn.
//
// Execution is user-gated: the tool stages the script and the user presses Run
// beside Copy, so the common case is `status: 'pending'` with `code` set and no
// output at all. `stdout`/`stderr`/`images` exist because a run that DID happen
// (or a future non-gated path) has somewhere to put its results — they are never
// populated by staging alone, which is the invariant that keeps "the model never
// saw this output" true.
//
// Session-only, like MessageFile: `images` are data URLs held in tab memory and
// are not written to the Firestore message doc.
export interface MessageCodeRun {
  /** The staged Python, shown so the user can read it before running it. */
  code?: string;
  /** Language tag for highlighting. Effectively always "python" today. */
  language?: string;
  /** 'pending' = staged, never executed. Absent means "executed" (legacy shape). */
  status?: 'pending' | 'ok' | 'error';
  stdout?: string;
  stderr?: string;
  images?: string[];
}

// A staged implementation checklist (batch #9, `task_list`). One per message:
// the newest staging wins, because a re-issued plan is a correction, not an
// addition. `done` is UI state — the model never sees ticks — so ticks are
// session-only and not written to the Firestore doc (same rule as codeRuns).
export interface MessageTaskList {
  title: string;
  tasks: Array<{ text: string; done: boolean }>;
}