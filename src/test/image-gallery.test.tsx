// The in-chat image gallery: real retrieved pictures, shown as a gallery, with a
// source page each and no implied download rights.
//
// WHY THIS FILE EXISTS
//
// `search_images` is the feature whose failure mode is a lie: an image-search
// request answered with generated pictures, or with a wall of broken tiles, or with
// images the user cannot attribute. The provider-side tests prove the rows are real
// provider URLs; this file proves the UI shows them AS retrieved images — distinct
// from a generated one, each with a working source link, each able to fail on its
// own without taking the grid down.
//
// The assertions a mutant must break:
//   - rendering the gallery as a generated image (the `image-lightbox-backdrop`
//     surface) instead of the gallery's own grid;
//   - showing `imageUrl` in the tile instead of the cheaper `thumbnailUrl`;
//   - dropping `rel="noopener noreferrer"` from the source link (reverse-tabnabbing);
//   - turning a failed thumbnail into nothing instead of a source-preserving link.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: vi.fn() }));

import ChatMessage from "@/components/chat/ChatMessage";
import { resetArtifacts } from "@/components/artifacts/ArtifactProvider";
import type { MessageImage } from "@/components/chat/types";

const IMAGES: MessageImage[] = [
  {
    title: "Lenovo G500 front",
    thumbnailUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:AAA",
    imageUrl: "https://www.lenovo.com/medias/g500-front.jpg",
    pageUrl: "https://www.lenovo.com/us/en/p/laptops/g-series/g500/",
    source: "lenovo.com",
  },
  {
    title: "Lenovo G500 review",
    thumbnailUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:BBB",
    imageUrl: "https://m.media-amazon.com/images/I/71example.jpg",
    pageUrl: "https://www.amazon.com/dp/B00EXAMPLE",
    source: "amazon.com",
  },
];

function mount(images: MessageImage[] = IMAGES) {
  const { container } = render(
    <ChatMessage role="assistant" content="Here are some pictures:" modelName="Test" imageResults={images} />,
  );
  return container;
}

afterEach(() => resetArtifacts());

