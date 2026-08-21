// ---------------------------------------------------------------------------
// The auth context and the hook that reads it.
// ---------------------------------------------------------------------------
// The provider component lives in ./AuthProvider — see the header there for why
// these were separated (fast refresh cannot hot-swap a module that exports both a
// component and a plain function, and remounting the provider signs the user out
// mid-conversation). Everything here is a type, a context object or a hook, so
// this module is exempt from that rule and can hold them all.
//
// Kept at this path so the five `import { useAuth } from '@/hooks/useAuth'` call
// sites did not have to move. The .tsx extension is now vestigial — there is no
// JSX left in this file and it could be renamed to .ts without touching a single
// importer, since they all import the extensionless path.

import { createContext, useContext } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';

export interface AuthContextType {
  user: FirebaseUser | null;
  /**
   * A Supabase-shaped compatibility wrapper around `user`, kept from the port.
   *
   * Typed precisely rather than as `any` because the provider constructs exactly
   * this and nothing else (`user ? { user } : null`). Worth knowing before
   * touching it: nothing in the app reads this field — `useAuth()` is destructured
   * in App, Auth, Chat, MemoriesPanel and ChatSidebar, and none of them take
   * `session`. It is safe to delete along with its line in the provider; it is
   * declared honestly here so that deletion needs no investigation first.
   */
  session: { user: FirebaseUser } | null;
  loading: boolean;
  isGuest: boolean;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null; createdAccount?: boolean }>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  continueAsGuest: () => void;
}

/**
 * Exported only so AuthProvider can render its Provider. Nothing else should
 * import this — reach for `useAuth()` instead, which enforces the "inside a
 * provider" precondition that reading the context directly silently skips.
 */
export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
