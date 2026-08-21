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

  const signUp = async (email: string, password: string) => {
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      return { error: null };
    } catch (err: unknown) {
      console.error("Firebase SignUp Error:", err);
      return { error: new Error(authErrorInfo(err).message || 'Failed to sign up') };
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
          return { error: new Error(authErrorInfo(signUpErr).message || 'Failed to create account') };
        }
      }
      return { error: new Error(message || 'Failed to sign in') };
    }
  };

  const signInWithGoogle = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      return { error: null };
    } catch (err: unknown) {
      console.error("Firebase Google SignIn Error:", err);
      return { error: new Error(authErrorInfo(err).message || 'Failed to sign in with Google') };
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
