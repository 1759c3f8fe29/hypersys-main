// A generated image has to be readable, and a 768px square in a chat column is not.
//
// Why this is the first thing in the "next gen" pass rather than a nicety: for an
// image turn the picture IS the answer, and the layout gave it the same weight as
// body text. On a phone the reply column is ~360px wide, so a generated image was
// shown at under half the size it was generated at, with no way to see it closer,
// no way to read text inside it, and nothing that said a bigger version existed.
// The download button saved the full-size file, which told the user the detail was
// there but not how to look at it.
//
// So: click opens a full-viewport lightbox over the conversation. The image is the
// whole surface, `object-contain` so nothing is cropped, and the two ways out
// everyone reaches for (Escape, and a click on the backdrop) both work. Focus goes
// onto the close button on open and back to the thumbnail on close, so the control
// is where a keyboard or screen-reader user already is.
//
// And the thumbnail has to look clickable. A generated image with no affordance is
// a picture the user has no reason to believe they can open, which is the state
// this replaces: `cursor-zoom-in` plus a hover overlay carry that on desktop, and
// the overlay also carries the one line of text that names what the control does.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: vi.fn() }));

import ChatMessage from "@/components/chat/ChatMessage";
import { resetArtifacts } from "@/components/artifacts/ArtifactProvider";

const IMAGE_URL = "https://image.pollinations.ai/prompt/a%20red%20car?nologo=true&model=flux&width=768&height=768";

function mountImage() {
  render(<ChatMessage role="assistant" content="Here it is:" imageUrl={IMAGE_URL} />);
  const thumb = screen.getByAltText<HTMLImageElement>("Generated image");
  const loaded = () => { fireEvent.load(thumb); return thumb; };
  return { thumb, loaded };
}

const open = () => fireEvent.click(screen.getByRole("button", { name: /view image full size/i }));

describe("viewing a generated image", () => {
  afterEach(() => resetArtifacts());

  it("opens it at full size when the picture is clicked", () => {
    const { loaded } = mountImage();
    loaded();
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The full-size copy is the same bytes, not a re-fetch: the URL is already the
    // 768px generation, and going back to the network here would pay a cold
    // generation (42s measured) for something the page already holds.
    const shown = screen.getByAltText("Generated image, full size") as HTMLImageElement;
    expect(shown.src).toContain(IMAGE_URL);
  });

  it("closes on Escape", () => {
    const { loaded } = mountImage();
    loaded();
    open();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on a click on the backdrop, but not on the image itself", () => {
    const { loaded } = mountImage();
    loaded();
    open();

    // A click on the picture must not dismiss it: that is the one place a user
    // clicks by accident while looking closely, and closing there makes the
    // feature feel broken.
    fireEvent.click(screen.getByAltText("Generated image, full size"));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByTestId("image-lightbox-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers a close button, and returns focus to the picture on close", () => {
    // Focus handling is the part a screenshot cannot show. Opening a full-screen
    // surface without moving focus leaves a keyboard user tabbing through the
    // conversation behind it; closing without restoring leaves them at the top of
    // the document, having lost the message they were reading.
    const { loaded } = mountImage();
    loaded();
    const trigger = screen.getByRole("button", { name: /view image full size/i });
    open();
    const close = screen.getByRole("button", { name: /close/i });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the download button reachable while the image is open", () => {
    // The lightbox is where a user decides they want the file. Sending them back
    // to the chat to save it, from the view that made them want it, is the kind of
    // gap that reads as unfinished.
    const { loaded } = mountImage();
    loaded();
    open();
    const dialog = screen.getByRole("dialog");
    // Scoped to the dialog on purpose: the thumbnail behind it still has its own
    // download control, and this assertion is about a download being reachable
    // *from the full-size view*, not about one existing somewhere on the page.
    expect(within(dialog).getByRole("button", { name: /download/i })).toBeTruthy();
  });

  it("labels the thumbnail's open control and marks it as a control", () => {
    const { thumb, loaded } = mountImage();
    loaded();
    // The accessible name is what a screen reader announces; the hint is what a
    // mouse user reads before clicking. Both are needed — an image with no
    // affordance is one nobody clicks.
    const trigger = screen.getByRole("button", { name: /view image full size/i });
    expect(trigger.contains(thumb) || trigger.getAttribute("aria-label")).toBeTruthy();
    expect(screen.getByText(/click to view full size/i)).toBeTruthy();
  });

  it("does not offer the zoom while the image is still loading", () => {
    // Control in the other direction: offering "view full size" over a spinner, or
    // over the failure card, promises something that is not there yet.
    mountImage();
    expect(screen.queryByRole("button", { name: /view image full size/i })).toBeNull();
  });
});
