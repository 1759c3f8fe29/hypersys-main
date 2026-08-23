import { Minus, Square, Copy, X } from 'lucide-react';
import { useCallback, useLayoutEffect } from 'react';
import { getDesktopBridge } from '@/lib/desktop';
import { useWindowState } from '@/hooks/useWindowState';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { cn } from '@/lib/utils';

/**
 * The app's own title bar, replacing the OS one (task #14, checklist item #1).
 *
 * Renders `null` in a browser, so the same bundle serves the web deploy and the
 * desktop shell — see src/lib/desktop.ts for why the check is a runtime bridge
 * probe rather than a build flag.
 *
 * WHY A SEPARATE STRIP AND NOT AN INTEGRATED HEADER
 * The tempting move is to merge this into the app's existing `liquid-header` the
 * way VS Code and Slack do, so there is only one bar. That is a real design and
 * it is deliberately not what this is, for two reasons. It would mean
 * restructuring the Chat page's layout — the header is inside the scroll/sidebar
 * flex tree and hoisting it out of that is a change with its own bugs, made
 * while the point of this pass is the chrome. And a title bar above a toolbar is
 * not itself un-native: Finder, Explorer and Xcode all have exactly that. What
 * was un-native was that the top bar was OS-themed grey with a centred filename
 * on top of a dark app. Two bars that share a palette read as one designed
 * surface; integrating them is a refinement, not the fix.
 *
 * PLATFORM SPLIT
 * `controlsSide` comes from the main process, which owns the decision:
 *   left  → macOS traffic lights exist at the top-left; pad the left, draw no
 *           buttons of our own.
 *   right → Windows draws the real caption buttons over the page; pad the right,
 *           draw no buttons of our own.
 *   none  → Linux frameless window with no controls at all; draw all three.
 *
 * Drawing our own on macOS or Windows would double them up, and on macOS would be
 * worse than that — hand-drawn traffic lights have the wrong hover glyphs, no
 * long-press window menu, and do not dim with focus.
 */

/** 32px. Tuned rather than picked: tall enough to be a comfortable drag target
 *  and to fit a 12px glyph with breathing room, short enough that it reads as a
 *  title bar rather than a second toolbar. Windows' own caption is 32px at 100%
 *  scaling, which is the number worth matching since that platform draws its
 *  buttons into this strip and a mismatch would clip or float them.
 *
 *  Kept in sync with `titleBarOverlay.height` in electron/main.cjs. That value is
 *  40 there against 32 here on purpose — Windows treats the overlay height as a
 *  minimum hit area and rounds to its own caption metrics, and undersizing it
 *  makes the buttons unclickable at their top edge. Padding the reserved width
 *  below covers the horizontal side. */
const TITLE_BAR_HEIGHT = 32;

/** Three Windows caption buttons at 46px each. Reserved, not drawn. */
const WINDOWS_CONTROLS_WIDTH = 138;

/** macOS traffic lights under `hiddenInset`, plus clearance. */
const MACOS_CONTROLS_WIDTH = 78;

