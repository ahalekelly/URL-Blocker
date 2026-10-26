package com.akelly.urlblocker

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.text.Html
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.File

// Watches the foreground app and covers it with the block screen when
// BlockerCore, running in a headless WebView, says its site is blocked.
class BlockerService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            step()
            handler.postDelayed(this, TICK_MS)
        }
    }
    private lateinit var engine: WebView
    private lateinit var settingsObserver: FileObserver
    private var engineReady = false
    private var foreground: String? = null
    private var lastStepMs = 0L
    private var overlay: View? = null

    override fun onServiceConnected() {
        val settingsFile = settingsFile(this)
        settingsObserver = object : FileObserver(settingsFile.parentFile!!, CLOSE_WRITE or MOVED_TO) {
            override fun onEvent(event: Int, path: String?) {
                if (path == settingsFile.name) handler.post { loadSettings() }
            }
        }
        engine = WebView(this)
        engine.settings.javaScriptEnabled = true
        engine.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) = startEngine()
        }
        engine.loadUrl("file:///android_asset/engine.html")
    }

    private fun startEngine() {
        val defaults = assets.open("default-blocked-pages.json").bufferedReader().readText()
        val usageFile = File(filesDir, USAGE_FILE)
        val usage = if (usageFile.exists()) JSONObject.quote(usageFile.readText()) else "null"
        call("AndroidEngine.start(${JSONObject.quote(defaults)}, $usage)") {
            engineReady = true
            lastStepMs = System.currentTimeMillis()
            settingsObserver.startWatching()
            loadSettings()
            handler.postDelayed(tick, TICK_MS)
        }
    }

    private fun loadSettings() {
        val file = settingsFile(this)
        if (!file.exists()) {
            Status.settings = "No settings file at ${file.path}"
            return
        }
        call("AndroidEngine.loadSettings(${JSONObject.quote(file.readText())})") { value ->
            val result = value as JSONObject
            Status.settings = when (val type = result.getString("type")) {
                "valid" -> "Loaded from ${file.path}"
                "invalid" -> "Invalid, nothing is blocked:\n${result.getString("message")}"
                else -> throw IllegalStateException("Unknown settings result: $type")
            }
            Log.i(TAG, "Settings: ${Status.settings}")
            step()
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (engineReady) step()
    }

    // Credits the time since the last step to the app that was in front, as
    // long as the screen was on and unlocked, then judges the app in front now.
    // Steps run on window changes and on every tick, so schedules starting and
    // limits running out take effect while an app stays open.
    private fun step() {
        val nowMs = System.currentTimeMillis()
        val screenInUse = getSystemService(PowerManager::class.java).isInteractive &&
            !getSystemService(KeyguardManager::class.java).isKeyguardLocked
        val previous = if (screenInUse) foreground else null
        val elapsedMs = minOf(nowMs - lastStepMs, MAX_ELAPSED_MS)
        lastStepMs = nowMs
        foreground = windows
            .firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.isActive }
            ?.root?.packageName?.toString()
        call("AndroidEngine.step(${jsString(previous)}, $elapsedMs, ${jsString(foreground)}, $nowMs)") { value ->
            val result = value as JSONObject
            if (!result.isNull("usage")) File(filesDir, USAGE_FILE).writeText(result.getString("usage"))
            val decision = result.getJSONObject("decision")
            when (val type = decision.getString("type")) {
                "noSettings" -> Status.lastDecision = "No settings loaded"
                "allowed" -> Status.lastDecision = "Allowed ${decision.optString("packageName")}"
                "blocked" -> {
                    Status.lastDecision = "Blocked ${decision.getString("packageName")} (${decision.getString("reason")})"
                    Log.i(TAG, Status.lastDecision)
                    block(decision.getString("blockedPageHtml"), reasonText(decision.getString("reason")))
                }
                else -> throw IllegalStateException("Unknown decision: $type")
            }
        }
    }

    // The overlay covers the app at once; going home moves it to the
    // background without stopping it, so its notifications keep arriving.
    private fun block(blockedPageHtml: String, reason: String) {
        val windowManager = getSystemService(WindowManager::class.java)
        overlay?.let(windowManager::removeView)
        val view = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.WHITE)
            setPadding(64, 64, 64, 64)
            addView(TextView(context).apply {
                text = Html.fromHtml(blockedPageHtml, Html.FROM_HTML_MODE_COMPACT)
                setTextColor(Color.BLACK)
                textSize = 20f
            })
            addView(TextView(context).apply {
                text = reason
                setTextColor(Color.DKGRAY)
                setPadding(0, 32, 0, 32)
            })
            addView(Button(context).apply {
                text = "Close"
                setOnClickListener {
                    windowManager.removeView(this@BlockerService.overlay)
                    this@BlockerService.overlay = null
                }
            })
        }
        windowManager.addView(
            view,
            WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                0,
                PixelFormat.OPAQUE,
            ),
        )
        overlay = view
        performGlobalAction(GLOBAL_ACTION_HOME)
    }

    private fun reasonText(reason: String) = when (reason) {
        "hardScheduleDomain" -> "This app is blocked during your hard block schedule."
        "scheduleDirectMatch" -> "This app is blocked during your schedule."
        "limitDirectMatch" -> "You've reached your time limit for this site."
        else -> throw IllegalStateException("Unknown block reason: $reason")
    }

    private fun call(script: String, done: (Any?) -> Unit) {
        engine.evaluateJavascript(script) { json ->
            val result = JSONObject(json)
            when (val type = result.getString("type")) {
                "ok" -> done(result.opt("value"))
                "error" -> throw IllegalStateException("Engine error: ${result.getString("message")}")
                else -> throw IllegalStateException("Unknown engine result: $type")
            }
        }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        settingsObserver.stopWatching()
        engine.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "URLBlocker"
        private const val TICK_MS = 15_000L
        // Steps can stall while the device sleeps; time without steps is not counted.
        private const val MAX_ELAPSED_MS = 30_000L
        private const val USAGE_FILE = "screen-time-usage.json"

        fun settingsFile(service: android.content.Context) = File(service.getExternalFilesDir(null), "settings.json")

        private fun jsString(value: String?) = if (value == null) "null" else JSONObject.quote(value)
    }
}

// Shared with StatusActivity, which runs in the same process.
object Status {
    var settings = "Accessibility service not running"
    var lastDecision = "None yet"
}
