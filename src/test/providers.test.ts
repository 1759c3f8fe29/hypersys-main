// Invariants for the model catalogue in src/lib/providers.ts.
//
// These guard the product promise that the model you pick is the model that
// answers. The catalogue had drifted into two disagreeing halves — a picker
// array in the sidebar and a router catalogue here — and three entries whose
// names did not match the weights behind them. The duplicate-upstream-id test
// below fails on exactly that class of bug.

import { describe, it, expect } from "vitest";

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
  // answered. A model may have several routes (same model, different provider),
  // but two *different* models must never share an upstream id.
  it("never points two models at the same upstream model id", () => {
    const owner = new Map<string, string>();
    for (const model of MODELS) {
      for (const route of model.routes) {
        const key = `${route.provider}:${route.modelId}`;
        const existing = owner.get(key);
        expect(
          existing ?? model.id,
          `${key} is claimed by both "${existing}" and "${model.id}"`,
        ).toBe(model.id);
        owner.set(key, model.id);
      }
    }
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

  it("resolves ids persisted by older versions", () => {
    // Conversations in Firestore still carry these.
    expect(canonicalModelId("mistral-large-latest")).toBe("mistral-large");
    expect(canonicalModelId("nemotron-3-ultra-550b")).toBe("nemotron-ultra");
    expect(canonicalModelId("Flyer AI")).toBe("mistral-large");
  });

  it("resolves the retired mislabelled ids to a real model", () => {
    // The names are gone from the picker, but old messages must still render.
    for (const retired of ["llama-4-maverick", "qwen-3-next-80b", "minimax-m2.7"]) {
      expect(getModel(retired), `${retired} should still resolve`).toBeDefined();
      expect(SELECTABLE_MODELS.some((m) => m.id === retired)).toBe(false);
    }
  });
});

describe("shouldFailover", () => {
  it("fails over on transient provider trouble", () => {
    for (const status of [429, 500, 502, 503, 504, 529]) {
      expect(shouldFailover(status), `${status} should fail over`).toBe(true);
    }
  });

  // Failing over on these hides a broken key or a dead model id behind a backup
  // that quietly works, so the fault never surfaces.
  it("does not fail over on configuration faults", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(shouldFailover(status), `${status} must not fail over`).toBe(false);
    }
  });
});
