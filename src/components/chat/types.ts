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