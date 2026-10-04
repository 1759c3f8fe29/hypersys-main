// Re-requesting a generated image, in a way the image host will honour.
//
// This module exists because of one measured fact about the Pollinations image
// endpoint, which is not guessable from its docs: **its cache key uses a param's
// presence, not its value — except for `seed`.**
//
// Probed directly against image.pollinations.ai (three runs, md5 of the returned
// bytes):
//
//   ?…                     -> 69f72faf…          (bare)
//   ?…&retry=1             -> f21df2dd…          (different from bare)
//   ?…&retry=2             -> f21df2dd…   <-- same as retry=1
//   ?…&retry=3             -> f21df2dd…   <-- same
//   ?…&retry=99            -> f21df2dd…   <-- same
//   ?…&seed=1              -> 0c376da9…
//   ?…&seed=2              -> f350655d…   <-- different
//   ?…&seed=3              -> 2b7b0f12…   <-- different
//   ?…&seed=1 (repeat)     -> 0c376da9… in 286ms vs 42s cold  (cached, by value)
//
// So an unknown param like `retry` buys exactly **one** alternative generation no
// matter what number is in it. A "try again" button built on `retry=${attempt}`
// therefore gets fresh bytes on the first press and replays that one response for
// every press after — and if the response it latched onto was itself the failure,
// the button can never succeed again. `seed` is the param whose *value* is keyed,
// which is what makes it the only usable cache-buster here.
//
// Deliberately dependency-free (like `chat-format`), so the render path can import
// it without pulling in `ai.ts` and, through it, Firebase.

/**
 * A seed to start a message's retry sequence from.
 *
 * Random rather than 0, because the seeds are a shared namespace: every user
 * retrying the same prompt at the same size walks the same cache. Starting
 * everyone at 1 would mean the first retry of a popular prompt serves whatever
 * `seed=1` already generated — possibly the same failure the retry is trying to
 * escape. A random base makes the first press genuinely a fresh generation.
 *
 * 2^31 keeps it inside the range a 32-bit-seeded sampler accepts.
 */
export function freshSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * `url` with `seed` set to `seed` — replacing any seed already on it.
 *
 * `set`, not append: two `seed` params in one query leaves which one wins up to
 * the server, so a second press would be a coin flip rather than a new image.
 *
 * Anything that is not an http(s) URL is returned untouched. A generated image can
 * be a `data:` URL (the markdown-extracted path), and there is no cache to bust on
 * one — re-requesting it is a no-op, while running it through `URL` and
 * re-serialising it would corrupt the payload.
 */
export function retryImageUrl(url: string, seed: number): string {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("seed", String(seed));
    return parsed.toString();
  } catch {
    return url;
  }
}
