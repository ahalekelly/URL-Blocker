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

            HStack {
                Button("Open Extension Settings", action: openExtensionSettings)
                    .buttonStyle(.bordered)

                Button("Open Blocklist Settings", action: openBlocklistSettings)
                    .buttonStyle(.borderedProminent)
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
                guard let error = error else { return }

                let nsError = error as NSError

                alert = AppAlert(
                    title: "Safari Settings Unavailable",
                    message: "Open Safari, choose Safari > Settings > Extensions, then enable URL Blocker. Safari returned: \(error.localizedDescription) (\(nsError.domain) \(nsError.code))."
                )
            }
        }
    }

    private func openBlocklistSettings() {
        SFSafariExtension.getBaseURI { baseURI in
            DispatchQueue.main.async {
                guard let url = baseURI?.appendingPathComponent("options.html") else {
                    alert = AppAlert(title: "Editor Unavailable", message: "Enable the Safari extension, then try again.")
                    return
                }

                if !NSWorkspace.shared.open(url) {
                    alert = AppAlert(title: "Editor Unavailable", message: "Open Safari extension settings, then choose Extension Settings.")
                }
            }
        }
    }
}

private enum ExtensionState: Equatable {
    case checking
    case disabled
    case enabled
}

private enum MacSafari {
    static let extensionBundleIdentifier = "com.akelly.URLBlockerMac.Extension"
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
