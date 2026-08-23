// ---------------------------------------------------------------------------
// The auth provider component — split out of useAuth.tsx
// ---------------------------------------------------------------------------
// Why the split, and why in this direction: a module that exports both a
// component and a plain function cannot be hot-swapped by fast refresh, so every
// edit to this provider used to remount the whole tree — signing the user back
// out to the guest/login screen and discarding the open conversation, on the one
// surface where that costs the most to redo.
//
// The provider moved out rather than the hook, deliberately. `useAuth` is
// imported by five call sites and the provider by exactly one (App.tsx), so this
// direction touches one importer instead of five — and it leaves a file named
// useAuth.tsx still exporting useAuth, rather than the inversion where the hook
// lives somewhere else and the file named after it does not contain it.
//
// Everything auth-shaped that is not a component — the context, its type, and the
// useAuth hook that throws when read outside a provider — stays in ./useAuth.

import { useState, useEffect, ReactNode } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';
import { auth, googleProvider } from '@/lib/firebase';
import { AuthContext } from './useAuth';

/**
 * Firebase auth codes, mapped to sentences a person can act on (§14.2 #17).
 *
 * WHY THIS TABLE EXISTS
 *
 * `Auth.tsx` used to do `error.message.includes('Invalid login')` and
 * `.includes('already registered')` to swap in friendly text. Those are **Supabase**
 * message strings. This app was migrated to Firebase and the checks were never
 * updated, so neither had matched in a long time — and since the fallback is to
 * toast `error.message` verbatim, *every* auth error any user has ever seen was the
 * raw SDK string `Firebase: Error (auth/invalid-credential).` The single front door
 * of the app was showing internal error codes on its most common failure.
 *
 * Mapped here rather than in the page, because there are three entry points
 * (`signIn`, `signUp`, `signInWithGoogle`) and two callers, and a table in the page
 * would have to be duplicated or exported back out of it.
 */
const AUTH_MESSAGES: Record<string, string> = {
  // The credential codes collapse into one sentence on purpose — see the note on
  // shouldAutoCreateAccount. Firebase deliberately stopped distinguishing "no such
  // account" from "wrong password", and reconstructing the distinction in the UI
  // would undo the reason for that.
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/invalid-email': "That email address doesn't look right.",
  'auth/user-disabled': 'This account has been disabled.',
  'auth/email-already-in-use': "There's already an account with that email.",
  'auth/weak-password': 'Choose a password of at least six characters.',
  'auth/missing-password': 'Enter your password.',
  'auth/too-many-requests': 'Too many attempts. Wait a minute, then try again.',
  'auth/network-request-failed': "Couldn't reach the server — check your connection.",
  'auth/operation-not-allowed': 'Email sign-in is not enabled for this app.',
  'auth/popup-blocked': 'Your browser blocked the sign-in window.',
  'auth/account-exists-with-different-credential':
    'That email is already registered with a different sign-in method.',
  'auth/unauthorized-domain': 'This site is not authorised for Google sign-in.',
};

/**
 * Popup outcomes that are the user changing their mind, not failures. No native app
 * shows an error because you closed a window, so these return no error at all.
 */
