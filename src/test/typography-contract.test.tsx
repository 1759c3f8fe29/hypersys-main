// The typography contract — the ChatGPT-matching scale, pinned.
//
// WHY A TEST FOR FONT SIZES
//
// The user's ask (2026-09-12) was a spec table: every element with its px size
// and weight, matching ChatGPT's look. The survey that preceded this test found
// the app's type was smaller everywhere (message body at 14–15px against the
// spec's 16–17, H1 at 20–24px against ~28–30, tables at 12–14px against 14–16)
// and heavier in decoration (gradient heading text, a tinted chip behind bold)
// than the plain reference. Every surface is a Tailwind class or inline style in
// one of a handful of files — exactly the kind of thing a later restyle silently
// rewrites, because "text-sm" reads as reasonable in any diff.
//
// So the scale is pinned against the rendered DOM. jsdom does not apply
// stylesheets, so `getComputedStyle` cannot resolve class-based sizing — the
// assertions read the class list itself, which is honest here for a specific
// reason: Tailwind arbitrary values are a 1:1 px declaration. `text-[15.5px]`
// generates `font-size: 15.5px` and nothing else, so asserting the token IS
// asserting the size. A restyle that wants a different scale must edit this
// file, which is the point: the spec stops being folklore and becomes a
// decision someone consciously revisits.
//
// THE DEAD `prose` CLASSES
//
// Related survey finding, recorded because it explains why the assertions
// below target the markdown elements and not the container: ChatMessage's
// wrappers carry `prose prose-sm sm:prose-base prose-invert`, but
// @tailwindcss/typography is not registered in tailwind.config.ts, so those
// classes generate zero rules (verified against the built CSS). All message
// typography comes from the custom markdown components in ChatMessage.tsx.
// If the plugin is ever registered, every size below gets applied twice
// (typography's defaults AND the component classes) — fix that by removing
// one of the two, not by relaxing this test.

import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import ChatMessage from "@/components/chat/ChatMessage";

// One markdown fixture exercises every row of the spec table: body, bold,
// inline code, fenced code, all four heading levels, both list kinds, a table,
// and a blockquote. One render, asserted row by row below.
const MARKDOWN = [
  "# H1 title",
  "## H2 title",
  "### H3 title",
  "#### H4 title",
  "Plain paragraph with **bold** and `inline code`.",
  "- list item one",
  "- list item two",
  "1. ordered item",
  "",
  "| Head A | Head B |",
  "| --- | --- |",
  "| cell a | cell b |",
  "",
  "> quoted line",
  "",
  "```python",
  "print('hi')",
  "```",
].join("\n");

function mountAssistant() {
  const { container } = render(
    <ChatMessage role="assistant" content={MARKDOWN} modelName="Test" />,
  );
  return container;
}

