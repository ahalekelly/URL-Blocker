import SafariServices
import SwiftUI
import UIKit

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase

    @State private var extensionState = ExtensionState.checking
    @State private var alert: AppAlert?

    var body: some View {
        NavigationStack {
            List {
                if extensionState == .disabled {
                    Section {
                        Text("Enable the Safari extension before blocking can run.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }

                    Section("Enable Extension") {
                        StepRow(number: 1, text: "Open Settings.")
                        StepRow(number: 2, text: "Go to Safari.")
                        StepRow(number: 3, text: "Go to Extensions.")
                        StepRow(number: 4, text: "Enable URL Blocker.")
                    }
                }

                Section {
                    Button("Open Extension Settings", action: openExtensionSettings)
                    Button("Open Blocklist Settings", action: openBlocklistSettings)
                }
            }
            .navigationTitle("URL Blocker")
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
    }

    private func refreshExtensionState() {
        Task { @MainActor in
            if #available(iOS 26.2, *) {
                do {
                    let state = try await SFSafariExtensionManager.stateOfExtension(withIdentifier: Safari.extensionBundleIdentifier)
                    extensionState = state.isEnabled ? .enabled : .disabled
                } catch {
                    extensionState = .disabled
                }
                return
            }

            extensionState = .disabled
        }
    }

    private func openExtensionSettings() {
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

    private func openBlocklistSettings() {
        openExtensionSettings()
    }
}

private enum ExtensionState: Equatable {
    case checking
    case disabled
    case enabled
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
