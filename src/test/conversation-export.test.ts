// Conversation export serializer (§8 Part F), red-first.
//
// The contract under test: a conversation exports as one Markdown document —
// H1 title, optional stamp, one H2 section per turn on the *active branch* —
// and the filename is safe on every desktop filesystem. PDF is the same
// Markdown body through the existing jsPDF engine in file-generator.test
// territory, so this file pins the *document*, not the renderer.
//
// The fixtures mirror the real shapes: user turns can carry attachment names
// (blob URLs are session-scoped, names are what survive on disk), assistant
// turns carry the model that answered (the catalogue's "never substitute one
// model for another" rule — an export that prints the wrong model would lie
// about who said what, permanently).

import { describe, it, expect } from "vitest";

import {
  conversationToMarkdown,
  exportFilename,
  formatTurn,
  type ExportConversation,
  type ExportMessage,
} from "@/lib/conversation-export";

const CONV: ExportConversation = {
  title: "Trip to Rome",
  updatedAt: "2026-09-04T12:34:56.789Z",
  modelId: "mistral-large-latest",
};

const user: ExportMessage = {
  id: "u1",
  role: "user",
  content: "Plan a 3-day itinerary",
  attachmentNames: ["map.png"],
};

const assistant: ExportMessage = {
  id: "a1",
  role: "assistant",
  content: "Day 1: Colosseum…",
  modelName: "Flyer",
};

describe("formatTurn", () => {
  it("renders a user turn as an H2 'You' section with attachments as a quote line", () => {
    expect(formatTurn(user)).toBe(
      "## You\n\nPlan a 3-day itinerary\n\n> Attached: map.png",
    );
  });

  it("renders an assistant turn under its model name, not the bare role", () => {
    // The model that answered must be printed, or the exported document cannot
    // say who said what — the same substitution-lie the catalogue forbids.
    expect(formatTurn(assistant)).toBe("## Flyer\n\nDay 1: Colosseum…");
  });

  it("falls back to 'Assistant' when a reply carries no model name", () => {
    expect(formatTurn({ ...assistant, modelName: undefined })).toBe(
      "## Assistant\n\nDay 1: Colosseum…",
    );
  });

  it("omits the attachment line entirely when there are none", () => {
    const bare = formatTurn({ ...user, attachmentNames: [] });
    expect(bare).not.toContain("Attached");
    expect(bare).toBe("## You\n\nPlan a 3-day itinerary");
  });
});

describe("conversationToMarkdown", () => {
  it("assembles title, stamp, and turns in order", () => {
    const md = conversationToMarkdown(CONV, [user, assistant]);
    expect(md).toBe(
      "# Trip to Rome\n\n" +
        "2026-09-04 12:34:56 UTC\n\n" +
        "## You\n\nPlan a 3-day itinerary\n\n> Attached: map.png\n\n" +
        "## Flyer\n\nDay 1: Colosseum…\n",
    );
  });

  it("keeps turn order: user before assistant, never re-sorted", () => {
    const md = conversationToMarkdown(CONV, [user, assistant]);
    expect(md.indexOf("Plan a 3-day")).toBeLessThan(md.indexOf("Day 1"));
  });

  it("collapses the stamp line when updatedAt is absent rather than printing an invalid date", () => {
    const md = conversationToMarkdown({ title: "T" }, [assistant]);
    expect(md).not.toContain("Invalid");
    expect(md).toBe("# T\n\n## Flyer\n\nDay 1: Colosseum…\n");
  });

  it("collapses the stamp on an unparseable stamp too", () => {
    const md = conversationToMarkdown({ title: "T", updatedAt: "not-a-date" }, []);
    expect(md).toBe("# T\n");
    expect(md).not.toContain("Invalid");
  });

  it("exports an empty conversation as just the title, no stray separators", () => {
    expect(conversationToMarkdown({ title: "Empty" }, [])).toBe("# Empty\n");
  });

  it("uses 'New Chat' when the title is empty", () => {
    expect(conversationToMarkdown({ title: "" }, [])).toBe("# New Chat\n");
  });
});

describe("exportFilename", () => {
  it("slugs the title and prefixes with flyer-", () => {
    expect(exportFilename("Trip to Rome", "md")).toBe("flyer-Trip-to-Rome.md");
  });

  it("strips path separators and reserved characters on both", () => {
    const name = exportFilename('a/b\\c:d*e?f"g<h>i|j', "pdf");
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
    expect(name).toBe("flyer-a-b-c-d-e-f-g-h-i-j.pdf");
  });

  it("falls back rather than emitting an empty slug for a title that is all reserved characters", () => {
    expect(exportFilename('???', "md")).toBe("flyer-conversation.md");
  });

  it("truncates a very long title to keep the filename usable", () => {
    const name = exportFilename("x".repeat(300), "md");
    expect(name.length).toBeLessThanOrEqual("flyer-".length + 80 + ".md".length);
    expect(name.endsWith(".md")).toBe(true);
  });
});
