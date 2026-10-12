// The byline that says who actually answered.
//
// WHAT THIS CATCHES
//
// The router announces the winning route on every response and nothing read it,
// so a reply written by a backup was presented under the picked model's name. The
// server half is pinned in api-wire-headers.test.ts and the derivation in
// served-attribution.test.ts; what this file pins is the RENDER — that the chip
// appears when there is something to say, stays out of the way when there is not,
// and never replaces the byline it is annotating.
//
// The specific mutants this kills:
//   - rendering the chip unconditionally (a "↩ Flyer" badge on every reply —
//     noise that trains the reader to ignore the notice when it is real);
//   - rendering the note as the visible label instead of the short name (the
//     chip is a badge, not a paragraph);
//   - dropping the sr-only sentence, which is the only way the full explanation
//     reaches a screen reader given that `title` does not);
//   - showing the tools warning on a reply whose route never lost them.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: vi.fn() }));

import ChatMessage from "@/components/chat/ChatMessage";
import { resetArtifacts } from "@/components/artifacts/ArtifactProvider";

const NOTE = "Answered by Qwen 3.8 27B on Groq. Flyer's first route didn't answer, so the request fell through to this one.";

/** The chip itself, found by its glyph rather than by [title]: another element
 *  growing a tooltip must not silently retarget these assertions. */
function chip(container: HTMLElement): HTMLElement | null {
  return [...container.querySelectorAll("span")].find((el) => el.textContent?.includes("↩")) ?? null;
}

function mount(extra: Record<string, unknown> = {}) {
  const { container } = render(
    <ChatMessage role="assistant" content="An answer." modelName="Flyer" {...extra} />,
  );
  return container;
}

afterEach(() => resetArtifacts());

describe("the failover chip", () => {
  it("renders nothing when the picked model answered", () => {
    // The common case. `servedName` is only ever set on a turn that failed over,
    // so its absence is the signal — and a chip here would be a permanent lie
    // about every ordinary reply.
    const c = mount();
    expect(chip(c)).toBeNull();
    expect(screen.queryByText("Qwen 3.8 27B")).toBeNull();
  });

  it("names the serving weights beside the byline", () => {
    const c = mount({ servedName: "Qwen 3.8 27B", servedNote: NOTE, servedBy: "groq" });
    expect(chip(c)?.textContent).toContain("Qwen 3.8 27B");
    // Additive, not a substitution: the byline still names the model the user
    // picked. Replacing it would read as "you asked for Qwen", which is the
    // opposite mistake.
    expect(c.textContent).toContain("Flyer");
  });

  it("carries the full sentence in title and in the accessible name", () => {
    const c = mount({ servedName: "Qwen 3.8 27B", servedNote: NOTE, servedBy: "groq" });
    expect(chip(c)?.getAttribute("title")).toBe(NOTE);
    // `title` is not announced reliably, so the chip's own text must carry the
    // explanation. Without this the chip reads as "↩ Qwen 3.8 27B" — a name with
    // no statement about what happened to the request.
    expect(screen.getByText(NOTE)).not.toBeNull();
  });

  it("supplies its own sentence when no note was stored", () => {
    // Rows written before the note was persisted still have a name. A screen
    // reader must not get a bare name there either.
    const c = mount({ servedName: "Qwen 3.8 27B" });
    expect(chip(c)?.textContent).toContain("Qwen 3.8 27B");
    expect(c.textContent).toContain("produced by Qwen 3.8 27B, not Flyer");
  });

  it("prefers the name over a note that disagrees with it", () => {
    // `servedName` is what the chip shows; the note is only ever the long form.
    // A mutant that renders the note as the label would put a full sentence in
    // the header row, where it would wrap and push the layout around.
    const c = mount({ servedName: "Ministral 8B", servedNote: NOTE });
    const el = chip(c);
    expect(el?.textContent).toContain("Ministral 8B");
    expect(el?.textContent).not.toBe(NOTE);
    expect(el?.getAttribute("title")).toBe(NOTE);
  });
});

describe("the lost-tools warning", () => {
  it("is shown when the serving route could not take tools", () => {
    // The half of the defect that is worse than misattribution: the turn could
    // not search, read a file or run code, and with no line saying so that is
    // indistinguishable from the model choosing not to.
    const c = mount({ servedName: "Pollinations route", toolsWithheld: true });
    expect(c.textContent).toContain("Tools were unavailable on this reply");
  });

  it("is absent on a reply that kept its tools", () => {
    const c = mount({ servedName: "Qwen 3.8 27B", servedNote: NOTE });
    expect(c.textContent).not.toContain("Tools were unavailable");
  });

  it("is absent on an ordinary reply", () => {
    const c = mount();
    expect(c.textContent).not.toContain("Tools were unavailable");
  });
});
