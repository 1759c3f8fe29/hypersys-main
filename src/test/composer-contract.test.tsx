// The contractible composer.
//
// The reference shape is a single-row pill — attach, one-line composer, inline
// mode toggle, mic, send — that contracts to its tightest form whenever it is
// empty and expands only as content demands. These tests pin the three things
// a later restyle would silently undo: the pill/panel radius swap, the single
// shared row (the old bar stacked the textarea over a controls row, which is
// exactly the height the contract removes), and the inline Think toggle that
// replaced the menu-only DeepThink entry.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import ChatInput from "@/components/chat/ChatInput";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function mount(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const onSend = vi.fn();
  const onToggleDeepThink = vi.fn();
  const utils = render(
    <ChatInput onSend={onSend} isLoading={false} onToggleDeepThink={onToggleDeepThink} {...props} />,
  );
  const pill = utils.container.querySelector(".liquid-composer") as HTMLElement;
  const composer = screen.getByRole("textbox", { name: /message input/i });
  return { onSend, onToggleDeepThink, pill, composer, ...utils };
}

const pick = (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
};

describe("the contractible pill", () => {
  it("rests as a one-line pill when empty", () => {
    const { pill } = mount();
    expect(pill.className).toContain("rounded-full");
  });

  it("stays contracted while focused but empty — the caret is not content", () => {
    // The reference shape is a *focused* empty pill: caret in, controls inline,
    // still one tight line. Keying the contract on blur instead would mean the
    // composer pops open the moment it is touched, which is the opposite of
    // contracting.
    const { pill, composer } = mount();
    fireEvent.focus(composer);
    expect(pill.className).toContain("rounded-full");
  });

  it("expands into a panel once a draft arrives, and contracts again when it leaves", () => {
    const { pill, composer } = mount();
    fireEvent.change(composer, { target: { value: "a draft" } });
    expect(pill.className).not.toContain("rounded-full");
    expect(pill.className).toContain("rounded-2xl");

    fireEvent.change(composer, { target: { value: "" } });
    expect(pill.className).toContain("rounded-full");
  });

  it("expands for an attachment even before any text", () => {
    // A preview row sits above the input row, so an attached file is content
    // even with an empty textarea — the pill must not swallow it.
    const { pill, container } = mount();
    pick(container.querySelector('input[type="file"]') as HTMLInputElement, [
      new File(["x"], "notes.md", { type: "text/markdown" }),
    ]);
    expect(pill.className).not.toContain("rounded-full");
  });
});

describe("the single row", () => {
  it("keeps the composer and every control on one shared row", () => {
    const { composer } = mount();
    const send = screen.getByRole("button", { name: /send message/i });
    // The shared flex row is the whole contract: the old bar stacked a controls
    // row under a full-width textarea, and in that layout the field and the
    // buttons had no common row at all — so resolving both to the same one is
    // what a restack cannot survive. The row is found by its baseline
    // alignment, which is the class that makes it a row of controls rather
    // than a stack; the buttons sit one grouping div under it, the field one
    // growing-wrapper div under it, and both wrappers are the row's children.
    const row = composer.closest("div.items-end");
    expect(row).not.toBeNull();
    expect(send.closest("div.items-end")).toBe(row);
    expect(row?.contains(screen.getByRole("button", { name: /more options/i }))).toBe(true);
    expect(row?.contains(screen.getByRole("button", { name: "DeepThink" }))).toBe(true);
  });
});

describe("the inline Think toggle", () => {
  it("toggles DeepThink from the row instead of the menu", () => {
    const { onToggleDeepThink } = mount();
    fireEvent.click(screen.getByRole("button", { name: "DeepThink" }));
    expect(onToggleDeepThink).toHaveBeenCalledTimes(1);
  });

  it("reports the enabled state on the chip", () => {
    mount({ deepThink: true });
    expect(screen.getByRole("button", { name: "DeepThink" })).toHaveAttribute("aria-pressed", "true");
  });

  it("drops DeepThink from the + menu now that the row owns it", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /more options/i }));
    expect(screen.queryByRole("menuitemcheckbox", { name: /deepthink/i })).toBeNull();
    // Control: the menu did not lose everything along with it.
    expect(screen.getByRole("menuitem", { name: /attach/i })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: /search/i })).toBeTruthy();
  });
});