export default function TitleBar() {
  const bridge = getDesktopBridge();
  const state = useWindowState();
  // The bar names whatever the window is showing, which for this app is the open
  // conversation (Chat writes it; see conversationDocumentTitle). A title bar that
  // says the same thing regardless of content is the tell that gave this one away
  // as chrome bolted onto a web page — Finder names the folder, Xcode names the
  // project, and a chat app should name the chat.
  const documentTitle = useDocumentTitle();

  // Publish the bar's height to CSS so the full-viewport layout rules can subtract
  // it. `.app-shell-height` and `.app-shell-min-height` in index.css read it; see
  // the comment there for why a custom property rather than `height: 100%` (short
  // version: ChatSidebar is `fixed` below the lg breakpoint, and a fixed element
  // resolves percentages against the viewport, not its flex parent).
  //
  // useLayoutEffect, not useEffect: this runs before the browser paints, so the
  // chat layout is never committed at the wrong height. With useEffect there is
  // one frame where every `.app-shell-height` element is a full 100dvh tall and
  // the composer sits 32px below the window edge — brief, but exactly the kind of
  // launch-time lurch this whole pass is trying to remove.
  //
  // Guarded on `bridge` rather than placed after the early return, because hooks
  // cannot be conditional; the effect simply does nothing on the web.
  useLayoutEffect(() => {
    if (!bridge) return;
    const root = document.documentElement;
    root.style.setProperty('--titlebar-height', `${TITLE_BAR_HEIGHT}px`);
    // The second thing this effect publishes, and the reason it is worth doing here
    // rather than in App: index.css needs a way to say "only in the desktop shell"
    // for rules that would be wrong on the web. Native cursors are the current
    // consumer — a hand cursor over a button is a web idiom that no desktop platform
    // uses, but removing it inside a browser tab would read as a broken page rather
    // than as a native app.
    //
    // Same useLayoutEffect timing as the height above, and for the same reason: set
    // after paint, there would be one frame of hand cursors on every launch.
    root.dataset.flyerDesktop = '';
    // Reset on unmount rather than leaving it set. TitleBar is mounted for the
    // life of the app so this should never run, and that is precisely why it is
    // here: a stale 32px offset after an unmount would be a layout bug with no
    // visible cause, and the cleanup costs one line.
    //
    // Braced body, not a concise arrow: removeProperty returns the removed value
    // as a string, and an effect cleanup must return void or a destructor. React
    // would not notice, but the implicit return is genuinely wrong — it claims to
    // hand React another cleanup function.
    return () => {
      root.style.removeProperty('--titlebar-height');
      delete root.dataset.flyerDesktop;
    };
  }, [bridge]);

  // Native title bars toggle maximize on double-click, on every platform. Wired
  // manually because `-webkit-app-region: drag` gives us the drag but not this.
  //
  // Guarded on the event target being the bar itself: with app-region drag the
  // whole subtree is draggable, so a double-click landing on the app-name text
  // bubbles up here too, and that should also maximize (it is part of the bar).
  // What must NOT maximize is a double-click on a button, and those carry
  // `app-no-drag` plus their own onClick — but a fast double-click on minimize
  // would fire this as well, un-minimizing and maximizing. `closest` on a
  // no-drag ancestor is the cheap correct filter.
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('.app-no-drag')) return;
      bridge?.toggleMaximizeWindow();
    },
    [bridge],
  );

  if (!bridge) return null;

  const { controlsSide } = bridge;
  const drawsOwnControls = controlsSide === 'none';
  // Until the first state read resolves, assume focused. The alternative is a
  // title bar that starts dimmed and brightens a frame later, which is a visible
  // flicker on every launch for no information gained.
  const focused = state?.focused ?? true;
  const maximized = state?.maximized ?? false;

  return (
    <div
      onDoubleClick={handleDoubleClick}
      style={{
        height: TITLE_BAR_HEIGHT,
        // Inline rather than a Tailwind class because these are computed from the
        // platform constants above, and a padding that has to match the OS's own
        // button metrics should be traceable to one number, not to a class name
        // that happens to equal it.
        paddingLeft: controlsSide === 'left' ? MACOS_CONTROLS_WIDTH : undefined,
        paddingRight: controlsSide === 'right' ? WINDOWS_CONTROLS_WIDTH : undefined,
      }}
      className={cn(
        'app-drag relative z-50 flex shrink-0 items-center gap-2 select-none',
        'border-b border-white/[0.06] bg-[#0b0b0f]',
        // The unfocused state is checklist item #9 and the cheapest native tell
        // there is. A real title bar loses contrast when its window goes to the
        // background; an app whose chrome looks identical either way feels like a
        // screenshot. 150ms so it reads as the window responding rather than as
        // an animation.
        'transition-colors duration-150',
        !focused && 'bg-[#0a0a0e]',
      )}
    >
      {/* On macOS the traffic lights occupy the left, so the app name goes
          centred — which is also the macOS convention. Everywhere else it sits at
          the leading edge, next to nothing, like Windows and GTK. */}
      <div
        className={cn(
          'flex min-w-0 items-center gap-2 px-3',
          controlsSide === 'left' ? 'flex-1 justify-center' : 'flex-1 justify-start',
        )}
      >
        <span
          className={cn(
            'truncate text-[11px] font-medium tracking-wide transition-colors duration-150',
            focused ? 'text-foreground/55' : 'text-foreground/25',
          )}
          /* The full string as a tooltip, because `truncate` is doing real work
             here: a long conversation name in a 280px-sidebar-plus-narrow-window
             layout will be cut, and hovering the title to read it is the native
             behaviour. */
          title={documentTitle || 'Flyer AI'}
        >
          {/* Falls back to the app name rather than rendering empty. The hook reads
              document.title synchronously so this should never be blank, but a blank
              title bar looks like a rendering failure and the fallback costs
              nothing. */}
          {documentTitle || 'Flyer AI'}
        </span>
      </div>

      {drawsOwnControls && (
        <div className="app-no-drag flex h-full items-stretch">
          <TitleBarButton onClick={bridge.minimizeWindow} label="Minimize">
            <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </TitleBarButton>

          <TitleBarButton
            onClick={bridge.toggleMaximizeWindow}
            label={maximized ? 'Restore' : 'Maximize'}
          >
            {/* Two overlapping squares for restore, one for maximize — the glyph
                pair every platform uses. This is the whole reason the hook does an
                initial fetch as well as subscribing: a window restored maximized
                from saved geometry emits no event, so without the fetch this would
                show the maximize glyph on an already-maximized window. */}
            {maximized ? (
              <Copy className="h-3 w-3" strokeWidth={1.5} />
            ) : (
              <Square className="h-3 w-3" strokeWidth={1.5} />
            )}
          </TitleBarButton>

          <TitleBarButton onClick={bridge.closeWindow} label="Close" danger>
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </TitleBarButton>
        </div>
      )}
    </div>
  );
}

function TitleBarButton({
  onClick,
  label,
  danger,
  children,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        // 46px wide is the Windows caption-button width and close to the GNOME
        // one; it looks over-wide in isolation and correct in place.
        'app-no-drag inline-flex w-[46px] items-center justify-center',
        // No radius, no scale, no spring. Caption buttons are full-bleed
        // rectangles that fill on hover — this is one of the places where the
        // app's usual rounded-and-springy button style would be actively wrong,
        // because the shape is what identifies them as window controls.
        'text-foreground/60 transition-colors duration-100',
        // 75ms-ish feel: the transition is on colour only, and deliberately
        // faster than the app's 150ms because caption buttons are the one control
        // users expect to be instant.
        danger
          ? 'hover:bg-[#e81123] hover:text-white active:bg-[#c50f1f]'
          : 'hover:bg-white/[0.08] hover:text-foreground/90 active:bg-white/[0.12]',
        // The focus ring has to be inset — an outline on a zero-radius element
        // flush against the window edge would be clipped by the window itself.
        'outline-none focus-visible:bg-white/[0.08] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50',
      )}
    >
      {children}
    </button>
  );
}
