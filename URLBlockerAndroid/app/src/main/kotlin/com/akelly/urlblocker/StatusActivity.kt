package com.akelly.urlblocker

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.DateUtils
import android.view.View
import android.view.accessibility.AccessibilityManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

// Shows status and handles sign-in. Google sign-in opens in the browser and
// returns through the urlblocker://supabase-auth redirect.
class StatusActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            showStatus()
            handler.postDelayed(this, 1000)
        }
    }
    private lateinit var text: TextView
    private lateinit var signIn: Button
    private lateinit var signOut: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        text = TextView(this).apply { textSize = 16f }
        signIn = Button(this).apply {
            text = "Sign in with Google"
            setOnClickListener { BlockerService.running?.signInUrl { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } }
        }
        signOut = Button(this).apply {
            text = "Sign out"
            setOnClickListener { BlockerService.running?.signOut() }
        }
        setContentView(ScrollView(this).apply {
            fitsSystemWindows = true
            addView(LinearLayout(this@StatusActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(48, 48, 48, 48)
                addView(text)
                addView(signIn)
                addView(signOut)
            })
        })
        if (savedInstanceState == null) handleRedirect(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleRedirect(intent)
    }

    private fun handleRedirect(intent: Intent) {
        val url = intent.data ?: return
        val service = BlockerService.running
        if (service == null) {
            Toast.makeText(this, "Turn on the accessibility service, then sign in again.", Toast.LENGTH_LONG).show()
            return
        }
        service.completeSignIn(url.toString())
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
        val sync = Status.sync
        val email = sync?.takeUnless { it.isNull("email") }?.getString("email")
        text.text = (
            listOf("Accessibility service: ${if (serviceEnabled) "enabled" else "disabled"}") +
                (if (sync == null) listOf("Sync: waiting for the accessibility service") else syncLines(sync, email)) +
                listOf("Last decision: ${Status.lastDecision}")
            ).joinToString("\n\n")
        signIn.visibility = if (sync != null && email == null) View.VISIBLE else View.GONE
        signOut.visibility = if (email != null) View.VISIBLE else View.GONE
    }

    private fun syncLines(sync: JSONObject, email: String?) = listOfNotNull(
        "Account: ${email ?: "signed out"}",
        "Last sync: ${if (sync.isNull("lastSyncMs")) "never" else relativeTime(sync.getLong("lastSyncMs"))}",
        sync.getString("error").takeIf { it.isNotEmpty() }?.let { "Sync error: $it" },
        if (sync.isNull("pendingSettingsAtMs")) null else "Settings change takes effect ${relativeTime(sync.getLong("pendingSettingsAtMs"))}",
    )

    private fun relativeTime(ms: Long) = DateUtils.getRelativeTimeSpanString(ms, System.currentTimeMillis(), DateUtils.SECOND_IN_MILLIS)
}
