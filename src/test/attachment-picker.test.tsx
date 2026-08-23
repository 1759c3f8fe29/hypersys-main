// The composer's attachment gate.
//
// This pins the two halves of one change: the file picker no longer filters by
// extension, and because it no longer filters, something has to stop a 4 GB disk
// image from reaching a base64 encoder.
//
// Both are the kind of thing a later tidy-up reverts in good faith. `accept` looks
// like a missing attribute rather than a deliberate absence, and a size ceiling in
// a UI component looks like it belongs in the read path — which is exactly where it
// does not belong, because the read path is bounded already (documents.ts reads
// from slices) and the thing that is not bounded is the data URL every attachment
// becomes for the preview and the saved transcript.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import ChatInput from "@/components/chat/ChatInput";

const errors = vi.hoisted(() => [] as string[]);
vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => errors.push(m),
    warning: () => {},
    success: () => {},
    message: () => {},
  },
}));

/** A File of a given size without allocating it: only `size` is ever read. */
function sizedFile(name: string, bytes: number, type = "application/octet-stream"): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

function mount() {
  const onSend = vi.fn();
  const { container } = render(<ChatInput onSend={onSend} isLoading={false} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  return { onSend, input, container };
}

/** What the browser does on a pick: set `files`, then fire change. */
function pick(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  errors.length = 0;
});

describe("the file picker", () => {
  // It used to carry a closed list of 18 extensions, which was narrower than the
  // extractor in the same commit (~40 text extensions then, any file now) — so a
  // .yaml could not be picked from the dialog while dragging the identical file in
  // worked, because `accept` filters the dialog and nothing else.
  it("filters nothing, because the reader reads anything", () => {
    const { input } = mount();
    expect(input.hasAttribute("accept")).toBe(false);
    expect(input.multiple).toBe(true);
  });

  it("accepts the file types the old allowlist excluded", () => {
    const { input, container } = mount();
    pick(input, [
      sizedFile("deploy.yaml", 400),
      sizedFile("Dockerfile", 300),
      sizedFile("main.go", 900),
      sizedFile("notes.zqx", 120),
    ]);
    for (const name of ["deploy.yaml", "Dockerfile", "main.go", "notes.zqx"]) {
      expect(container.textContent).toContain(name);
    }
    expect(errors).toEqual([]);
  });
});

describe("the attachment size ceiling", () => {
  it("refuses a file too large to carry, naming both sizes", () => {
    const { input, container } = mount();
    pick(input, [sizedFile("movie.mkv", 900 * 1024 * 1024)]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("movie.mkv");
    expect(errors[0]).toContain("900 MB"); // what they tried to send
    expect(errors[0]).toContain("25 MB"); // and the limit
    expect(container.textContent).not.toContain("movie.mkv");
  });

  it("keeps the rest of the selection, rather than dropping all of it", () => {
    // Refusing four readable files because the fifth was a video is a worse
    // outcome than reading four and saying why the fifth was skipped.
    const { input, container } = mount();
    pick(input, [
      sizedFile("report.pdf", 2 * 1024 * 1024),
      sizedFile("huge.iso", 4 * 1024 * 1024 * 1024),
      sizedFile("data.csv", 5_000),
    ]);

    expect(container.textContent).toContain("report.pdf");
    expect(container.textContent).toContain("data.csv");
    expect(container.textContent).not.toContain("huge.iso");
    expect(errors).toHaveLength(1);
  });

  it("allows a large-but-real document", () => {
    // A 400-page PDF is ~10 MB and a phone photo ~5 MB. The ceiling has to sit
    // above the files people actually attach or it is just the old allowlist again
    // in a different unit.
    const { input, container } = mount();
    pick(input, [sizedFile("thesis.pdf", 20 * 1024 * 1024, "application/pdf")]);
    expect(errors).toEqual([]);
    expect(container.textContent).toContain("thesis.pdf");
  });
});
