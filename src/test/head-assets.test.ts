// The one reference in index.html that pointed at nothing, and why nothing noticed.
//
// `og:image` was a Google Cloud Storage *signed* URL from the scaffold:
// `?Expires=1772265237&Signature=…`. It expired on 2026-02-28 and now answers 403
// `SignatureDoesNotMatch`. For the ~6 months since, every share of the site on
// Twitter, Facebook, WhatsApp, Slack, LinkedIn and Discord rendered without a
// preview card — while `public/og-image.png`, already 1200x630 and already
// deployed, was referenced by nothing.
//
// It is invisible from inside the app by construction: `og:image` is read only by
// crawlers, never by the page. So the check has to be a check on the *document*.
//
// `<link rel="sitemap" href="/sitemap.xml">` was the same shape one layer down.
// `vercel.json` rewrites everything outside `/api/` to `/index.html`, so the URL
// answered **200 with HTML** while declaring `type="application/xml"` — worse than
// a 404, which at least tells a crawler there is no sitemap.
//
// And that missing file is the only reference `vite build --mode desktop` left
// absolute. Vite rewrites public-asset URLs in the HTML for a relative `base`
// (`/favicon.ico` → `./favicon.ico`, measured), but only the ones it can resolve
// to a real file; the unresolvable one it leaves alone. **The broken reference is
// exactly the reference that does not get fixed**, in the one build where an
// absolute path resolves against the filesystem root. Hence the first test below:
// every local reference must name a file that exists.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// cwd, not import.meta.url: this suite runs under jsdom, where import.meta.url is
// an http:// URL and fileURLToPath throws.
const ROOT = process.cwd();
const html = readFileSync(resolve(ROOT, "index.html"), "utf8");

const CANONICAL_ORIGIN = "https://myflyer.vercel.app";

/** Every href/src attribute value in the document, decoded. */
function linkedPaths(): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

/** Every URL the document actually points at — attribute values, not prose. */
function referencedUrls(): string[] {
  return [
    ...linkedPaths(),
    ...[...html.matchAll(/<meta\s+(?:property|name)="[^"]+"\s+content="([^"]*)"/g)].map((m) =>
      m[1].replace(/&amp;/g, "&"),
    ),
  ];
}

/** The `content` of a `<meta>` addressed by property= or name=. */
function meta(key: string): string | undefined {
  const re = new RegExp(`<meta\\s+(?:property|name)="${key}"\\s+content="([^"]*)"`);
  return re.exec(html)?.[1]?.replace(/&amp;/g, "&");
}

describe("every local reference in index.html names a file that exists", () => {
  it("finds references at all", () => {
    // The control. A sweep whose matcher matches nothing reports a clean document.
    const local = linkedPaths().filter((p) => p.startsWith("/"));
    expect(local.length, "the href/src matcher found no local paths").toBeGreaterThan(4);
  });

  it("resolves each root-relative reference inside public/", () => {
    // Both roots, because that is what Vite does: `/src/main.tsx` is resolved
    // against the project root and bundled, while `/favicon.ico` is resolved
    // against public/ and copied. A path in neither place is the bug.
    const missing = linkedPaths()
      .filter((p) => p.startsWith("/") && !p.startsWith("//"))
      .map((p) => p.split(/[?#]/)[0])
      .filter(
        (p) => !existsSync(resolve(ROOT, "public", p.slice(1))) && !existsSync(resolve(ROOT, p.slice(1))),
      );

    // Named individually: "expected 1 to be 0" on a sweep tells the next person
    // nothing about which reference broke.
    expect(missing, `no file in public/ for: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the advertised sitemap a parseable urlset, not the SPA fallback", () => {
    expect(html).toContain('rel="sitemap"');
    const sitemap = readFileSync(resolve(ROOT, "public/sitemap.xml"), "utf8");
    expect(sitemap).toContain("<urlset");
    expect(sitemap).toContain(`<loc>${CANONICAL_ORIGIN}/</loc>`);
    // Crawlers discover sitemaps from robots.txt; the <link> tag is read by none of
    // the majors. If only one of the two exists, it should be this one.
    expect(readFileSync(resolve(ROOT, "public/robots.txt"), "utf8")).toContain(
      `Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`,
    );
  });
});

describe("the share card points at our own origin and cannot expire on its own", () => {
  it("serves og:image and twitter:image from the canonical origin", () => {
    for (const key of ["og:image", "twitter:image"]) {
      const value = meta(key);
      expect(value, `${key} is missing`).toBeTruthy();
      // Absolute, because Open Graph consumers do not resolve relative URLs
      // against the document — a "/og-image.png" here is simply not fetched.
      expect(value, key).toMatch(new RegExp(`^${CANONICAL_ORIGIN}/`));
    }
    expect(meta("og:image")).toBe(meta("twitter:image"));
  });

  it("refuses any expiring or third-party-signed URL in the head", () => {
    // The class of bug, not the instance. A signed URL in permanent metadata is a
    // dead link with a start date, and the page keeps working the whole time.
    // Over the URLs the document *points at*, not the raw text: the comment above
    // og:image quotes the dead signature on purpose, and a check that cannot tell a
    // reference from a description of one would forbid writing down what happened.
    const urls = referencedUrls();
    // Two controls, because `referencedUrls` is a union of two matchers and a
    // count alone is satisfied by either one. Blinding only the meta half left
    // this sweep green while it had stopped reading the very tags the bug was in —
    // so the meta half is pinned to the value it exists to police.
    expect(urls.length, "the URL matcher found nothing").toBeGreaterThan(8);
    expect(urls, "the meta matcher contributed nothing").toContain(meta("og:image"));
    expect(urls.some((u) => u.startsWith("/")), "the href matcher contributed nothing").toBe(true);
    for (const marker of ["Expires=", "Signature=", "GoogleAccessId=", "X-Amz-Signature"]) {
      const offenders = urls.filter((u) => u.includes(marker));
      expect(offenders, `head points at an expiring URL (${marker}): ${offenders.join(", ")}`).toEqual(
        [],
      );
    }
    expect(urls.filter((u) => u.includes("gpt-engineer-file-uploads"))).toEqual([]);
  });

  it("declares the dimensions the file actually has", () => {
    // Read out of the PNG header rather than restated, so editing the image
    // without editing the meta tags fails here. A card whose declared size
    // disagrees with the bytes is re-cropped by the renderer.
    const png = readFileSync(resolve(ROOT, "public/og-image.png"));
    expect(png.subarray(0, 4).toString("hex"), "not a PNG").toBe("89504e47");
    expect(meta("og:image:width")).toBe(String(png.readUInt32BE(16)));
    expect(meta("og:image:height")).toBe(String(png.readUInt32BE(20)));
    expect(meta("og:image:type")).toBe("image/png");
    // summary_large_image needs >=300x157 and 2:1-ish; 1200x630 is the shared
    // sweet spot for it and for Facebook.
    expect(png.readUInt32BE(16) / png.readUInt32BE(20)).toBeCloseTo(1.91, 1);
  });

  it("agrees with itself about where the site lives", () => {
    // canonical, og:url and twitter:url are three copies of one fact, and a
    // disagreement between them is how a share ends up pointing at a stale host.
    expect(html).toContain(`<link rel="canonical" href="${CANONICAL_ORIGIN}/" />`);
    expect(meta("og:url")).toBe(`${CANONICAL_ORIGIN}/`);
    expect(meta("twitter:url")).toBe(`${CANONICAL_ORIGIN}/`);
  });
});
