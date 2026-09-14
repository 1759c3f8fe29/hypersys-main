package com.hypersys

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/**
 * Scaffold activity. The chat surface (conversation list, message bubbles,
 * composer) is ported file-by-file from the web app under src/ — this file
 * grows as those ports land, and nothing else claims it.
 */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
    }
}
