import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Zap, Mail, Lock, ArrowRight, Sparkles, UserX } from 'lucide-react';
import { toast } from 'sonner';

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { user, signIn, signUp, signInWithGoogle, continueAsGuest } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate('/');
  }, [user, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (isLogin) {
        const { error, createdAccount } = await signIn(email, password);
        if (error) {
          toast.error(error.message.includes('Invalid login') ? 'Invalid email or password' : error.message);
        } else if (createdAccount) {
          toast.success('Account created! Check your email to verify it, then sign in.');
        } else {
          toast.success('Welcome back!');
          navigate('/');
        }
      } else {
        const { error } = await signUp(email, password);
        if (error) {
          toast.error(error.message.includes('already registered') ? 'This email is already registered' : error.message);
        } else {
          toast.success('Check your email to verify your account!');
        }
      }
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setLoading(true);
    try {
      const { error } = await signInWithGoogle();
      if (error) toast.error(error.message);
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleGuestMode = () => {
    continueAsGuest();
    navigate('/');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 liquid-canvas" />
      <div className="absolute inset-0 liquid-sheen pointer-events-none" />
      <div className="absolute inset-0 liquid-grid opacity-40 pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-full max-w-md relative z-10"
      >
        <div className="glass-panel rounded-3xl p-8 shadow-2xl border border-primary/10">
          <motion.div className="text-center mb-8" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <motion.div 
              className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-4 liquid-icon glow-effect"
              whileHover={{ scale: 1.05, rotate: 5 }}
            >
              <Sparkles className="w-10 h-10 text-primary" />
            </motion.div>
            <h1 className="text-3xl font-display font-bold gradient-text">Flyer</h1>
            <p className="text-muted-foreground mt-2 text-sm">
              {isLogin ? 'Welcome back! Sign in to continue' : 'Create an account to get started'}
            </p>
          </motion.div>

          {/* Google Sign In */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <Button
              type="button"
              variant="outline"
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="w-full py-6 rounded-xl border-border/50 hover:border-primary/50 transition-all duration-300 group liquid-surface"
            >
              <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24">
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              <span className="group-hover:text-primary transition-colors">Continue with Google</span>
            </Button>
          </motion.div>

          <div className="flex items-center gap-4 my-6">
            <div className="flex-1 h-px bg-border/50" />
            <span className="text-muted-foreground text-xs uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-border/50" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <motion.div className="space-y-2" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.4 }}>
              <Label htmlFor="email" className="text-foreground/80 text-sm font-medium">Email</Label>
              <div className="relative group">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground group-focus-within:text-primary transition-colors" />
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter your email" required className="pl-12 py-6 bg-secondary/50 border-border/50 focus:border-primary/50 rounded-xl" />
              </div>
            </motion.div>

            <motion.div className="space-y-2" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.5 }}>
              <Label htmlFor="password" className="text-foreground/80 text-sm font-medium">Password</Label>
              <div className="relative group">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground group-focus-within:text-primary transition-colors" />
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" required minLength={6} className="pl-12 py-6 bg-secondary/50 border-border/50 focus:border-primary/50 rounded-xl" />
              </div>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }}>
              <Button type="submit" disabled={loading} className="w-full bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 text-primary-foreground font-semibold py-6 rounded-xl transition-all duration-300 hover:shadow-lg hover:shadow-primary/25">
                {loading ? (
                  <span className="flex items-center gap-2"><Zap className="w-4 h-4 animate-pulse" />{isLogin ? 'Signing in...' : 'Creating account...'}</span>
                ) : (
                  <span className="flex items-center gap-2">{isLogin ? 'Sign In' : 'Create Account'}<ArrowRight className="w-4 h-4" /></span>
                )}
              </Button>
            </motion.div>
          </form>

          <motion.div className="mt-6 text-center space-y-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7 }}>
            <button type="button" onClick={() => setIsLogin(!isLogin)} className="text-muted-foreground hover:text-primary transition-colors text-sm">
              {isLogin ? "Don't have an account? " : 'Already have an account? '}
              <span className="text-primary font-medium hover:underline">{isLogin ? 'Sign up' : 'Sign in'}</span>
            </button>

            {/* Guest mode */}
            <div className="pt-2">
              <button
                type="button"
                onClick={handleGuestMode}
                className="flex items-center justify-center gap-2 mx-auto text-muted-foreground/70 hover:text-foreground text-sm transition-all duration-200 group"
              >
                <UserX className="w-4 h-4 group-hover:text-primary transition-colors" />
                <span className="group-hover:text-primary transition-colors">Continue without signing in</span>
              </button>
            </div>
          </motion.div>
        </div>

        <motion.div className="text-center mt-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }}>
          <span className="text-muted-foreground/60 text-xs">Powered by AI • Built for everyone</span>
        </motion.div>
      </motion.div>
    </div>
  );
}
