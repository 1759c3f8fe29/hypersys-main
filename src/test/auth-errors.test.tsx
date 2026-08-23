// What the front door says when it goes wrong (§14.2 #17).
//
// WHY THIS FILE EXISTS
//
// Two defects met in `signIn`, and between them they made the app's most common
// failure report the wrong cause in internal jargon.
//
// 1. `Auth.tsx` chose its friendly text with
//    `error.message.includes('Invalid login')` and `.includes('already
//    registered')`. Those are **Supabase** message strings. The app was migrated to
//    Firebase, whose messages read `Firebase: Error (auth/invalid-credential).`, so
//    neither check had matched in a long time — and the fallback branch toasts
//    `error.message` verbatim. Every auth error any user ever saw was a raw SDK
//    string with a code in it.
//
// 2. `shouldAutoCreateAccount` matches `wrong-password` and `invalid-credential`,
//    not just `user-not-found`. So an existing user mistyping their password fell
//    into the auto-create branch, `createUserWithEmailAndPassword` rejected with
//    `email-already-in-use`, and *that* was the message returned. A typo'd password
//    reported that the email was already in use — pointing at the opposite problem,
//    on their own account, and destroying the one useful fact (the password) on the
//    way out.
//
// The pairing in the last describe block is the point of the fix: the same Firebase
// code has to produce **different** sentences depending on the path it arrived by.
// On the sign-up form, `email-already-in-use` means what it says. Inside the
// sign-in auto-create fallback, it is proof the account exists and the credential
// was wrong.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({ auth: {}, googleProvider: {} }));

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: mocks.signInWithEmailAndPassword,
  createUserWithEmailAndPassword: mocks.createUserWithEmailAndPassword,
  signInWithPopup: mocks.signInWithPopup,
  signOut: vi.fn(async () => undefined),
  // Never calls back, so the provider stays in its signed-out state and no test
  // depends on an auth state race.
  onAuthStateChanged: vi.fn(() => () => {}),
}));

import { AuthProvider } from "@/hooks/AuthProvider";
import { useAuth, type AuthContextType } from "@/hooks/useAuth";

/** A Firebase-shaped rejection: a code plus the SDK's own message text. */
const fbError = (code: string) =>
  Object.assign(new Error(`Firebase: Error (${code}).`), { code });

