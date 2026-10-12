// ---------------------------------------------------------------------------
// Who actually answered
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS
//
// api/llm.js walks a model's route chain and streams from the first route that
// answers. Both it and the dev proxy have always announced the winner on the
// response — `X-Served-By` and `X-Served-Model`, with a comment in the router
// saying "the client reads these to show who actually served the reply".
//
// **Nothing read them.** A grep for either name across src/ returned nothing at
// all. So every failover was invisible: the byline said "Flyer" while Qwen's
// weights wrote the answer, and there was no way for a reader to tell. Two
// distinct harms sat behind that, and both are the same class the catalogue's
// own rule already forbids ("duplicating a model across providers would mean the
// user picks one thing and a different backend answers, which misattributes the
// reply"):
//
//   1. ATTRIBUTION. The reply is credited to a model that did not produce it.
//   2. CAPABILITY. Pollinations — the keyless last resort — cannot accept tools,
//      and api/_providers.js drops them at the payload gate when a chain lands
//      there. The client had already decided tools were on (`useAgent` in
//      Chat.tsx), the agent loop then waited for a tool call that could never
//      come, and the user got prose about how to make a file instead of the file.
//      That is entry 24's bug (the dev proxy ignoring `tools`) reachable again at
//      runtime, on failover, where it is nearly invisible.
//
// This module is the client half: read the pair, work out which leg of the
// declared chain it was, and say so in words. It decides nothing about routing —
// it reports what the server already did.
//
// The derivation is deliberately done against the DECLARED chain (`spec.routes`,
// the order the client itself sent), not against a key-filtered one: which routes
// the server could actually reach is the server's business, and the client's
// question is only "was this the model I asked for, or a backup?".

import {
  PROVIDERS,
  getModel,
  type ModelRoute,
  type ProviderMeta,
} from "@/lib/providers";
import { SERVED_BY_HEADER, SERVED_MODEL_HEADER } from "../../api/_headers.js";

/** Which provider + provider-side model id streamed the reply. */
export interface ServedLeg {
  provider: string;
  modelId: string;
}

/**
 * The attribution headers off a response, or null when the server did not send
 * them.
 *
 * Both or nothing: a half pair cannot name a leg, and returning one field with
 * the other undefined would let a caller render "answered by undefined". A null
 * return means "this server does not report attribution" — an old deployment, the
 * desktop builds in release/, or a cross-origin call whose response headers were
 * never exposed — and every caller must then show nothing rather than guess.
 */
export function readServedLeg(headers: Headers | undefined | null): ServedLeg | null {
  const provider = headers?.get(SERVED_BY_HEADER);
  const modelId = headers?.get(SERVED_MODEL_HEADER);
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

export interface Attribution {
  /**
   * True when the reply came from the model the user picked — specifically from
   * that model's FIRST route, which is the weights its name promises.
   */
  sameLeg: boolean;
  /**
   * Index into the declared route chain, or -1 when the serving route is not one
   * of them (an older client, a catalogue that has since changed). -1 is a
   * reportable state, not an error: the reply still came from somewhere, and
   * saying "a Groq route" is honest where guessing a name would not be.
   */
  legIndex: number;
  /** What to call the serving model. Never empty. */
  servedName: string;
  /** The serving provider's display label, e.g. "NVIDIA NIM". */
  providerLabel: string;
  /**
   * True when tools were advertised on the request but the serving route cannot
   * accept them, so the payload gate stripped them (see routePayloadFor). The
   * turn could not search, read files or run code, and the reason is this flag.
   */
  toolsWithheld: boolean;
  /** One sentence for a tooltip. Empty when the reply needs no explaining. */
  note: string;
}

/**
 * The provider table, indexed by a string that arrived in a header.
 *
 * Separate from the direct `PROVIDERS[x]` lookups elsewhere because those index
 * by `ProviderId`, a union the compiler checks. This one is untrusted input from
 * the wire: an unknown provider must come back undefined (and be reported as
 * unexplained) rather than throw a TypeError inside a render.
 */
function providerMeta(provider: string): ProviderMeta | undefined {
  return (PROVIDERS as Record<string, ProviderMeta | undefined>)[provider];
}

/**
 * Say what happened, or null when the server told us nothing.
 *
 * `toolsAdvertised` must be whether THIS request carried tool schemas — a turn
 * that never asked for tools cannot have had them withheld, and reporting
 * otherwise would blame a route for a decision the client made.
 */
export function describeAttribution(
  requestedModelId: string,
  served: ServedLeg | null,
  opts?: { toolsAdvertised?: boolean },
): Attribution | null {
  if (!served) return null;

  const spec = getModel(requestedModelId);
  const routes: ModelRoute[] = spec?.routes ?? [];
  const requestedName = spec?.label ?? requestedModelId;

  const legIndex = routes.findIndex(
    (r) => r.provider === served.provider && r.modelId === served.modelId,
  );
  const meta = providerMeta(served.provider);
  const providerLabel = meta?.label ?? served.provider;

  // toolsWithheld is derived, not announced: the server's payload gate is
  // `!cfg.supportsTools` (api/_providers.js, routePayloadFor), and the client
  // holds the same per-provider flags in PROVIDERS. Deriving it here means the
  // two cannot disagree about whether tools could have gone out.
  const toolsWithheld = opts?.toolsAdvertised === true && meta?.supportsTools === false;

  if (legIndex === 0) {
    // The named weights answered. This is the common case and it stays silent:
    // a badge on every single reply would be noise, and noise is how a real
    // notice stops being read.
    return {
      sameLeg: true,
      legIndex: 0,
      servedName: requestedName,
      providerLabel,
      toolsWithheld,
      note: "",
    };
  }

  if (legIndex > 0) {
    const leg = routes[legIndex];
    // A backup leg's own name, which the catalogue carries on the route: the
    // model it is backing up has a name that does not describe these weights,
    // and reusing that name here is the misattribution this whole module exists
    // to undo. The provider label is the total fallback for a route added
    // without one — served-attribution.test.ts asserts every non-primary leg
    // states a label, so that path is unreachable on a catalogue that passes its
    // own tests.
    const servedName = leg.label ?? `${providerLabel} route`;
    return {
      sameLeg: false,
      legIndex,
      servedName,
      providerLabel,
      toolsWithheld,
      note: `Answered by ${servedName} on ${providerLabel}. ${requestedName}'s first route didn't answer, so the request fell through to this one.`,
    };
  }

  // Not a leg of the chain this build knows. Say the provider and stop — naming
  // weights we cannot identify would be a guess dressed as a fact.
  return {
    sameLeg: false,
    legIndex: -1,
    servedName: `${providerLabel} route`,
    providerLabel,
    toolsWithheld,
    note: `Answered by ${providerLabel}, which is not a route in this build's catalogue for ${requestedName}.`,
  };
}
