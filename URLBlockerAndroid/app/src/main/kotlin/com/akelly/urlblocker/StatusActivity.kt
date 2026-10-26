package com.akelly.urlblocker

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityManager
import android.widget.ScrollView
import android.widget.TextView

class StatusActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            showStatus()
            handler.postDelayed(this, 1000)
        }
    }
    private lateinit var text: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        text = TextView(this).apply {
            setPadding(48, 48, 48, 48)
            textSize = 16f
        }
        setContentView(ScrollView(this).apply {
            fitsSystemWindows = true
            addView(text)
        })
    }

    override fun onResume() {
        super.onResume()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    private fun showStatus() {
        val serviceEnabled = getSystemService(AccessibilityManager::class.java)
            .getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { it.resolveInfo.serviceInfo.packageName == packageName }
        text.text = listOf(
            "Accessibility service: ${if (serviceEnabled) "enabled" else "disabled"}",
            "Settings: ${Status.settings}",
            "Last decision: ${Status.lastDecision}",
        ).joinToString("\n\n")
    }
}