describe("the image gallery renders real retrieved pictures", () => {
  it("shows one tile per image, using the provider thumbnail (not the full image)", () => {
    const c = mount();
    expect(c.querySelector('[data-testid="image-gallery"]')).not.toBeNull();
    const tiles = c.querySelectorAll('[data-testid="image-gallery"] img');
    expect(tiles).toHaveLength(2);
    // The grid loads the small provider thumbnail; the original is reserved for the
    // lightbox. Using the full image here is the slow, hotlink-heavy mistake.
    expect((tiles[0] as HTMLImageElement).src).toBe(IMAGES[0].thumbnailUrl);
    expect((tiles[0] as HTMLImageElement).getAttribute("loading")).toBe("lazy");
  });

  it("is NOT rendered as a generated image", () => {
    const c = mount();
    // A generated image uses the image-lightbox surface; a searched one must not.
    expect(c.querySelector('[data-testid="image-lightbox-backdrop"]')).toBeNull();
  });

  it("attributes each image to its source page with a safe link", () => {
    const c = mount();
    const link = c.querySelector(
      'a[href="https://www.lenovo.com/us/en/p/laptops/g-series/g500/"]',
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("target")).toBe("_blank");
    // reverse-tabnabbing: the opened page could otherwise reach window.opener.
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});

describe("opening a picture larger", () => {
  it("opens the full image in a lightbox and closes on Escape and backdrop", () => {
    const c = mount();
    fireEvent.click(screen.getByRole("button", { name: /view lenovo g500 front larger/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const shown = screen.getByAltText(/lenovo g500 front, full size/i) as HTMLImageElement;
    expect(shown.src).toContain(IMAGES[0].imageUrl);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // Re-open and dismiss from the backdrop (not the image).
    fireEvent.click(screen.getByRole("button", { name: /view lenovo g500 front larger/i }));
    const backdrop = screen.getByTestId("image-gallery-lightbox");
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navigates between images with the arrow keys", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /view lenovo g500 front larger/i }));
    fireEvent.keyDown(document, { key: "ArrowRight" });
    const shown = screen.getByAltText(/lenovo g500 review, full size/i) as HTMLImageElement;
    expect(shown.src).toContain(IMAGES[1].imageUrl);
  });
});

describe("the full-size image can fail on its own", () => {
  // Measured, not hypothetical: a live probe (scripts/probe-image-search.mjs) of a
  // real "Lenovo G500 laptop" search found one of the first three originals answering
  // HTTP 403 text/html — a hotlink-protected host. The thumbnail from the provider's
  // cache loaded fine every time. So the lightbox must open the original and, when
  // that fails, show the picture the user already saw rather than a broken icon.
  it("falls back to the thumbnail when the original is hotlink-blocked", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /view lenovo g500 front larger/i }));
    const shown = screen.getByAltText(/lenovo g500 front, full size/i) as HTMLImageElement;
    expect(shown.src).toContain(IMAGES[0].imageUrl);

    fireEvent.error(shown);
    expect(shown.src).toBe(IMAGES[0].thumbnailUrl);

    // And a second failure — the thumbnail itself being dead — must not bounce back
    // to the original. Without that guard the two swap forever.
    fireEvent.error(shown);
    expect(shown.src).toBe(IMAGES[0].thumbnailUrl);
  });
});

describe("a row with no source page gets no link to nowhere", () => {
  // Tavily's image tier returns pictures with no `pageUrl`: it does not report which page
  // each image was found on, and inventing one would put a real attribution on the wrong
  // picture. On a keyless install those rows are the entire gallery, so this is not an
  // edge case. Both places a source link is rendered used to fall back to `href="#"` —
  // a control promising a source page that delivers the top of the current document.
  //
  // The host is still worth showing; it is the only attribution the row carries. It just
  // is not a link.
  const NO_PAGE: MessageImage[] = [
    {
      title: "Lenovo G500",
      thumbnailUrl: "https://www.bhphotovideo.com/images/fb/g500.jpg",
      imageUrl: "https://www.bhphotovideo.com/images/fb/g500.jpg",
      pageUrl: "",
      source: "bhphotovideo.com",
    },
  ];

  it("shows the host as plain text in the caption rather than an anchor to '#'", () => {
    const c = mount(NO_PAGE);
    const caption = c.querySelector('[data-testid="image-gallery"] figcaption');
    expect(caption?.textContent).toContain("bhphotovideo.com");
    expect(caption?.querySelector("a")).toBeNull();
  });

  it("does not offer 'View source' on a failed tile with nowhere to go", () => {
    const c = mount(NO_PAGE);
    fireEvent.error(c.querySelector('[data-testid="image-gallery"] img') as Element);
    const grid = c.querySelector('[data-testid="image-gallery"]') as HTMLElement;
    // The title survives — a dead tile still has to say what it was.
    expect(grid.textContent).toContain("Lenovo G500");
    // But nothing in the grid claims to be a link, and nothing offers to view a source.
    expect(grid.querySelector("a")).toBeNull();
    expect(grid.textContent).not.toMatch(/view source/i);
  });
});

describe("a failed thumbnail fails alone", () => {
  it("replaces the broken tile with a titled link to the source, keeping the rest", () => {
    const c = mount();
    const tiles = c.querySelectorAll('[data-testid="image-gallery"] img');
    fireEvent.error(tiles[0]);
    // The dead tile is now a link to its source page, not an empty box...
    const fallback = c.querySelector('a[href="https://www.lenovo.com/us/en/p/laptops/g-series/g500/"]');
    expect(fallback?.textContent).toContain("Lenovo G500 front");
    // ...and the second image is untouched.
    expect(c.querySelectorAll('[data-testid="image-gallery"] img')).toHaveLength(1);
  });
});
