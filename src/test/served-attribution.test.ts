// Who actually answered: the router says so on every response, and until now
// nothing read it.
//
// THE DEFECT THIS COVERS
//
// api/llm.js walks a model's route chain and streams from the first route that
// answers, announcing the winner as X-Served-By / X-Served-Model. A grep for
// either name across src/ returned nothing. So a reply written by Qwen's weights
// was presented under the byline "Flyer", and — because api/_providers.js strips
// `tools` for a provider that cannot accept them — a turn that fell through to
// Pollinations answered in prose with no search, no files and no code, while the
// client still believed tools were on. That second half is the worse one: the
// model looked like it had chosen not to use a capability it never had.
//
// The wire half is pinned in api-wire-headers.test.ts. This file is the
// derivation: given the pair the server sent, which leg of the chain was it, what
// is it called, and did the turn lose its tools on the way.

import { describe, it, expect } from "vitest";

import { readServedLeg, describeAttribution } from "@/lib/attribution";
import { DEFAULT_MODEL_ID, MODELS } from "@/lib/providers";
import { toTreeMessages } from "@/lib/message-tree";
import { SERVED_BY_HEADER, SERVED_MODEL_HEADER } from "../../api/_headers.js";

const headersOf = (provider?: string, modelId?: string): Headers =>
  new Headers({
    ...(provider ? { [SERVED_BY_HEADER]: provider } : {}),
    ...(modelId ? { [SERVED_MODEL_HEADER]: modelId } : {}),
  });

// The default's two legs, read from the catalogue rather than typed here: if the
// chain is ever re-ordered these tests must describe the new chain, not the old
// one. `served-attribution.test.ts` asserting a literal "qwen/qwen3.8-27b" would
// go on passing while the catalogue moved.
const DEFAULT_ROUTES = MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!.routes;
const PRIMARY = DEFAULT_ROUTES[0];
const BACKUP = DEFAULT_ROUTES[1];

