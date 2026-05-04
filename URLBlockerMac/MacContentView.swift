import AppKit
import SafariServices
import SwiftUI

struct MacContentView: View {
    @State private var alert: AppAlert?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("URL Blocker")
                    .font(.largeTitle.bold())

                Text("Enable the Safari extension and allow website access before blocking can run.")
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 10) {
                StepRow(number: 1, text: "Open Safari Settings.")
                StepRow(number: 2, text: "Go to Extensions.")
                StepRow(number: 3, text: "Enable URL Blocker.")
                StepRow(number: 4, text: "Grant access to All Websites.")
            }

            HStack {
                Button("Open Safari Settings", action: openSafariSettings)
                    .buttonStyle(.bordered)

                Button("Open Blocklist Editor", action: openBlocklistEditor)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(width: 460, alignment: .leading)
        .padding(28)
        .alert(item: $alert) { alert in
            Alert(title: Text(alert.title), message: Text(alert.message), dismissButton: .default(Text("OK")))
        }
    }

    private func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: MacSafari.extensionBundleIdentifier) { error in
            DispatchQueue.main.async {
                if error == nil { return }

                alert = AppAlert(
                    title: "Safari Settings Unavailable",
                    message: "Safari cannot find URL Blocker right now. For this local build, open Safari, choose Develop > Allow Unsigned Extensions, then run URL Blocker again and open Safari Settings > Extensions."
                )
            }
        }
    }

    private func openBlocklistEditor() {
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
