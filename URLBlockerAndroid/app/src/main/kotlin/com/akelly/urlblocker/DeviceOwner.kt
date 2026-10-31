package com.akelly.urlblocker

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.UserManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

// Device Owner is set once over adb (see docs/android-plan.md). Android calls
// onEnabled then; the policies are applied again whenever the service starts
// or an app is installed, so a newly installed browser is hidden at once.
class DeviceOwnerReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) = DeviceOwner.apply(context)
}

object DeviceOwner {
    private const val TAG = "URLBlocker"
    private const val VIVALDI = "com.vivaldi.browser"

    // Derived from the "key" in ChromeExtension/manifest.json.
    private const val URL_BLOCKER_EXTENSION_ID = "codockenjkigoanmejjcfnlhcfeiemhf"
    private const val UBLOCK_ORIGIN_LITE_ID = "ddkjiahejlhfcafbddmgiahcphecmpfh"
    private const val CHROME_WEB_STORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx"
    private val HIDDEN_APPS = listOf("com.google.android.youtube")

    fun isActive(context: Context) = context.getSystemService(DevicePolicyManager::class.java).isDeviceOwnerApp(context.packageName)

    fun apply(context: Context) {
        if (!isActive(context)) return
        val policy = context.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(context, DeviceOwnerReceiver::class.java)
        policy.setUninstallBlocked(admin, context.packageName, true)
        policy.setUninstallBlocked(admin, VIVALDI, true)
        policy.addUserRestriction(admin, UserManager.DISALLOW_APPS_CONTROL)
        policy.addUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT)
        val hidden = (browsers(context) + HIDDEN_APPS).filter { it != VIVALDI }
        hidden.forEach { policy.setApplicationHidden(admin, it, true) }
        policy.setApplicationRestrictions(admin, VIVALDI, vivaldiPolicies(context))
        Log.i(TAG, "Device Owner policies applied, hid ${hidden.joinToString(", ")}")
    }

    // Browsers are the apps that open any https link, not just their own
    // site's. Hidden apps no longer show up here.
    private fun browsers(context: Context) = context.packageManager
        .queryIntentActivities(
            Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/")).addCategory(Intent.CATEGORY_BROWSABLE),
            PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_ALL.toLong()),
        )
        .map { it.activityInfo.packageName }
        .distinct()

    // Vivaldi reads Chrome's enterprise policies from its managed
    // configuration, with list policies as JSON strings. Force-installed
    // extensions can't be disabled or removed.
    private fun vivaldiPolicies(context: Context): Bundle {
        val config = JSONObject(context.assets.open("supabase-config.json").bufferedReader().readText())
        val updateUrl = "${config.getString("supabaseUrl")}/storage/v1/object/public/chromium-extension/updates.xml"
        val forcelist = JSONArray(listOf("$URL_BLOCKER_EXTENSION_ID;$updateUrl", "$UBLOCK_ORIGIN_LITE_ID;$CHROME_WEB_STORE_UPDATE_URL"))
        return Bundle().apply { putString("ExtensionInstallForcelist", forcelist.toString()) }
    }
}