describe("readServedLeg", () => {
  it("reads the pair off a response", () => {
    expect(readServedLeg(headersOf("groq", "qwen/qwen3.8-27b"))).toEqual({
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
  });

  it("returns null when the server reported nothing", () => {
    // An older deployment, or a cross-origin call whose headers were not exposed.
    // Null is the instruction to claim nothing — guessing here is how the pre-fix
    // behaviour (crediting the picked model) would come back in through a
    // side door.
    expect(readServedLeg(new Headers())).toBeNull();
    expect(readServedLeg(undefined)).toBeNull();
    expect(readServedLeg(null)).toBeNull();
  });

  it("returns null for a half pair", () => {
    expect(readServedLeg(headersOf("groq", undefined))).toBeNull();
    expect(readServedLeg(headersOf(undefined, "qwen/qwen3.8-27b"))).toBeNull();
    // Empty strings are not a leg either: a proxy that blanked a header must not
    // render as "answered by ".
    expect(readServedLeg(headersOf("", ""))).toBeNull();
  });
});

describe("describeAttribution", () => {
  it("says nothing when the named weights answered", () => {
    // The common case, and silence is the point: a badge on every reply is noise,
    // and noise is how a real notice stops being read.
    const a = describeAttribution(DEFAULT_MODEL_ID, { provider: PRIMARY.provider, modelId: PRIMARY.modelId });
    expect(a).not.toBeNull();
    expect(a!.sameLeg).toBe(true);
    expect(a!.legIndex).toBe(0);
    expect(a!.note).toBe("");
    expect(a!.servedName).toBe(MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!.label);
  });

  it("names the backup when the backup answered", () => {
    const a = describeAttribution(DEFAULT_MODEL_ID, { provider: BACKUP.provider, modelId: BACKUP.modelId });
    expect(a!.sameLeg).toBe(false);
    expect(a!.legIndex).toBe(1);
    // The route's own label, never the entry's name. "Flyer" answering from these
    // weights is exactly the misattribution this module exists to undo.
    expect(a!.servedName).toBe(BACKUP.label);
    expect(a!.servedName).not.toBe(MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!.label);
    expect(a!.note).toContain(BACKUP.label!);
    expect(a!.note).toContain(MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!.label);
    expect(a!.note.length).toBeGreaterThan(20);
  });

  it("names the provider, and claims no more, for a route outside the chain", () => {
    // Two ways to get here: a route added to the catalogue after this client was
    // built, or a hand-edited response. Both must produce something true.
    const a = describeAttribution(DEFAULT_MODEL_ID, { provider: "acme", modelId: "acme/whatever" });
    expect(a!.sameLeg).toBe(false);
    expect(a!.legIndex).toBe(-1);
    expect(a!.servedName).toBe("acme route");
    expect(a!.note).toContain("acme");
  });

  it("survives an unknown model id", () => {
    // A stored conversation can name a model that has since left the catalogue
    // (see flyer-bylines-are-denormalized-per-message). This must not throw
    // inside a render.
    const a = describeAttribution("retired-model-id", { provider: "nvidia", modelId: "x/y" });
    expect(a).not.toBeNull();
    expect(a!.legIndex).toBe(-1);
    expect(a!.note).toContain("retired-model-id");
  });

  it("returns null when there is nothing to describe", () => {
    expect(describeAttribution(DEFAULT_MODEL_ID, null)).toBeNull();
  });

  it("reports tools withheld only on a turn that advertised them", () => {
    // Derived, not announced: the server's gate is `!cfg.supportsTools` in
    // routePayloadFor, and the client holds the same per-provider flags. The
    // point of deriving is that the two cannot disagree about whether tools
    // could have gone out.
    const withheld = describeAttribution(
      DEFAULT_MODEL_ID,
      { provider: "pollinations", modelId: "openai" },
      { toolsAdvertised: true },
    );
    expect(withheld!.toolsWithheld).toBe(true);

    // Same route, no tools requested: the absence was the client's decision, and
    // blaming the route for it would be a false alarm.
    const notAsked = describeAttribution(
      DEFAULT_MODEL_ID,
      { provider: "pollinations", modelId: "openai" },
      { toolsAdvertised: false },
    );
    expect(notAsked!.toolsWithheld).toBe(false);

    // A tool-capable route never reports it, however the turn was built.
    const capable = describeAttribution(
      DEFAULT_MODEL_ID,
      { provider: PRIMARY.provider, modelId: PRIMARY.modelId },
      { toolsAdvertised: true },
    );
    expect(capable!.toolsWithheld).toBe(false);

    // Omitted opts means "unknown", which must read as no claim rather than as
    // true — an attribution that invents a lost capability is as wrong as one
    // that hides a real one.
    const unknown = describeAttribution(DEFAULT_MODEL_ID, { provider: "pollinations", modelId: "openai" });
    expect(unknown!.toolsWithheld).toBe(false);
  });
});

describe("the failover case is constructible", () => {
  it("the default chain has a second leg with different weights", () => {
    // Without this, every test above about leg 1 is a test of a premise that
    // cannot occur — the shape that lets an assertion pass forever while the
    // thing it describes is unreachable.
    expect(DEFAULT_ROUTES.length).toBeGreaterThan(1);
    expect(BACKUP.modelId).not.toBe(PRIMARY.modelId);
    expect(BACKUP.provider).not.toBe(PRIMARY.provider);
  });

  it("every non-primary leg states a label", () => {
    // The name a failover is reported under. A leg without one falls back to
    // "<provider> route", which is honest but says almost nothing; this is where
    // that fallback is kept unreachable-by-accident.
    for (const model of MODELS) {
      model.routes.slice(1).forEach((route, i) => {
        expect(
          route.label,
          `${model.id} route ${i + 1} (${route.provider}/${route.modelId}) has no label, so a failover to it cannot be named`,
        ).toBeTruthy();
      });
    }
  });
});

describe("a reloaded reply keeps saying who answered", () => {
  const row = {
    id: "m1",
    role: "assistant" as const,
    content: "hello",
    createdAt: "2026-10-12T00:00:00.000Z",
    servedBy: "groq",
    servedName: "Qwen 3.8 27B",
    servedNote: "Answered by Qwen 3.8 27B on Groq.",
    toolsWithheld: true,
  };

  it("carries the four fields through the tree mapping", () => {
    // toTreeMessages maps field by field rather than spreading the row, so a new
    // message field is dropped on reload unless it is added here. An attribution
    // that vanishes on refresh is worse than none: the byline silently goes back
    // to naming the wrong model.
    const [msg] = toTreeMessages([row]) as Array<Record<string, unknown>>;
    expect(msg.servedBy).toBe("groq");
    expect(msg.servedName).toBe("Qwen 3.8 27B");
    expect(msg.servedNote).toBe("Answered by Qwen 3.8 27B on Groq.");
    expect(msg.toolsWithheld).toBe(true);
  });

  it("invents nothing for a reply the picked model wrote", () => {
    const [msg] = toTreeMessages([
      { id: "m2", role: "assistant" as const, content: "hi", createdAt: "2026-10-12T00:00:00.000Z" },
    ]) as Array<Record<string, unknown>>;
    expect(msg.servedName).toBeUndefined();
    expect(msg.toolsWithheld).toBeUndefined();
  });
});
