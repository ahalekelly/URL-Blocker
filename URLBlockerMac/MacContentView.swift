import Foundation
import AppKit
import SafariServices
import SwiftUI

struct MacContentView: View {
    @Environment(\.scenePhase) private var scenePhase

    @State private var extensionState = ExtensionState.checking
    @State private var alert: AppAlert?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("URL Blocker")
                    .font(.largeTitle.bold())

                if extensionState == .disabled {
                    Text("Enable the Safari extension before blocking can run.")
                        .foregroundStyle(.secondary)
                }
            }

            if extensionState == .disabled {
                VStack(alignment: .leading, spacing: 10) {
                    StepRow(number: 1, text: "Open Safari Settings.")
                    StepRow(number: 2, text: "Go to Extensions.")
                    StepRow(number: 3, text: "Enable URL Blocker.")
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Button("Open Extension Settings", action: openExtensionSettings)
                    .buttonStyle(.bordered)

                Button("Open Blocklist Settings", action: openBlocklistSettings)
                    .buttonStyle(.bordered)
            }

        }
        .frame(width: 460, alignment: .leading)
        .padding(28)
        .task {
            refreshExtensionState()
        }
        .onChange(of: scenePhase) { phase in
            if phase != .active { return }

            refreshExtensionState()
        }
        .onOpenURL { url in
            MacExternalURLHandler.handle(url)
        }
        .alert(item: $alert) { alert in
            Alert(title: Text(alert.title), message: Text(alert.message), dismissButton: .default(Text("OK")))
        }
    }

    private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: MacSafari.extensionBundleIdentifier) { state, error in
            if let error {
                extensionState = .disabled
                alert = AppAlert(title: "Extension State Unavailable", error: error)
                return
            }

            guard let state = state else {
                extensionState = .disabled
                return
            }

            extensionState = state.isEnabled ? .enabled : .disabled
        }
    }

    private func openBlocklistSettings() {
        guard let script = NSAppleScript(source: MacSafari.openBlocklistScript) else {
            showEditorUnavailable("AppleScript source could not be compiled.\n\nCode: AppleScriptCompileFailed")
            return
        }

        var error: NSDictionary?
        script.executeAndReturnError(&error)

        guard let error else { return }

        showEditorUnavailable(DebugErrorMessage.describeAppleScript(error))
    }

    private func openExtensionSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: MacSafari.extensionBundleIdentifier) { error in
            DispatchQueue.main.async {
                guard let error else { return }

                alert = AppAlert(
                    title: "Open Safari Extension Settings",
                    message: "Safari could not open URL Blocker settings automatically. In Safari, choose Safari > Settings > Extensions, then select URL Blocker.\n\n\(DebugErrorMessage.describe(error))"
                )
            }
        }
    }

    private func showEditorUnavailable(_ detail: String) {
        alert = AppAlert(
            title: "Editor Unavailable",
            message: "Open Safari and click the URL Blocker toolbar button to open the blocklist.\n\n\(detail)"
        )
    }
}

private enum ExtensionState: Equatable {
    case checking
    case disabled
    case enabled
}

enum MacExternalURLHandler {
    private static let pendingOptionsURLKey = "PendingSafariOptionsURL"

    static func handle(_ url: URL) {
        if url.scheme != "urlblocker" { return }

        switch url.host {
        case "open":
            _ = runScript(
                MacSafari.openBlocklistScript,
                title: "Editor Unavailable",
                message: "Open Safari and click the URL Blocker toolbar button to open the blocklist."
            )
        case "sign-in":
            guard let provider = provider(from: url) else { return }

            signIn(provider: provider)
        case "supabase-auth":
            completeSignIn(url)
        default:
            return
        }
    }

    private static func provider(from url: URL) -> NativeSupabaseAuth.Provider? {
        guard let providerName = url.pathComponents.dropFirst().first,
              let provider = NativeSupabaseAuth.Provider(rawValue: providerName) else {
            showError(title: "Sign In Failed", message: "URL Blocker received an unknown sign-in provider.")
            return nil
        }

        return provider
    }

    private static func signIn(provider: NativeSupabaseAuth.Provider) {
        guard let optionsURL = currentOptionsURL() else { return }

        UserDefaults.standard.set(optionsURL, forKey: pendingOptionsURLKey)

        do {
            let authURL = try NativeSupabaseAuth.authorizationURL(
                provider: provider,
                extensionBundleName: MacSafari.extensionBundleName
            )

            NSWorkspace.shared.open(authURL)
        } catch {
            showError(title: "Sign In Failed", message: DebugErrorMessage.describe(error))
        }
    }

    private static func completeSignIn(_ url: URL) {
        guard let parameters = url.fragment ?? url.query else {
            showError(title: "Sign In Failed", message: "Supabase sign-in did not return callback parameters.")
            return
        }

        guard let optionsURL = UserDefaults.standard.string(forKey: pendingOptionsURLKey) ?? currentOptionsURL() else { return }

        let completed = runScript(
            MacSafari.completeSignInScript(optionsURL: optionsURL, parameters: parameters),
            title: "Sign In Failed",
            message: "URL Blocker could not reopen the Safari sync pane."
        )

        if completed {
            UserDefaults.standard.removeObject(forKey: pendingOptionsURLKey)
        }
    }