const POPUP_DISMISSED = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/user-cancelled',
]);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [isGuest, setIsGuest] = useState(() => {
    return localStorage.getItem('Flyer_guest') === 'true';
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
      if (firebaseUser) {
        setIsGuest(false);
        localStorage.removeItem('Flyer_guest');
      }
    });

    return () => unsubscribe();
  }, []);

  const shouldAutoCreateAccount = (message: string) =>
    /auth\/user-not-found|auth\/wrong-password|invalid-credential/i.test(message);

  /**
   * Pull a code and a message out of whatever a Firebase auth call rejected with.
   *
   * The catch clauses below now say `unknown` rather than `any`, and that is not a
   * formality. `err.code || err.message` reads two properties off an
   * unconstrained value; if a rejection ever arrives as null or undefined — an SDK
   * internal failure, a popup closed at the wrong moment — that read throws
   * *inside the catch block*. The new exception escapes signIn() as an unhandled
   * rejection, so the caller never receives its `{ error }` object at all: the
   * sign-in button spins forever and the user is shown nothing. Narrowing first
   * turns the worst case into an ordinary "Failed to sign in" message.
   *
   * (`unknown` has to be written explicitly here — tsconfig has strict off, so an
   * unannotated catch binding is `any` and none of this would be enforced.)
   */
  const authErrorInfo = (err: unknown): { code: string; message: string } => {
    if (err && typeof err === 'object') {
      const e = err as { code?: unknown; message?: unknown };
      return {
        code: typeof e.code === 'string' ? e.code : '',
        message: typeof e.message === 'string' ? e.message : '',
      };
    }
    // A thrown string is the one non-object shape worth preserving; anything else
    // has no message to show, and the '' falls through to the caller's default.
    return { code: '', message: typeof err === 'string' ? err : '' };
  };

  /**
   * Turn a rejection into a sentence for the user.
   *
   * Falls back to `fallback` rather than to the SDK's own `message` — an unmapped
   * code would otherwise put `Firebase: Error (auth/…)` back on screen, which is
   * exactly the bug the table replaced. The cost is that a code nobody has listed
   * shows generic text; the alternative is that it shows internal identifiers, and
   * a user can act on neither, so the generic one wins.
   *
   * Declared below `authErrorInfo` because it calls it: both are `const` arrow
   * functions, so ordering is load-bearing in a way `function` declarations would
   * not have been.
   */
  const describeAuthError = (err: unknown, fallback: string): string => {
    const { code } = authErrorInfo(err);
    return AUTH_MESSAGES[code] ?? fallback;
  };

  const signUp = async (email: string, password: string) => {
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      return { error: null };
    } catch (err: unknown) {
      console.error("Firebase SignUp Error:", err);
      return { error: new Error(describeAuthError(err, 'Failed to sign up.')) };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      return { error: null };
    } catch (err: unknown) {
      console.warn("Firebase SignIn failed, attempting auto-signup:", err);
      const { code, message } = authErrorInfo(err);
      if (shouldAutoCreateAccount(code || message)) {
        try {
          await createUserWithEmailAndPassword(auth, email, password);
          return { error: null, createdAccount: true };
        } catch (signUpErr: unknown) {
          console.error("Firebase Auto-SignUp Error:", signUpErr);
          // THE BUG THIS BRANCH USED TO HAVE, and it fired on the most common auth
          // failure there is. `shouldAutoCreateAccount` matches `wrong-password`
          // and `invalid-credential`, so an existing user mistyping their password
          // reached this createUser call, which then failed with
          // `email-already-in-use` — and *that* was the message shown. So a typo'd
          // password reported **"There's already an account with that email."**
          //
          // From the user's side that is not merely unhelpful, it points at the
          // opposite problem: it is their own account, they were signing in to it,
          // not creating it. The two obvious next actions it invites — assume
          // someone else has their address, or try a different address — are both
          // wrong, and the one piece of actionable information (the password) was
          // destroyed on the way out.
          //
          // `email-already-in-use` here is *proof* the account exists and the
          // credential did not work, so it reports as a credential failure.
          if (authErrorInfo(signUpErr).code === 'auth/email-already-in-use') {
            return { error: new Error(AUTH_MESSAGES['auth/invalid-credential']) };
          }
          return { error: new Error(describeAuthError(signUpErr, 'Failed to create account.')) };
        }
      }
      return { error: new Error(describeAuthError(err, 'Failed to sign in.')) };
    }
  };

  const signInWithGoogle = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      return { error: null };
    } catch (err: unknown) {
      const { code } = authErrorInfo(err);
      // Closing the Google window is a decision, not a fault. Reporting it as an
      // error is the kind of thing that makes an app feel like it is arguing with
      // you, and no native sign-in sheet does it.
      if (POPUP_DISMISSED.has(code)) {
        console.info("Google sign-in dismissed by the user");
        return { error: null };
      }
      console.error("Firebase Google SignIn Error:", err);
      return { error: new Error(describeAuthError(err, 'Failed to sign in with Google.')) };
    }
  };

  const signOut = async () => {
    setIsGuest(false);
    localStorage.removeItem('Flyer_guest');
    await firebaseSignOut(auth);
  };

  const continueAsGuest = () => {
    setIsGuest(true);
    localStorage.setItem('Flyer_guest', 'true');
  };

  return (
    <AuthContext.Provider value={{
      user,
      session: user ? { user } : null, // compat session object
      loading,
      isGuest,
      signUp,
      signIn,
      signInWithGoogle,
      signOut,
      continueAsGuest
    }}>
      {children}
    </AuthContext.Provider>
  );
}
