// The markdown render contract — what the model writes is what the reader sees,
// and nothing the model writes can act.
//
// WHY THIS EXISTS
//
// The 2026-10-11 formatting task (restore headings/lists/tables/emoji in replies)
// has a security half that no other test covers. `typography-contract.test.tsx`
// pins the *scale* of each element once it renders; it says nothing about whether
// the pipeline renders the right elements at all, or about what a reply is
// allowed to execute. Both live in wiring that reads as a plausible cleanup in a
// diff: `remarkPlugins` (drop remark-gfm and every table silently becomes pipes),
// `rehypePlugins` (add rehype-raw and a reply's `<script>` becomes a live node),
// and the `a` component (drop it and links open in place, un-`noopener`'d).
//
// The sanitizer is the load-bearing claim: react-markdown WITHOUT rehype-raw
// does not turn raw HTML in a message into elements. A model that emits
// `<script>` is emitting text, and this file fails the moment that stops being
// true — because the failure mode is a remote script execution, not a bad look.

import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import ChatMessage from "@/components/chat/ChatMessage";

declare global {
  interface Window {
    __renderContractPwned?: boolean;
  }
}

afterEach(() => {
  delete window.__renderContractPwned;
});

const REPLY = [
  "# Setup 🔥",
  "",
  "Some **bold** text, an emoji ✅, and a [link](https://example.com).",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| alpha | 1 |",
  "",
  "- first bullet",
  "- second bullet",
  "",
  "1. step one",
  "2. step two",
  "",
  "```js",
  "const x = 1;",
  "```",
].join("\n");

function mountAssistant(content: string, isStreaming = false) {
  const { container } = render(
    <ChatMessage
      role="assistant"
      content={content}
      modelName="Test"
      isStreaming={isStreaming}
    />,
  );
  return container;
}

describe("markdown renders as elements, not text", () => {
  it("a GFM table becomes a real <table>, not pipe text", () => {
    const c = mountAssistant(REPLY);
    const table = c.querySelector(".prose table");
    expect(table, "table did not render — remark-gfm missing from remarkPlugins?").not.toBeNull();
    expect(table!.querySelectorAll("th")).toHaveLength(2);
    expect(table!.querySelectorAll("td")).toHaveLength(2);
    // A remark-gfm removal leaves the pipes as literal text in a paragraph.
    expect(c.querySelector(".prose th")!.textContent).toBe("Name");
  });

  it("headings, both list kinds, bold and emoji all survive to the DOM", () => {
    const c = mountAssistant(REPLY);
    expect(c.querySelector(".prose h1")!.textContent).toContain("Setup");
    expect(c.querySelectorAll(".prose ul li")).toHaveLength(2);
    expect(c.querySelectorAll(".prose ol li")).toHaveLength(2);
    expect(c.querySelector(".prose strong")!.textContent).toBe("bold");
    // An emoji is just a character — it must reach the text node untouched.
    expect(c.querySelector(".prose h1")!.textContent).toContain("🔥");
    expect(c.querySelector(".prose p")!.textContent).toContain("✅");
  });

  it("a fenced block with a language gets its label and a copy button", () => {
    const c = mountAssistant(REPLY);
    const block = c.querySelector("[data-code-block]");
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("js");
    expect(
      Array.from(block!.querySelectorAll("button")).some((b) =>
        /copy/i.test(b.textContent || ""),
      ),
    ).toBe(true);
  });

  it("links open off-site with rel=noopener noreferrer", () => {
    const a = mountAssistant(REPLY).querySelector(".prose a")!;
    expect(a.getAttribute("href")).toBe("https://example.com");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("rel")).toContain("noreferrer");
  });
});

describe("a reply cannot execute anything", () => {
  it("raw HTML in a message does not become elements or run", () => {
    const attack = [
      "Here is some text.",
      "",
      "<script>window.__renderContractPwned = true;</script>",
      "<img src=x onerror=\"window.__renderContractPwned = true\">",
    ].join("\n");
    const c = mountAssistant(attack);
    // No element was created from the raw HTML...
    expect(c.querySelector("script")).toBeNull();
    expect(document.querySelector(".prose script")).toBeNull();
    // ...and nothing ran. rehype-raw is what would make both false.
    expect(window.__renderContractPwned).toBeUndefined();
    // The markup is shown, inert, as text. This is the assertion a rehype-raw
    // mutant flips: once raw nodes become elements, the literal tags stop being
    // text at all, so this string cannot survive in the text content.
    expect(c.querySelector(".prose")!.textContent).toContain("<script>");
    // The surrounding prose still renders normally.
    expect(c.querySelector(".prose p")!.textContent).toContain("Here is some text.");
  });
});

describe("streaming a half-written reply does not break the renderer", () => {
  // Mid-stream a reply is routinely incomplete markdown: an open fence with no
  // close, a table whose delimiter row has not arrived. The renderer must show
  // the partial text rather than throw or blank the message.
  const PARTIAL = [
    "## Working on it",
    "",
    "So far I have:",
    "",
    "| Metric | Now |",
    "| --- | --- |",
    "| p50 | ",
    "",
    "```py",
    "def calculate():",
    "    return 1",
  ].join("\n");

  it("renders a partially streamed reply without throwing", () => {
    expect(() => mountAssistant(PARTIAL, true)).not.toThrow();
    const c = mountAssistant(PARTIAL, true);
    expect(c.querySelector(".prose")!.textContent).toContain("Working on it");
  });
});