    private static func currentOptionsURL() -> String? {
        guard let script = NSAppleScript(source: MacSafari.optionsURLScript) else {
            showError(title: "Sign In Failed", message: "AppleScript source could not be compiled.\n\nCode: AppleScriptCompileFailed")
            return nil
        }

        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)

        if let error {
            showError(
                title: "Sign In Failed",
                message: "Open Safari and click the URL Blocker toolbar button before signing in.\n\n\(DebugErrorMessage.describeAppleScript(error))"
            )
            return nil
        }

        guard let url = result.stringValue else {
            showError(title: "Sign In Failed", message: "Safari did not return a URL Blocker options page URL.")
            return nil
        }

        return url
    }

    private static func runScript(_ source: String, title: String, message: String) -> Bool {
        guard let script = NSAppleScript(source: source) else {
            showError(title: title, message: "\(message)\n\nCode: AppleScriptCompileFailed")
            return false
        }

        var error: NSDictionary?
        script.executeAndReturnError(&error)

        guard let error else { return true }

        showError(title: title, message: "\(message)\n\n\(DebugErrorMessage.describeAppleScript(error))")
        return false
    }

    private static func showError(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }
}

private enum MacSafari {
    static let extensionBundleIdentifier = "com.akelly.URLBlockerMac.Extension"
    static let extensionBundleName = "URLBlockerMacExtension"
    static let optionsURLScript = """
    tell application "Safari"
        if (count of windows) is greater than 0 then
            set tabURL to URL of current tab of front window

            if tabURL is not missing value then
                if tabURL starts with "safari-web-extension://" and tabURL contains "/options.html" then
                    set AppleScript's text item delimiters to "#"
                    set baseURL to text item 1 of tabURL
                    set AppleScript's text item delimiters to ""
                    return baseURL
                end if
            end if
        end if

        repeat with safariWindow in windows
            repeat with safariTab in tabs of safariWindow
                set tabURL to URL of safariTab

                if tabURL is not missing value then
                    if tabURL starts with "safari-web-extension://" and tabURL contains "/options.html" then
                        set AppleScript's text item delimiters to "#"
                        set baseURL to text item 1 of tabURL
                        set AppleScript's text item delimiters to ""
                        return baseURL
                    end if
                end if
            end repeat
        end repeat

        error "URL Blocker options page is not open."
    end tell
    """

    static func completeSignInScript(optionsURL: String, parameters: String) -> String {
        """
        tell application "Safari"
            set optionsURL to "\(appleScriptString(optionsURL))"
            set callbackURL to optionsURL & "#" & "\(appleScriptString(parameters))"

            repeat with safariWindow in windows
                repeat with safariTab in tabs of safariWindow
                    set tabURL to URL of safariTab

                    if tabURL is not missing value then
                        set AppleScript's text item delimiters to "#"
                        set baseURL to text item 1 of tabURL
                        set AppleScript's text item delimiters to ""

                        if baseURL is optionsURL then
                            set URL of safariTab to callbackURL
                            set current tab of safariWindow to safariTab
                            set index of safariWindow to 1
                            activate
                            return
                        end if
                    end if
                end repeat
            end repeat

            activate
            open location callbackURL
        end tell
        """
    }

    static let openBlocklistScript = """
    tell application "Safari"
        repeat with safariWindow in windows
            repeat with safariTab in tabs of safariWindow
                set tabURL to URL of safariTab

                if tabURL is not missing value then
                    if tabURL starts with "safari-web-extension://" and tabURL contains "/options.html" then
                        set current tab of safariWindow to safariTab
                        set index of safariWindow to 1
                        activate
                        return
                    end if
                end if
            end repeat
        end repeat

        error "URL Blocker options page is not open."
    end tell
    """

    private static func appleScriptString(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
}

private struct StepRow: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(String(number))
                .font(.caption.bold())
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Color.accentColor, in: Circle())

            Text(text)
        }
    }
}

private struct AppAlert: Identifiable {
    let id = UUID()
    let title: String
    let message: String

    init(title: String, message: String) {
        self.title = title
        self.message = message
    }

    init(title: String, error: Error) {
        self.title = title
        self.message = DebugErrorMessage.describe(error)
    }
}

private enum DebugErrorMessage {
    static func describe(_ error: Error) -> String {
        let nsError = error as NSError

        return "\(nsError.localizedDescription)\n\nCode: \(nsError.domain) \(nsError.code)"
    }

    static func describeAppleScript(_ error: NSDictionary) -> String {
        let message = error["NSAppleScriptErrorMessage"] as? String ?? "AppleScript failed."
        let number = error["NSAppleScriptErrorNumber"] as? NSNumber

        return "\(message)\n\nCode: AppleScript \(number?.stringValue ?? "unknown")"
    }
}