/** Render the provider and hand back its context value. */
function mountAuth(): AuthContextType {
  let captured!: AuthContextType;
  function Probe() {
    captured = useAuth();
    return null;
  }
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("a mistyped password on an account that exists", () => {
  // The headline bug. Both mocks reject the way Firebase actually does.
  beforeEach(() => {
    mocks.signInWithEmailAndPassword.mockRejectedValue(fbError("auth/invalid-credential"));
    mocks.createUserWithEmailAndPassword.mockRejectedValue(fbError("auth/email-already-in-use"));
  });

  it("reports the credential, not the email", async () => {
    const { signIn } = mountAuth();
    const { error } = await signIn("someone@example.com", "wrong-password");
    expect(error?.message).toMatch(/incorrect email or password/i);
    // The assertion that encodes the bug: this is what it used to say.
    expect(error?.message).not.toMatch(/already/i);
  });

  it("does not sign the user in", async () => {
    const { signIn } = mountAuth();
    const result = await signIn("someone@example.com", "wrong-password");
    expect(result.error).toBeTruthy();
    expect(result.createdAccount).toBeFalsy();
  });
});

describe("no internal identifiers reach the user", () => {
  it("maps a known code to a sentence", async () => {
    mocks.signInWithEmailAndPassword.mockRejectedValue(fbError("auth/too-many-requests"));
    const { signIn } = mountAuth();
    const { error } = await signIn("a@b.co", "pw");
    expect(error?.message).toMatch(/too many attempts/i);
    expect(error?.message).not.toMatch(/Firebase|auth\//);
  });

  it("falls back to generic text for a code nobody has listed", async () => {
    // The fallback deliberately is *not* the SDK message. A user can act on neither
    // an unmapped sentence nor `Firebase: Error (auth/…)`, and only one of the two
    // looks like the app is working.
    mocks.signInWithEmailAndPassword.mockRejectedValue(fbError("auth/some-future-code"));
    const { signIn } = mountAuth();
    const { error } = await signIn("a@b.co", "pw");
    expect(error?.message).toBe("Failed to sign in.");
    expect(error?.message).not.toMatch(/Firebase|auth\//);
  });

  it("survives a rejection with no code at all", async () => {
    // authErrorInfo's reason for existing: a null or undefined rejection used to
    // throw *inside* the catch, escaping as an unhandled rejection so the caller
    // never got its { error } object and the button spun forever.
    mocks.signInWithEmailAndPassword.mockRejectedValue(undefined);
    const { signIn } = mountAuth();
    const { error } = await signIn("a@b.co", "pw");
    expect(error?.message).toBe("Failed to sign in.");
  });

  it("does not leak the SDK string out of the Google path either", async () => {
    mocks.signInWithPopup.mockRejectedValue(fbError("auth/popup-blocked"));
    const { signInWithGoogle } = mountAuth();
    const { error } = await signInWithGoogle();
    expect(error?.message).toMatch(/blocked/i);
    expect(error?.message).not.toMatch(/Firebase|auth\//);
  });
});

describe("closing the Google window is not a failure", () => {
  it("returns no error when the user dismisses the popup", async () => {
    // No native sign-in sheet shows an error because you changed your mind.
    mocks.signInWithPopup.mockRejectedValue(fbError("auth/popup-closed-by-user"));
    const { signInWithGoogle } = mountAuth();
    await expect(signInWithGoogle()).resolves.toEqual({ error: null });
  });

  it("also stays quiet when a second popup supersedes the first", async () => {
    mocks.signInWithPopup.mockRejectedValue(fbError("auth/cancelled-popup-request"));
    const { signInWithGoogle } = mountAuth();
    await expect(signInWithGoogle()).resolves.toEqual({ error: null });
  });
});

describe("the account that genuinely does not exist yet", () => {
  it("is created, and says so", async () => {
    mocks.signInWithEmailAndPassword.mockRejectedValue(fbError("auth/user-not-found"));
    mocks.createUserWithEmailAndPassword.mockResolvedValue({ user: { uid: "new" } });
    const { signIn } = mountAuth();
    await expect(signIn("new@example.com", "hunter2")).resolves.toEqual({
      error: null,
      createdAccount: true,
    });
  });

  it("reports a weak password against the create attempt, not as a sign-in failure", async () => {
    mocks.signInWithEmailAndPassword.mockRejectedValue(fbError("auth/user-not-found"));
    mocks.createUserWithEmailAndPassword.mockRejectedValue(fbError("auth/weak-password"));
    const { signIn } = mountAuth();
    const { error } = await signIn("new@example.com", "123");
    expect(error?.message).toMatch(/at least six characters/i);
  });
});

describe("one code, two meanings, decided by the path", () => {
  // This is the pairing that makes the fix correct rather than merely different.
  it("means what it says on the sign-up form", async () => {
    mocks.createUserWithEmailAndPassword.mockRejectedValue(fbError("auth/email-already-in-use"));
    const { signUp } = mountAuth();
    const { error } = await signUp("taken@example.com", "hunter2");
    expect(error?.message).toMatch(/already an account with that email/i);
  });

  it("means the password was wrong when it comes out of the sign-in fallback", async () => {
    mocks.signInWithEmailAndPassword.mockRejectedValue(fbError("auth/invalid-credential"));
    mocks.createUserWithEmailAndPassword.mockRejectedValue(fbError("auth/email-already-in-use"));
    const { signIn } = mountAuth();
    const { error } = await signIn("taken@example.com", "wrong");
    expect(error?.message).toMatch(/incorrect email or password/i);
  });
});
