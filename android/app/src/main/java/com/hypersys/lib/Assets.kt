package com.hypersys.lib

import android.content.Context
import androidx.annotation.DrawableRes

/**
 * Port of src/lib/assets.ts.
 *
 * The web file exists because Vite does not rewrite absolute references in
 * public/ assets, so a hardcoded "/flyer-logo.png" breaks under a non-root
 * deployment base (the desktop build loads over file://). One constant instead
 * of four inline expressions, because a per-site fix is exactly the kind of
 * thing that gets half-applied when a fifth site appears.
 *
 * Android's equivalent problem is resource access, and its answer is a layer
 * the web does not have: R.drawable.* — compile-time-verified, base-safe by
 * construction, no URL at all. What survives the port is therefore the *rule*,
 * not the string: every place the logo appears resolves through this one
 * constant, so a future asset swap (a themed variant, a density split) is a
 * one-line change rather than a five-file hunt.
 */
object Assets {

    /** The brand logo, everywhere it appears. */
    @DrawableRes
    const val LOGO_RES: Int = R.drawable.ic_launcher_foreground

    /** Debug label mirroring LOGO_URL's name in the web tree. */
    fun logoName(): String = "flyer-logo"
}

/** Convenience for the call sites that just need the drawable id. */
@DrawableRes
fun logoRes(): Int = Assets.LOGO_RES

/** Debug-only placeholder resolving the resource to its entry name. */
fun Context.logoEntryName(): String =
    runCatching { resources.getResourceEntryName(Assets.LOGO_RES) }.getOrDefault("flyer-logo")
