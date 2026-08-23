import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/hooks/AuthProvider";
import { useAuth } from "@/hooks/useAuth";
import Auth from "./pages/Auth";
import Chat from "./pages/Chat";
import NotFound from "./pages/NotFound";
import { Sparkles } from "lucide-react";
import TitleBar from "@/components/desktop/TitleBar";
// `import { Analytics } from "@vercel/analytics/react"` used to sit here and was
// never rendered — no <Analytics /> anywhere in the tree. Dead, but not free: a
// bare `import { X } from "pkg"` is a side-effecting module import as far as
// Rollup is concerned unless the package is marked side-effect-free, so it pulled
// @vercel/analytics into the bundle to do nothing. eslint did not catch it
// because no-unused-vars is not enabled for imports in this config.
//
// Left as a comment rather than deleted silently because the intent was clearly
// to add analytics and someone will want to finish that: render <Analytics /> in
// the tree below, and note it is a no-op outside a Vercel deploy — the desktop
// build loads over file:// and should not be sending page views at all.

const queryClient = new QueryClient();

// ---------------------------------------------------------------------------
// Router: history API on the web, hash under file://
// ---------------------------------------------------------------------------
// The desktop shell's packaged mode loads dist/index.html straight off disk
// (electron/main.cjs → loadFile), so location.pathname is the FILE PATH —
// "/home/you/hypersys/dist/index.html" — which matches no <Route> below and
// renders NotFound instead of the app. HashRouter keeps the whole route after
// the "#", leaving the path as whatever the file URL happens to be, so "/"
// resolves normally.
//
// Keyed off the protocol rather than a build-mode flag on purpose: `desktop:dev`
// loads http://localhost:8080, a real server that can serve any path, so it
// wants the same BrowserRouter as the web build. Only a file:// document needs
// the hash — one predicate, and no env var to keep in sync with the build mode.
const Router =
  typeof window !== "undefined" && window.location.protocol === "file:"
    ? HashRouter
    : BrowserRouter;

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, isGuest } = useAuth();

  if (loading) {
    return (
      <div className="app-shell-min-height flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/30 to-primary/5 flex items-center justify-center animate-pulse">
            <Sparkles className="w-8 h-8 text-primary" />
          </div>
          <p className="text-muted-foreground animate-pulse">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user && !isGuest) {
    return <Navigate to="/auth" replace />;
  }

  return <>{children}</>;
}

function AuthRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, isGuest } = useAuth();

  if (loading) {
    return (
      <div className="app-shell-min-height flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/30 to-primary/5 flex items-center justify-center animate-pulse">
            <Sparkles className="w-8 h-8 text-primary" />
          </div>
          <p className="text-muted-foreground animate-pulse">Loading...</p>
        </div>
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<ProtectedRoute><Chat /></ProtectedRoute>} />
      <Route path="/auth" element={<AuthRoute><Auth /></AuthRoute>} />
      <Route path="/chat" element={<Navigate to="/" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}


const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <Toaster />
          <Sonner />
          {/* The desktop shell's own title bar (task #14). Renders null in a
              browser, so this costs the web build one no-op component.

              Mounted here, outside the Router, rather than inside each page: the
              window controls must exist on every route including /auth and the
              404, and a title bar that disappears on a route the user can
              actually reach would leave a frameless window with no close button.

              The flex column is what makes it a real bar instead of an overlay —
              `h-screen` + `min-h-0` on the routes region means the app gets
              exactly the space below the bar and its internal scroll containers
              size to that, rather than the bar pushing the page 32px taller and
              introducing a document-level scrollbar. */}
          <div className="flex h-[100dvh] flex-col overflow-hidden">
            <TitleBar />
            <div className="min-h-0 flex-1">
              <Router>
                <AppRoutes />
              </Router>
            </div>
          </div>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
