// A comment that described a guard the code did not have.
//
// `useWindowState` seeds itself from one `getWindowState()` invoke and then keeps
// itself current from a subscription, and its own comment said the `live` flag
// stopped the invoke's answer from "clobbering a *newer* state that the
// subscription may already have delivered". It did not: `live` only goes false on
// unmount, so a fetch resolving during a normal lifetime passed it and wrote
// anyway. The ordering the hook is exposed to:
//
//   1. the effect invokes `getWindowState()` — the window is still `show: false`
//      here, because main.cjs shows it on "ready-to-show", which fires after the
//      renderer's first paint, so the snapshot being computed says
//      `focused: false`;
//   2. the window is shown, "focus" fires, the subscription delivers `true`;
//   3. the invoke's reply — step 1's snapshot — lands and overwrites it.
//
// In the real shell Electron queues the reply before the later "focus" send, so
// step 3 usually arrives first and nothing is visible. That is an ordering
// property of the transport, not of this hook, and a test that drove it through a
// real bridge would be testing Electron. So the interleaving is driven directly
// here: the subscription fires, *then* the deferred fetch resolves. That is the
// only way to assert the rule the hook actually needs, which is that the
// subscription is strictly newer than the fetch by construction — the fetch
// answers a question asked before the event happened.
//
// There is deliberately **no** test for the `live` (unmount) guard. One was
// written and then deleted: React 18 removed the "setState on an unmounted
// component" warning, and an unmounted hook exposes nothing else to observe, so
// the only assertion available was `console.error` staying empty — which it does
// with the guard removed as well. Mutation-checked: dropping `live` leaves all
// eleven of these green. The guard stays in the code because it is correct and
// free; the check does not, because a test that cannot fail reads as coverage.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWindowState } from "@/hooks/useWindowState";
import type { FlyerDesktopBridge, WindowState } from "@/lib/desktop";

const MAXIMIZED: WindowState = { maximized: true, fullScreen: false, focused: true };
const RESTORED: WindowState = { maximized: false, fullScreen: false, focused: false };

/** A stub bridge whose invoke resolution and event delivery are both manual. */
function stubBridge(overrides: Partial<FlyerDesktopBridge> = {}) {
  const listeners: ((s: WindowState) => void)[] = [];
  let resolveFetch: (s: WindowState) => void = () => {};
  let rejectFetch: (e: unknown) => void = () => {};
  const unsubscribe = vi.fn();

  const bridge: FlyerDesktopBridge = {
    version: 1,
    controlsSide: "none",
    minimizeWindow: vi.fn(),
    toggleMaximizeWindow: vi.fn(),
    closeWindow: vi.fn(),
    getWindowState: () =>
      new Promise<WindowState>((res, rej) => {
        resolveFetch = res;
        rejectFetch = rej;
      }),
    onWindowStateChange: (cb) => {
      listeners.push(cb);
      return unsubscribe;
    },
    ...overrides,
  };

  window.flyerDesktop = bridge;
  return {
    bridge,
    unsubscribe,
    listeners,
    /** Deliver a main-process push. */
    push: (s: WindowState) => act(() => listeners.forEach((l) => l(s))),
    /** Resolve the pending invoke. */
    settle: async (s: WindowState) => {
      await act(async () => {
        resolveFetch(s);
      });
    },
    fail: async (e: unknown = new Error("No handler registered")) => {
      await act(async () => {
        rejectFetch(e);
      });
    },
  };
}

afterEach(() => {
  delete window.flyerDesktop;
  vi.restoreAllMocks();
});

