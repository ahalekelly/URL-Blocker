import SafariServices
import SwiftUI
import UIKit

struct ContentView: View {
    @State private var alert: AppAlert?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Enable the Safari extension and allow website access before blocking can run.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }

                Section("Enable Extension") {
                    StepRow(number: 1, text: "Open Settings.")
                    StepRow(number: 2, text: "Go to Safari.")
                    StepRow(number: 3, text: "Go to Extensions.")
                    StepRow(number: 4, text: "Enable URL Blocker.")
                    StepRow(number: 5, text: "Grant access to All Websites.")
                }

                Section {
                    Button("Open Settings", action: openSettings)
                    Button("Open Blocklist Editor", action: openBlocklistEditor)
                }
            }
            .navigationTitle("URL Blocker")
            .alert(item: $alert) { alert in
                Alert(title: Text(alert.title), message: Text(alert.message), dismissButton: .default(Text("OK")))
            }
        }
    }

    private func openSettings() {
        if #available(iOS 26.2, *) {
            Task { @MainActor in
                do {
                    try await SFSafariSettings.openExtensionsSettings(forIdentifiers: [Safari.extensionBundleIdentifier])
                } catch {
                    alert = AppAlert(title: "Settings Unavailable", message: error.localizedDescription)
                }
            }
            return
        }

        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            alert = AppAlert(title: "Settings Unavailable", message: "iOS did not provide an app Settings URL.")
            return
        }

        UIApplication.shared.open(url) { success in
            if !success {
                alert = AppAlert(title: "Settings Unavailable", message: "Open iOS Settings, then go to Safari > Extensions.")
            }
        }
    }

    private func openBlocklistEditor() {
        openSettings()
    }
}

private enum Safari {
    static let extensionBundleIdentifier = "com.akelly.URLBlockerIOS.Extension"
}

private struct StepRow: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(String(number))
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 24, height: 24)
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
