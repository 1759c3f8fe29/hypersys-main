import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Compass, ArrowLeft } from "lucide-react";

/**
 * Route-not-found page.
 *
 * Two things were fixed here in the native look-and-feel pass (#14).
 *
 * THE LINK WAS BROKEN IN THE DESKTOP BUILD
 * It was `<a href="/">Return to Home</a>`. A plain anchor does a full document
 * navigation, so under file:// it resolved to `file:///` — and main.cjs turns a
 * main-frame load failure into a modal "Flyer could not start" box. The single
 * escape hatch on the app's error page was therefore the thing most likely to
 * kill the app, which is close to the worst place for that bug to be. `<Link>`
 * routes in place and works under HashRouter and BrowserRouter alike.
 *
 * IT DID NOT LOOK LIKE THE APP
 * `bg-muted` with a bare underlined blue link is the shadcn scaffold this file
 * shipped with. Landing on it felt like being dropped out of the application into
 * a different website — which is the specific thing a native app never does. An
 * error state is still a designed screen: same background, same type, and a real
 * button rather than an underlined link.
 *
 * The console.error is kept. It is genuinely useful — an unexpected 404 in the
 * desktop build usually means a router/base mismatch rather than a user typo, and
 * the path is the only clue.
 */
const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  // Say so in the window title too, not only on the page. A window switcher entry
  // still reading the last conversation's name while the window shows a 404 is a
  // small lie, and it is the sort of thing that makes a desktop build feel like a
  // web page in a frame. See src/hooks/useDocumentTitle.ts.
  useEffect(() => {
    document.title = "Page not found — Flyer AI";
  }, []);

  return (
    <div className="app-shell-min-height liquid-app flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        {/* Static, like every other icon in the app after this pass — see the note
            in WelcomeScreen about one-shot versus always-on motion. */}
        <div className="mx-auto mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-border/40 bg-secondary/30">
          <Compass className="h-6 w-6 text-muted-foreground/70" />
        </div>

        <h1 className="mb-2 text-lg font-semibold text-foreground/90">This page doesn't exist</h1>

        <p className="mb-1 text-sm leading-relaxed text-muted-foreground/70">
          Nothing is here at that address.
        </p>
        {/* Showing the path is deliberate. It costs a line and it is the
            difference between "something went wrong" and an error the user can
            actually report or recognise as their own typo. `break-all` because a
            file:// path in the desktop build can be long enough to overflow. */}
        <p className="mb-6 break-all font-mono text-xs text-muted-foreground/45">
          {location.pathname}
        </p>

        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-secondary/40 px-4 py-2 text-sm font-medium text-foreground/85 transition-colors duration-150 hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Flyer
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