describe("outside the desktop shell", () => {
  beforeEach(() => {
    delete window.flyerDesktop;
  });

  it("stays null in a browser, which is how one bundle serves both", () => {
    const { result } = renderHook(() => useWindowState());
    expect(result.current).toBeNull();
  });

  it("stays null for a bridge older than this renderer understands", () => {
    // version 0 fails the floor in getDesktopBridge; the hook must not call
    // through it. Asserted here because the hook is the only consumer that would
    // otherwise invoke a method the shell may not have finished exposing.
    const getWindowState = vi.fn();
    window.flyerDesktop = {
      version: 0,
      controlsSide: "none",
      minimizeWindow: vi.fn(),
      toggleMaximizeWindow: vi.fn(),
      closeWindow: vi.fn(),
      getWindowState,
      onWindowStateChange: () => () => {},
    };
    const { result } = renderHook(() => useWindowState());
    expect(result.current).toBeNull();
    expect(getWindowState).not.toHaveBeenCalled();
  });
});

describe("seeding from the one-shot fetch", () => {
  it("reports the state the main process answered with", async () => {
    const b = stubBridge();
    const { result } = renderHook(() => useWindowState());
    expect(result.current).toBeNull();

    await b.settle(MAXIMIZED);
    expect(result.current).toEqual(MAXIMIZED);
  });

  it("renders a plausible window rather than nothing when the invoke rejects", async () => {
    // A rejection means no handler on the main side. A frameless Linux window
    // with no title bar has no close button, so a possibly-wrong glyph beats an
    // unclosable window.
    const b = stubBridge();
    const { result } = renderHook(() => useWindowState());
    await b.fail();
    expect(result.current).toEqual({ maximized: false, fullScreen: false, focused: true });
  });
});

describe("the subscription is newer than the fetch, and wins", () => {
  it("does not let a stale snapshot overwrite a delivered event", async () => {
    const b = stubBridge();
    const { result } = renderHook(() => useWindowState());

    // Step 2: the window was shown and focused while the invoke was in flight.
    b.push(MAXIMIZED);
    expect(result.current).toEqual(MAXIMIZED);

    // Step 3: the invoke's reply — computed before any of that — lands now.
    await b.settle(RESTORED);

    // The bug this pins: `focused` back to false and the restore glyph back to a
    // maximize glyph, on a window that is maximized and focused.
    expect(result.current).toEqual(MAXIMIZED);
  });

  it("does not let the rejection fallback overwrite a delivered event either", async () => {
    // Worse than the stale-snapshot case: the fallback is a *guess*, and it would
    // be overwriting something measured.
    const b = stubBridge();
    const { result } = renderHook(() => useWindowState());

    b.push(MAXIMIZED);
    await b.fail();
    expect(result.current).toEqual(MAXIMIZED);
  });

  it("still applies later events after the fetch has settled", async () => {
    // The guard must be one-directional. A `superseded` flag that also blocked
    // the subscription would freeze the title bar after first paint — which is
    // the same class of defect, arrived at from the other side.
    const b = stubBridge();
    const { result } = renderHook(() => useWindowState());

    await b.settle(RESTORED);
    expect(result.current).toEqual(RESTORED);

    b.push(MAXIMIZED);
    expect(result.current).toEqual(MAXIMIZED);

    b.push(RESTORED);
    expect(result.current).toEqual(RESTORED);
  });

  it("overwrites rather than merges, so a partial payload cannot hide", async () => {
    const b = stubBridge();
    const { result } = renderHook(() => useWindowState());
    await b.settle({ maximized: true, fullScreen: true, focused: true });
    b.push(RESTORED);
    expect(result.current).toEqual(RESTORED);
  });
});

describe("teardown", () => {
  it("unsubscribes on unmount", () => {
    const b = stubBridge();
    const { unmount } = renderHook(() => useWindowState());
    expect(b.unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(b.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("re-subscribes to a bridge that appears later", async () => {
    // The effect depends on `bridge`, and `getDesktopBridge()` is read on every
    // render. A browser that never gets one must not subscribe; a shell must.
    delete window.flyerDesktop;
    const { result, rerender } = renderHook(() => useWindowState());
    expect(result.current).toBeNull();

    const b = stubBridge();
    rerender();
    await b.settle(MAXIMIZED);
    await waitFor(() => expect(result.current).toEqual(MAXIMIZED));
  });
});
