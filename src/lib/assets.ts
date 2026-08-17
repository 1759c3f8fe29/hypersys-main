// ---------------------------------------------------------------------------
// Static asset URLs that must survive a non-root deployment base.
// ---------------------------------------------------------------------------
// The brand logo lives in public/, so Vite copies it verbatim and does NOT
// rewrite references to it — a hardcoded "/flyer-logo.png" stays absolute in the
// built bundle. That is correct for the web deploy (served from a domain root)
// and broken for the desktop build, which loads dist/index.html over file://:
// there, "/flyer-logo.png" resolves against the FILESYSTEM root, so every place
// the logo appears (sidebar, welcome screen, chat header, assistant avatar)
// silently 404s with ERR_FILE_NOT_FOUND and the app looks unbranded.
//
// import.meta.env.BASE_URL is Vite's build-time `base`, so this resolves to
// "/flyer-logo.png" on the web (byte-identical to before) and "./flyer-logo.png"
// under the desktop build's base:"./" — relative to dist/index.html, which is
// where the file actually is.
//
// One constant rather than four inline expressions: the four call sites are in
// four different components, and a per-site fix is exactly the kind of thing
// that gets half-applied when a fifth site appears.
export const LOGO_URL = `${import.meta.env.BASE_URL}flyer-logo.png`;
