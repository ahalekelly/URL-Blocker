plugins {
    id("com.android.application")
}

android {
    namespace = "com.akelly.urlblocker"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.akelly.urlblocker"
        minSdk = 36
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
    }
}

// The engine runs the extension's own scripts, copied in at build time.
abstract class CopySharedAssets @Inject constructor(private val files: FileSystemOperations) : DefaultTask() {
    @get:InputFiles
    abstract val sharedFiles: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        files.sync {
            from(sharedFiles)
            into(outputDir)
        }
    }
}

val copySharedAssets = tasks.register<CopySharedAssets>("copySharedAssets") {
    sharedFiles.from(
        listOf("blocker.js", "supabase-sync.js", "default-blocked-pages.json", "blocked.html", "blocked.css")
            .map { rootProject.file("../URLBlockerWebExtension/$it") }
    )
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets!!.addGeneratedSourceDirectory(copySharedAssets, CopySharedAssets::outputDir)
    }
}
