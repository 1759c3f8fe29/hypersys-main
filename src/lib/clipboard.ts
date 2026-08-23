import { toast } from 'sonner';

/**
 * Copy text to the clipboard and report honestly whether it landed.
 *
 * WHY THIS EXISTS (§14.2 #16)
 *
 * Five call sites did this:
 *
 *     await navigator.clipboard.writeText(code);
 *     setCopied(true);
 *     setTimeout(() => setCopied(false), 2000);
 *
 * With no catch, a rejected write is an unhandled promise rejection: the
 * `setCopied(true)` never runs, so the button does not even flicker, and the
 * clipboard still holds **whatever was in it before**. The user then pastes that,
 * believing it is the thing they just copied. A copy button that silently leaves
 * stale content in the clipboard is worse than one that visibly fails, and copy is
 * the most-used affordance in the app.
 *
 * `writeText` rejects for reasons that are all reachable here: the document is not
 * focused (`NotAllowedError` — happens when the click lands while a devtools pane
 * or another window has focus), a denied permission, or a platform where the async
 * API exists but is gated. And `navigator.clipboard` is `undefined` outright in a
 * non-secure context, which is a TypeError rather than a rejection.
 *
 * So: try the async API, fall back to the `execCommand` path that predates it, and
 * only return true when one of them actually reported success. Callers show their
 * confirmation on true and nothing on false — the tick becomes evidence rather
 * than an assumption.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  // The modern path. Guarded rather than assumed: `navigator.clipboard` is absent,
  // not merely failing, when the page is not a secure context.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Not returned yet — the legacy path below succeeds in several of the cases
      // that make this reject, most usefully the unfocused-document one.
      console.warn('[clipboard] async write failed, trying execCommand:', err);
    }
  }

  if (legacyCopy(text)) return true;

  console.error('[clipboard] both copy paths failed');
  // One id so a user mashing the button gets one message, not six.
  toast("Couldn't copy to the clipboard.", { id: 'copy-failed' });
  return false;
}

/**
 * The pre-async-API copy: put the text in an offscreen textarea, select it, and ask
 * the document to copy the selection.
 *
 * Two details are load-bearing. The textarea cannot be `display: none` or
 * `hidden` — an unrendered element has no selection to copy — so it is positioned
 * offscreen at zero opacity instead. And the user's existing selection is captured
 * and restored around the call, because copying a code block should not silently
 * deselect the sentence they had highlighted in the message above it.
 *
 * This still runs inside the click that started the copy: Chromium's transient
 * user activation lasts five seconds, and the async attempt above rejects in
 * microseconds, so the gesture is intact by the time we get here.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', ''); // stops the mobile keyboard appearing
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS ignores select() on a readonly field
    ok = document.execCommand('copy');
  } catch (err) {
    console.warn('[clipboard] execCommand threw:', err);
    ok = false;
  } finally {
    ta.remove();
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
  return ok;
}
