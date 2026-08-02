import { useState, useEffect, createContext, useContext, ReactNode } from 'react';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signInWithPopup, 
  signOut as firebaseSignOut, 
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';
import { auth, googleProvider } from '@/lib/firebase';

interface AuthContextType {
  user: FirebaseUser | null;
  session: any | null;
  loading: boolean;
  isGuest: boolean;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null; createdAccount?: boolean }>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  continueAsGuest: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

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

  const signUp = async (email: string, password: string) => {
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      return { error: null };
    } catch (err: any) {
      console.error("Firebase SignUp Error:", err);
      return { error: new Error(err.message || 'Failed to sign up') };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      return { error: null };
    } catch (err: any) {
      console.warn("Firebase SignIn failed, attempting auto-signup:", err);
      if (shouldAutoCreateAccount(err.code || err.message)) {
        try {
          await createUserWithEmailAndPassword(auth, email, password);
          return { error: null, createdAccount: true };
        } catch (signUpErr: any) {
          console.error("Firebase Auto-SignUp Error:", signUpErr);
          return { error: new Error(signUpErr.message || 'Failed to create account') };
        }
      }
      return { error: new Error(err.message || 'Failed to sign in') };
    }
  };

  const signInWithGoogle = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      return { error: null };
    } catch (err: any) {
      console.error("Firebase Google SignIn Error:", err);
      return { error: new Error(err.message || 'Failed to sign in with Google') };
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

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
