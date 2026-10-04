// "Try again" on a failed image, and whether it can ever produce a new image.
//
// The button has always *looked* right: it remounts the <img> with a changed key
// and adds a cache-buster, and both of those are real. What it did not do is
// change the bytes the server sends back, because the buster it used was
// `retry=${attempt}` and the Pollinations cache keys an unknown param on its
// presence, not its value (the numbers are in `src/lib/image-url.ts` — retry=1,
// 2, 3 and 99 all return one identical response).
//
// That makes this a defect with a very specific shape, and the shape is what the
// component tests below pin: press one gets fresh bytes, and **every press after
// it replays press one**. If press one happened to fail too — the common case,
// since the user is pressing a button that appeared because generation failed —
// the button is dead for the rest of the message's life while still animating,
// still re-mounting, still looking like it did something.
//
// So "the src changed" is not the assertion. "The src changed *in a way the
// server distinguishes*, and differently on each press" is.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
// A rendered reply can contain a code block, whose Run button wires to Pyodide
// (~10 MB of WASM on first call). Nothing here clicks it; the mock keeps a stray
// call from making this file slow or networked.
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: vi.fn() }));

import ChatMessage from "@/components/chat/ChatMessage";
import { freshSeed, retryImageUrl } from "@/lib/image-url";

// The shape `generateImageResponse` actually builds (src/lib/ai.ts).
const IMAGE_URL =
  "https://image.pollinations.ai/prompt/a%20red%20car,%20studio%20light" +
  "?nologo=true&model=flux&width=768&height=768";

function seedOf(src: string | null): string | null {
  if (!src) return null;
  return new URL(src).searchParams.get("seed");
}

/** Renders a reply carrying a generated image and returns the live <img>. */
function mountWithImage(url = IMAGE_URL) {
  render(<ChatMessage role="assistant" content="Here it is:" imageUrl={url} />);
  return () => screen.getByAltText("Generated image") as HTMLImageElement;
}

/** Fails the current <img> and presses the button that appears. */
function failAndRetry(img: () => HTMLImageElement) {
  fireEvent.error(img());
  fireEvent.click(screen.getByRole("button", { name: /try again/i }));
}

describe("retryImageUrl", () => {
  it("sets a seed on a URL that has none, leaving the rest of the request alone", () => {
    const out = new URL(retryImageUrl(IMAGE_URL, 12345));
    expect(out.searchParams.get("seed")).toBe("12345");
    // Control: the parameters that decide *what* is generated must survive, or
    // the retry quietly returns a differently-sized image of something else.
    expect(out.searchParams.get("model")).toBe("flux");
    expect(out.searchParams.get("width")).toBe("768");
    expect(out.searchParams.get("height")).toBe("768");
    expect(out.searchParams.get("nologo")).toBe("true");
    expect(out.pathname).toBe("/prompt/a%20red%20car,%20studio%20light");
  });

  it("replaces an existing seed instead of appending a second one", () => {
    // Two seeds in one query leaves the winner up to the server, so a second
    // press would be a coin flip rather than a new image.
    const once = retryImageUrl(IMAGE_URL, 1);
    const twice = retryImageUrl(once, 2);
    expect(twice.match(/seed=/g)?.length).toBe(1);
    expect(seedOf(twice)).toBe("2");
  });

  it("leaves a data: URL untouched — there is no cache to bust and a re-serialise corrupts it", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    expect(retryImageUrl(data, 7)).toBe(data);
  });

  it("returns the input unchanged rather than throwing on something unparseable", () => {
    expect(retryImageUrl("not a url", 7)).toBe("not a url");
  });
});

describe("freshSeed", () => {
  it("starts somewhere inside the 32-bit range rather than at a shared constant", () => {
    // Everyone retrying the same prompt walks the same seed namespace, so a
    // constant start serves whatever `seed=1` already cached — possibly the
    // failure the retry is trying to escape.
    const seeds = Array.from({ length: 20 }, freshSeed);
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(2 ** 31);
    }
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

describe("the Try again button", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // seed base = 2^30, stable
  });

  it("asks for the image with no seed on the first load", () => {
    // Control, and the reason the buster is retry-only: a seed on the *first*
    // request would miss the cache every time, so reopening a conversation would
    // pay a cold generation (42s measured) for an image it already has (286ms).
    const img = mountWithImage();
    expect(img().getAttribute("src")).toBe(IMAGE_URL);
  });

  it("re-requests with a seed — the one parameter the host keys by value", () => {
    const img = mountWithImage();
    failAndRetry(img);
    const src = img().getAttribute("src");
    expect(seedOf(src)).not.toBeNull();
    // The buster it replaced. `retry=N` is byte-identical for every N, so its
    // presence here would mean the press changed nothing the server can see.
    expect(src).not.toContain("retry=");
  });

  it("sends a different seed on every press, not just the first", () => {
    // The whole defect: the old buster's second press replayed its first. A
    // single press looked identical under both implementations.
    const img = mountWithImage();
    failAndRetry(img);
    const first = seedOf(img().getAttribute("src"));
    failAndRetry(img);
    const second = seedOf(img().getAttribute("src"));
    failAndRetry(img);
    const third = seedOf(img().getAttribute("src"));

    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("keeps the prompt and the canvas across a retry", () => {
    const img = mountWithImage();
    failAndRetry(img);
    const out = new URL(img().getAttribute("src")!);
    expect(out.pathname).toBe("/prompt/a%20red%20car,%20studio%20light");
    expect(out.searchParams.get("width")).toBe("768");
    expect(out.searchParams.get("height")).toBe("768");
  });

  it("recovers the image view when the retried request succeeds", () => {
    // Control that the retry path is not just a URL exercise: a load after a
    // failure has to put the picture back, not leave the error card up.
    const img = mountWithImage();
    failAndRetry(img);
    fireEvent.load(img());
    expect(screen.queryByText(/didn’t come through/)).toBeNull();
    expect(screen.getByRole("button", { name: /download image/i })).toBeTruthy();
  });
});
