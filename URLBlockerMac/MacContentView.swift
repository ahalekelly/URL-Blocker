import Foundation
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
        .alert(item: $alert) { alert in
            Alert(title: Text(alert.title), message: Text(alert.message), dismissButton: .default(Text("OK")))
        }
    }

    private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: MacSafari.extensionBundleIdentifier) { state, _ in
            guard let state = state else {
                extensionState = .disabled
                return
            }

            extensionState = state.isEnabled ? .enabled : .disabled
        }
    }

    private func openExtensionSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: MacSafari.extensionBundleIdentifier) { error in
            DispatchQueue.main.async {
                if error == nil { return }

                alert = AppAlert(
                    title: "Open Safari Extension Settings",
                    message: "Safari could not open URL Blocker settings automatically. In Safari, choose Safari > Settings > Extensions, then select URL Blocker."
                )
            }
        }
    }

    private func openBlocklistSettings() {
        guard let script = NSAppleScript(source: MacSafari.openBlocklistScript) else {
            showEditorUnavailable()
            return
        }

        var error: NSDictionary?
        script.executeAndReturnError(&error)

        if error == nil { return }

        showEditorUnavailable()
    }

    private func showEditorUnavailable() {
        alert = AppAlert(
            title: "Editor Unavailable",
            message: "Open Safari and click the URL Blocker toolbar button to open the blocklist."
        )
    }
}

private enum ExtensionState: Equatable {
    case checking
    case disabled
    case enabled
}

private enum MacSafari {
    static let extensionBundleIdentifier = "com.akelly.URLBlockerMac.Extension"
    static let openBlocklistScript = """
    tell application "Safari"
        repeat with safariWindow in windows
            repeat with safariTab in tabs of safariWindow
                set tabURL to URL of safariTab

                if tabURL starts with "safari-web-extension://" and tabURL ends with "/options.html" and name of safariTab is "URL Blocker" then
                    set current tab of safariWindow to safariTab
                    set index of safariWindow to 1
                    activate
                    return
                end if
            end repeat
        end repeat

        error "URL Blocker options page is not open."
    end tell
    """
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
}
