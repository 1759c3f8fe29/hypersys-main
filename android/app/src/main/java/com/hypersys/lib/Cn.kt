package com.hypersys.lib

/**
 * Port of src/lib/utils.ts — the whole file is `cn(...inputs)`, which folds
 * conditional class names together and lets later Tailwind utilities win over
 * earlier ones.
 *
 * Android has no Tailwind, so the tailwind-merge half has no equivalent: the
 * platform's style system does not have two spellings of "red text" where one
 * must override the other. What survives the port is the clsx half — collect
 * the truthy fragments, skip the falsy ones, join with spaces — because
 * "assemble a style string from optional parts" is exactly what Android string
 * resources and view tag assemblies need. Consumers pass null or false for the
 * parts that do not apply, same as the web version.
 */

fun cn(vararg inputs: Any?): String =
    inputs.asSequence()
        // Mirror clsx's truthiness: null, false, and the empty string are
        // dropped; a bare string or a non-empty collection is kept.
        .mapNotNull { part ->
            when (part) {
                null, false -> null
                is String -> part.takeIf { it.isNotEmpty() }
                is Iterable<*> -> cn(*part.toList().toTypedArray()).takeIf { it.isNotEmpty() }
                is Sequence<*> -> cn(*part.toList().toTypedArray()).takeIf { it.isNotEmpty() }
                true -> null // clsx keeps bare `true` out of the class list too
                else -> part.toString()
            }
        }
        .joinToString(" ")
