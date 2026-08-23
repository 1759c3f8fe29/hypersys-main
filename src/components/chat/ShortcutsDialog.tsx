import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  SHORTCUTS,
  aliasTokens,
  chordTokens,
  type ShortcutDef,
} from '@/lib/shortcuts';
import { isDesktopShell } from '@/lib/desktop';

/**
 * The keyboard-shortcuts sheet (Ctrl/Cmd + /), task #14 item 8.
 *
 * Built from the SHORTCUTS table rather than from a hand-written list, so it
 * cannot advertise a chord that nothing implements. That failure mode is not
 * hypothetical — it is what happens the first time someone removes a shortcut
 * and greps for the handler but not for the documentation.
 *
 * `desktopOnlyAlias` is rendered only in the Electron shell. Showing "Ctrl+N" to
 * a browser user would be showing them a chord Chrome will answer by opening a
 * new browser window.
 */

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    // Sized off the platform's own key caps: small, tight, one line, and a top
    // highlight rather than a drop shadow. min-w keeps ⌘ and "Shift" on the same
    // baseline grid instead of letting one-glyph caps collapse to a square.
    <kbd className="inline-flex min-w-[1.75rem] items-center justify-center rounded border border-border/60 border-b-border bg-secondary/60 px-1.5 py-0.5 font-sans text-[11px] font-medium leading-none text-foreground/80 shadow-[inset_0_1px_0_hsl(0_0%_100%/0.06)]">
      {children}
    </kbd>
  );
}

function Chord({ tokens }: { tokens: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {tokens.map((token, i) => (
        <KeyCap key={`${token}-${i}`}>{token}</KeyCap>
      ))}
    </span>
  );
}

function Row({ def, desktop }: { def: ShortcutDef; desktop: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-foreground/75">{def.label}</span>
      <span className="flex shrink-0 items-center gap-2">
        <Chord tokens={chordTokens(def)} />
        {desktop && def.desktopOnlyAlias && (
          <>
            <span className="text-xs text-muted-foreground/50">or</span>
            <Chord tokens={aliasTokens(def.desktopOnlyAlias)} />
          </>
        )}
      </span>
    </div>
  );
}

const GROUP_ORDER = ['Chat', 'View', 'General'] as const;

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const desktop = isDesktopShell();
  const visible = SHORTCUTS.filter((s) => !s.hidden);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {GROUP_ORDER.map((group) => {
            const rows = visible.filter((s) => s.group === group);
            if (rows.length === 0) return null;
            return (
              <div key={group}>
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {group}
                </h3>
                <div className="divide-y divide-border/30">
                  {rows.map((def) => (
                    <Row key={def.action} def={def} desktop={desktop} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Type-to-focus has no chord, so the table cannot describe it, but it is
            the behaviour most worth telling people about — it is the difference
            between clicking into the box every time and just typing. */}
        <p className="border-t border-border/30 pt-3 text-xs leading-relaxed text-muted-foreground/60">
          You can also just start typing anywhere in the conversation — the message
          box takes focus and keeps the first character.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export default ShortcutsDialog;
