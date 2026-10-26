package com.akelly.urlblocker

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.PixelFormat
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

// Watches the visible apps and covers them with the block screen when
// BlockerCore, running in a headless WebView, says their site is blocked.
class BlockerService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            step()
            persistUsage()
            handler.postDelayed(this, TICK_MS)
        }
    }

    // Screen off ends the current interval, so the time before it still
    // counts; unlocking steps at once, so counting restarts promptly.
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    step(screenInUseNow = false)
                    persistUsage()
                }
                Intent.ACTION_USER_PRESENT -> step()
                else -> throw IllegalStateException("Unexpected broadcast: ${intent.action}")
            }
        }
    }
    private lateinit var engine: WebView
    private lateinit var settingsObserver: FileObserver
    private var engineStarted = false
    private var engineReady = false
    private var screenInUse = false
    private var visiblePackages = emptyList<String>()
    private var lastStepMs = 0L
    private var overlay: WebView? = null
    private var shownBlock: String? = null

    @Volatile
    private var blockPage = JSONObject()

    override fun onServiceConnected() {
        val settingsFile = settingsFile(this)
        settingsObserver = object : FileObserver(settingsFile.parentFile!!, CLOSE_WRITE or MOVED_TO or DELETE or MOVED_FROM) {
            override fun onEvent(event: Int, path: String?) {
                if (path == settingsFile.name) handler.post { loadSettings() }
            }
        }
        engine = WebView(this)
        engine.settings.javaScriptEnabled = true
        engine.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                if (engineStarted) return
                engineStarted = true
                startEngine()
            }
        }
        engine.loadUrl("file:///android_asset/engine.html")
    }

    private fun startEngine() {
        val defaults = assets.open("default-blocked-pages.json").bufferedReader().readText()
        val usageFile = File(filesDir, USAGE_FILE)
        val usage = if (usageFile.exists()) JSONObject.quote(usageFile.readText()) else "null"
        call("AndroidEngine.start(${JSONObject.quote(defaults)}, $usage)") {
            engineReady = true
            screenInUse = isScreenInUse()
            lastStepMs = System.currentTimeMillis()
            registerReceiver(
                screenReceiver,
                IntentFilter().apply {
                    addAction(Intent.ACTION_SCREEN_OFF)
                    addAction(Intent.ACTION_USER_PRESENT)
                },
                RECEIVER_NOT_EXPORTED,
            )
            settingsObserver.startWatching()
            loadSettings()
            handler.postDelayed(tick, TICK_MS)
        }
    }

    private fun loadSettings() {
        val file = settingsFile(this)
        val text = if (file.exists()) JSONObject.quote(file.readText()) else "null"
        call("AndroidEngine.loadSettings($text)") { value ->
            val result = value as JSONObject
            Status.settings = when (val type = result.getString("type")) {
                "valid" -> "Loaded from ${file.path}"
                "missing" -> "No settings file at ${file.path}"
                "invalid" -> "Invalid, nothing is blocked:\n${result.getString("message")}"
                else -> throw IllegalStateException("Unknown settings result: $type")
            }
            Log.i(TAG, "Settings: ${Status.settings}")
            step()
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) = step()

    // Credits the time since the last step to the apps that were visible, then
    // judges the apps visible now. Steps run on window changes and on every
    // tick, so schedules starting and limits running out take effect while an
    // app stays open. Visible apps include split screen and picture-in-picture.
    // An interval counts only if the screen was on and unlocked at its start.
    private fun step(screenInUseNow: Boolean = isScreenInUse()) {
        if (!engineReady) return
        val nowMs = System.currentTimeMillis()
        val counted = if (screenInUse) visiblePackages else emptyList()
        screenInUse = screenInUseNow
        val elapsedMs = nowMs - lastStepMs
        lastStepMs = nowMs
        visiblePackages = appWindows().mapNotNull { it.root?.packageName?.toString() }.distinct()
        call("AndroidEngine.step(${JSONArray(counted)}, $elapsedMs, ${JSONArray(visiblePackages)}, $nowMs)") { value ->
            val decision = value as JSONObject
            when (val type = decision.getString("type")) {
                "noSettings" -> Status.lastDecision = "No settings loaded"
                "allowed" -> Status.lastDecision = "Allowed ${decision.getJSONArray("packages").join(", ")}"
                "blocked" -> block(decision)
                else -> throw IllegalStateException("Unknown decision: $type")
            }
        }
    }

    private fun isScreenInUse() = getSystemService(PowerManager::class.java).isInteractive &&
        !getSystemService(KeyguardManager::class.java).isKeyguardLocked

    private fun appWindows() = windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }

    // The overlay covers the screen at once. Going home and closing
    // picture-in-picture move the app to the background without stopping it,
    // so its notifications keep arriving. Going home can itself put the app in
    // picture-in-picture, so that is closed on every step it shows up.
    private fun block(decision: JSONObject) {
        val packageName = decision.getString("packageName")
        val block = "$packageName (${decision.getString("reason")})"
        Status.lastDecision = "Blocked $block"
        appWindows()
            .filter { it.isInPictureInPictureMode && it.root?.packageName == packageName }
            .forEach { it.root?.performAction(AccessibilityNodeInfo.ACTION_DISMISS) }
        if (block == shownBlock) return
        shownBlock = block
        Log.i(TAG, Status.lastDecision)
        blockPage = decision
        overlay?.reload() ?: showOverlay()
        performGlobalAction(GLOBAL_ACTION_HOME)
    }

    private fun showOverlay() {
        val view = WebView(this)
        view.settings.javaScriptEnabled = true
        view.addJavascriptInterface(BlockScreen(), "AndroidBlockScreen")
        view.loadUrl("file:///android_asset/blocked.html")
        getSystemService(WindowManager::class.java).addView(
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
    }

    private fun closeOverlay() {
        val view = overlay ?: return
        getSystemService(WindowManager::class.java).removeView(view)
        view.destroy()
        overlay = null
        shownBlock = null
    }

    // Called from blocked.js on a WebView thread.
    private inner class BlockScreen {
        @JavascriptInterface
        fun page() = blockPage.toString()

        @JavascriptInterface
        fun close() {
            handler.post { closeOverlay() }
        }
    }

    private fun persistUsage() {
        if (!engineReady) return
        call("AndroidEngine.takeDirtyUsage()") { value ->
            if (value == JSONObject.NULL) return@call
            val temp = File(filesDir, "$USAGE_FILE.tmp")
            temp.writeText(value as String)
            Files.move(temp.toPath(), File(filesDir, USAGE_FILE).toPath(), StandardCopyOption.ATOMIC_MOVE)
        }
    }

    private fun call(script: String, done: (Any?) -> Unit) {
        engine.evaluateJavascript(script) { json ->
            val result = JSONObject(json)
            when (val type = result.getString("type")) {
                "ok" -> done(result.get("value"))
                "error" -> throw IllegalStateException("Engine error: ${result.getString("message")}")
                else -> throw IllegalStateException("Unknown engine result: $type")
            }
        }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        settingsObserver.stopWatching()
        if (engineReady) unregisterReceiver(screenReceiver)
        closeOverlay()
        engine.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "URLBlocker"
        private const val TICK_MS = 15_000L
        private const val USAGE_FILE = "screen-time-usage.json"

        fun settingsFile(context: Context) = File(context.getExternalFilesDir(null), "settings.json")
    }
}

// Shared with StatusActivity, which runs in the same process.
object Status {
    var settings = "Accessibility service not running"
    var lastDecision = "None yet"
}
