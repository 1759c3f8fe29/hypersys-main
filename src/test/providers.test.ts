// Invariants for the model catalogue in src/lib/providers.ts.
//
// These guard the product promise that the model you pick is the model that
// answers. The catalogue had drifted into two disagreeing halves — a picker
// array in the sidebar and a router catalogue here — and three entries whose
// names did not match the weights behind them. The duplicate-upstream-id test
// below fails on exactly that class of bug.

import { describe, it, expect } from "vitest";

// Two views of the same set, on purpose. `FAILOVER_STATUSES` as api/llm.js
// re-exports it — the production request path — and the shared definition both it
// and providers.ts import. The test below asserts they are one object.
import { FAILOVER_STATUSES } from "../../api/llm.js";
import { FAILOVER_STATUSES as SHARED_FAILOVER_STATUSES } from "../../api/_failover.js";

import {
  MODELS,
  SELECTABLE_MODELS,
  PROVIDERS,
  DEFAULT_MODEL_ID,
  UTILITY_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  DEFAULT_VISION_MODEL_ID,
  IMAGE_FALLBACK_CHAIN,
  getModel,
  canonicalModelId,
  isImageModel,
  shouldFailover,
} from "@/lib/providers";

describe("model catalogue", () => {
  it("has no duplicate ids", () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("gives every model at least one route", () => {
    for (const model of MODELS) {
      expect(model.routes.length, `${model.id} has no routes`).toBeGreaterThan(0);
    }
  });

  it("routes every model to a provider that exists", () => {
    for (const model of MODELS) {
      for (const route of model.routes) {
        expect(PROVIDERS[route.provider], `${model.id} -> ${route.provider}`).toBeDefined();
      }
    }
  });

  // THE aliasing bug: "llama-4-maverick" and "qwen-3-next-80b" were distinct
  // picker entries that both resolved to meta/llama-3.1-70b-instruct. Two names
  // for one set of weights means at least one of them is lying about what
  // answered. A model may have several routes — same weights on another
  // provider, or (since 2026-09-06) a fallback leg as insurance, as on the
  // default model's NIM chain — but two different models must never share an
  // upstream id as each other's *primary*. A fallback leg borrowing another
  // entry's primary answers under a service name ("Flyer" names the default
  // experience, not weights), so it is not the lie this test exists to catch:
  // the lie is a weights-named entry whose own first answer comes from weights
  // wearing a different entry's name.
  it("never points two models at the same upstream model id as primary", () => {
    const owner = new Map<string, string>();
    for (const model of MODELS) {
      const route = model.routes[0];
      const key = `${route.provider}:${route.modelId}`;
      const existing = owner.get(key);
      expect(
        existing ?? model.id,
        `${key} is claimed by both "${existing}" and "${model.id}"`,
      ).toBe(model.id);
      owner.set(key, model.id);
    }
    // CONTROL: the loop above must actually walk the catalogue. An emptied
    // loop would leave this test green on a pass-through run (the seeded
    // control below passes on its own) — found by mutation-check on
    // 2026-09-06, where `for (const model of [])` survived 15/15. A passing
    // run has all primaries distinct, so owner holds one claim per model.
    expect(owner.size, "the guard must walk every model in the catalogue").toBe(
      MODELS.length,
    );
    // CONTROL: this matcher has teeth. A catalogue seeded with the original
    // shape of the bug — two weights-named entries sharing one primary — must
    // still trip it, or the narrowing above went too far. This is exactly the
    // 3.10 bug: two distinct picker names, one set of weights answering for
    // both.
    const seeded = [
      { id: "llama-4-maverick", routes: [{ provider: "nvidia", modelId: "meta/llama-3.1-70b-instruct" }] },
      { id: "qwen-3-next-80b", routes: [{ provider: "nvidia", modelId: "meta/llama-3.1-70b-instruct" }] },
    ];
    const seededOwner = new Map<string, string>();
    let tripped = false;
    for (const model of seeded) {
      const route = model.routes[0];
      const key = `${route.provider}:${route.modelId}`;
      const existing = seededOwner.get(key);
      if (existing && existing !== model.id) {
        tripped = true;
        break;
      }
      seededOwner.set(key, model.id);
    }
    expect(tripped, "seeded alias catalogue must trip the primary-route guard").toBe(true);
  });

  // The default model's chain, re-pinned 2026-09-07: glm-5.3-free first (fast
  // first message — 2.9s bare / 2.2s with tools, measured), Mistral Nemo second
  // (user direction), flash LAST (144s bare TTFB, wedges with tools — only the
  // last position, with its isLastRoute budget relaxation, can carry it). Order
  // is the promise here — the user named which model answers first — so the
  // assertion is an exact array, not a set.
  it("walks the default model's fallback chain in the user's order", () => {
    const spec = getModel(DEFAULT_MODEL_ID)!;
    expect(spec.routes.map((r) => r.modelId)).toEqual([
      "z-ai/glm-5.3-free",
      "open-mistral-nemo",
      "deepseek-ai/deepseek-v4-flash-0731",
    ]);
    expect(spec.routes.map((r) => r.provider)).toEqual([
      "tokenrouter",
      "mistral",
      "nvidia",
    ]);
  });

  it("gives every model the presentation fields the picker needs", () => {
    for (const model of MODELS) {
      expect(model.emoji, `${model.id} has no emoji`).toBeTruthy();
      expect(["Chat", "Vision", "Image"]).toContain(model.kind);
      expect(model.label, `${model.id} has no label`).toBeTruthy();
      expect(model.description, `${model.id} has no description`).toBeTruthy();
    }
  });

  it("keeps hidden models out of the picker but reachable by id", () => {
    expect(SELECTABLE_MODELS.every((m) => !m.hidden)).toBe(true);
    // The utility model is hidden and must still resolve — it serves titles.
    expect(getModel(UTILITY_MODEL_ID)).toBeDefined();
    expect(SELECTABLE_MODELS.some((m) => m.id === UTILITY_MODEL_ID)).toBe(false);
  });

  it("resolves every named default", () => {
    for (const id of [
      DEFAULT_MODEL_ID,
      UTILITY_MODEL_ID,
      DEFAULT_IMAGE_MODEL_ID,
      DEFAULT_VISION_MODEL_ID,
    ]) {
      expect(getModel(id), `default "${id}" is not in the catalogue`).toBeDefined();
    }
  });

  it("has a fully resolvable image fallback chain", () => {
    expect(IMAGE_FALLBACK_CHAIN.length).toBeGreaterThan(1);
    for (const id of IMAGE_FALLBACK_CHAIN) {
      expect(getModel(id), `image fallback "${id}" is missing`).toBeDefined();
      expect(isImageModel(id), `"${id}" is not an Image model`).toBe(true);
    }
    // The keyless provider must be in the chain, or a rate-limited NVIDIA takes
    // image generation down entirely.
    const hasKeyless = IMAGE_FALLBACK_CHAIN.some((id) =>
      getModel(id)!.routes.some((r) => PROVIDERS[r.provider].keyless),
    );
    expect(hasKeyless).toBe(true);
  });

  it("does not offer a tools-only capability on the keyless fallback", () => {
    // Pollinations' OpenAI surface has no tools support; claiming otherwise
    // would send a tools payload that comes back 400 and burns the last route.
    const pollinationsModels = MODELS.filter((m) =>
      m.routes.every((r) => r.provider === "pollinations"),
    );
    for (const model of pollinationsModels) {
      expect(model.supportsTools, `${model.id} cannot support tools`).toBe(false);
    }
  });
});

describe("getModel", () => {
  it("returns undefined for an unknown id rather than guessing", () => {
    expect(getModel("not-a-model")).toBeUndefined();
    expect(getModel("")).toBeUndefined();
    expect(canonicalModelId("not-a-model")).toBeUndefined();
  });

  // The legacy alias map (LEGACY_MODEL_IDS) was removed in 3.12: an id that is
  // not in the catalogue resolves to nothing, by design. This pins that no
  // alias-layer resurrection slips back in under a different name.
  it("does not resolve ids from the removed legacy alias layer", () => {
    expect(getModel("mistral-large-2512")).toBeUndefined();
    expect(getModel("Flyer AI")).toBeUndefined();
    expect(getModel("pixtral-12b")).toBeUndefined();
  });
});

describe("shouldFailover", () => {
  it("fails over on transient provider trouble", () => {
    for (const status of [404, 429, 500, 502, 503, 504, 529]) {
      expect(shouldFailover(status), `${status} should fail over`).toBe(true);
    }
  });

  // Failing over on these hides a broken request or a rejected key behind a backup
  // that quietly works, so the fault never surfaces.
  //
  // 404 was in this list until 3.11 and has moved to the failover list above. It is
  // not a configuration fault on the provider this catalogue mostly runs on: NVIDIA
  // returned 404 three times running for an id that answered three times minutes
  // later. api/_failover.js carries the evidence and the argument for why the
  // "quietly working backup" worry does not apply to it.
  it("does not fail over on configuration faults", () => {
    for (const status of [400, 401, 403]) {
      expect(shouldFailover(status), `${status} must not fail over`).toBe(false);
    }
  });

  // shouldFailover() is NOT what runs in production — the routing chain lives in
  // the serverless proxy, api/llm.js. It used to keep its own hand-copied
  // FAILOVER_STATUSES; the comment there claimed it "mirrored" this function and
  // nothing checked that, so every assertion above was exercising a copy of the
  // rule that no request ever reaches. Worse than no coverage: it reads as
  // confidence.
  //
  // The duplication is gone. Both sides now import api/_failover.js, so the
  // range-walking drift test that used to live here would compare a set against
  // itself and pass no matter what. This replaces it with the property that still
  // has teeth: they must be the *same object*. Re-introduce a local copy in either
  // file — the exact regression the old comment warned about — and this fails,
  // even if the two copies happen to agree on the day it is written.
  it("uses the very same failover set as the proxy, not a copy of it", () => {
    const viaProviders = new Set(
      Array.from({ length: 200 }, (_, i) => 400 + i).filter(shouldFailover),
    );
    expect(viaProviders).toEqual(FAILOVER_STATUSES);

    // Object identity is the part a value comparison cannot give us: two separately
    // written sets can be equal today and diverge tomorrow.
    expect(SHARED_FAILOVER_STATUSES).toBe(FAILOVER_STATUSES);
  });
});