describe("message typography — the ChatGPT scale", () => {
  // The spec's body row is 16–17px; the implemented scale is 15.5px on phones
  // rising to 16.5px at ≥640px, weight 400. Both stops are asserted on every
  // content element, because the pair is the scale — a change to one stop
  // without the other is a different design and should fail here.
  const BODY = "text-[15.5px] sm:text-[16.5px]";

  it("paragraphs are the body scale, weight 400", () => {
    const p = mountAssistant().querySelector(".prose p")!;
    expect(p.className).toContain(BODY);
    expect(p.className).toContain("font-normal");
  });

  it("bold is weight 600, not the old 700-with-chip", () => {
    const strong = mountAssistant().querySelector(".prose strong")!;
    expect(strong.className).toContain("font-semibold");
    // The chip was a primary-tinted background behind every bolded word —
    // stripped per the spec's plain-emphasis row.
    expect(strong.className).not.toContain("bg-");
  });

  it("inline code is 13.5px weight 400", () => {
    const code = mountAssistant().querySelector(".prose p code")!;
    expect(code.className).toContain("text-[13.5px]");
    // Weight 400 by absence: no font-medium/semibold/bold token on the element.
    expect(code.className).not.toMatch(/font-(medium|semibold|bold|extrabold)/);
  });

  it("the code block body is 14px", () => {
    const pre = mountAssistant().querySelector("[data-code-block] pre") as HTMLElement;
    // SyntaxHighlighter takes its size through inline customStyle, so this is
    // a real inline declaration rather than a class token.
    expect(pre.style.fontSize).toBe("14px");
  });

  it("the code language label is 12px", () => {
    const label = mountAssistant().querySelector(
      "[data-code-block] span.font-mono",
    )!;
    expect(label.className).toContain("text-xs");
  });

  it.each([
    ["h1", 28, "H1 — the largest thing on the page"],
    ["h2", 24, "H2 — section starts"],
    ["h3", 20, "H3 — subsections"],
    ["h4", 18, "H4 — was unstyled entirely before this pass"],
  ])("%s is %spx weight 600, plain", (tag, px) => {
    const h = mountAssistant().querySelector(`.prose ${tag}`)!;
    expect(h.className).toContain(`text-[${px}px]`);
    expect(h.className).toContain("font-semibold");
    // The stripped decorations: gradient text and clip on h1, the accent bar
    // on h2. If one of these comes back it is a spec change — see the header.
    expect(h.className).not.toContain("bg-gradient-to");
    expect(h.className).not.toContain("bg-clip-text");
    expect(h.className).not.toContain("drop-shadow");
  });

  it("list text is the body scale, weight 400", () => {
    const c = mountAssistant();
    const li = c.querySelector(".prose ul li")!;
    expect(li.className).toContain(BODY);
    expect(li.className).toContain("font-normal");
    expect(c.querySelector(".prose ol")!.className).toContain(BODY);
  });

  it("tables are 15px with weight-600 headers", () => {
    const c = mountAssistant();
    expect(c.querySelector(".prose table")!.className).toContain("text-[15px]");
    const th = c.querySelector(".prose th")!;
    expect(th.className).toContain("font-semibold");
    expect(th.className).not.toContain("font-bold");
  });

  it("blockquote is the body scale, italic, plain", () => {
    const q = mountAssistant().querySelector(".prose blockquote")!;
    expect(q.className).toContain(BODY);
    expect(q.className).toContain("italic");
    // shadow-inner was decoration the plain reference does not carry.
    expect(q.className).not.toContain("shadow-inner");
  });
});

describe("user message typography", () => {
  it("is the body scale, weight 400 — a prompt is content, not a callout", () => {
    const { container } = render(
      <ChatMessage role="user" content="hello there" modelName="Test" />,
    );
    const bubble = container.querySelector(".liquid-message-user p")!;
    expect(bubble.className).toContain("text-[15.5px] sm:text-[16.5px]");
    expect(bubble.className).toContain("font-normal");
    // The old font-medium tinted every prompt toward a UI label.
    expect(bubble.className).not.toContain("font-medium");
  });
});

describe("artifact markdown — the same scale as chat", () => {
  // Entry 49's survey found ArtifactPanel's MarkdownView styling itself with
  // `prose prose-invert prose-sm` alone — the classes that generate zero rules
  // (typography plugin never registered), so a prose artifact rendered with raw
  // browser defaults while chat messages carried the full scale. MarkdownView
  // now shares buildMarkdownComponents with the chat surface; this pins that
  // join the way canvas-collapse pins its store join — the defect lived between
  // two modules and neither's types would notice them drifting apart again.
  //
  // `prose` must also stay on the container: index.css's desktop selection
  // allowlist keys user-select:text on `.prose`, so a "cleanup" that drops the
  // no-op class makes artifact prose unselectable — a styling cleanup that
  // breaks a behaviour the allowlist test in native-selection.test.ts asserts.
  it("renders markdown artifacts through the shared chat components", async () => {
    const { ingestArtifacts, openArtifact } = await import(
      "@/components/artifacts/ArtifactProvider"
    );
    const { ArtifactCanvas } = await import(
      "@/components/artifacts/ArtifactCanvas"
    );
    const { codeArtifactFrom } = await import("@/lib/artifacts");

    ingestArtifacts([
      codeArtifactFrom("markdown", "# Title\n\nA paragraph.\n\n- a list", "m1"),
    ]);
    openArtifact(codeArtifactFrom("markdown", "# Title\n\nA paragraph.\n\n- a list", "m1").id);
    const { container } = render(
      <ArtifactCanvas filesForTurn={[]} />,
    );
    const h1 = await waitFor(() => {
      const el = container.querySelector(".prose h1");
      if (!el) throw new Error("markdown artifact view not rendered yet");
      return el;
    });
    expect(h1.className).toContain("text-[28px]");
    expect(h1.className).toContain("font-semibold");
    // The selection hook from index.css's desktop allowlist.
    expect(container.querySelector(".prose")).not.toBeNull();
  });
});
