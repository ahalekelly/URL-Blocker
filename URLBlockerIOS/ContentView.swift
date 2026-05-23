import SafariServices
import SwiftUI
import UIKit
import WebKit

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase

    @State private var appScreen = AppScreen.setup
    @State private var extensionState = ExtensionState.checking
    @State private var alert: AppAlert?

    var body: some View {
        NavigationStack {
            switch appScreen {
            case .setup:
                setupView
            case .blocklist:
                BlocklistWebView()
                    .navigationTitle("Blocklist")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        Button("Open Extension Settings", action: openExtensionSettings)
                    }
            }
        }
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

    private var setupView: some View {
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
    }

    private func refreshExtensionState() {
        Task { @MainActor in
            if #available(iOS 26.2, *) {
                do {
                    let state = try await SFSafariExtensionManager.stateOfExtension(withIdentifier: Safari.extensionBundleIdentifier)
                    extensionState = state.isEnabled ? .enabled : .disabled
                    if state.isEnabled {
                        appScreen = .blocklist
                    }
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
        appScreen = .blocklist
    }
}

private struct BlocklistWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let userContentController = WKUserContentController()
        userContentController.addUserScript(WKUserScript(source: Self.browserShim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        userContentController.add(context.coordinator, name: "blocklist")
        configuration.userContentController = userContentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        webView.loadFileURL(Safari.optionsPageURL, allowingReadAccessTo: Safari.resourcesURL)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let id = body["id"] as? String else {
                return
            }

            guard let request = body["message"] as? [String: Any] else {
                reply(id: id, response: ["type": "error", "error": "Blocklist message must include a message object."])
                return
            }

            reply(id: id, response: NativeBlocklistStore.handle(request))
        }

        private func reply(id: String, response: [String: Any]) {
            let payload: [String: Any] = ["id": id, "response": response]
            let data = try! JSONSerialization.data(withJSONObject: payload)
            let json = String(data: data, encoding: .utf8)!
            webView?.evaluateJavaScript("__URLBlockerReply(\(json));")
        }
    }

    private static var browserShim: String {
        [
            nativeBrowserShim,
            Safari.resourceText("blocker", withExtension: "js"),
            Safari.resourceText("background", withExtension: "js"),
            backgroundControllerShim
        ].joined(separator: "\n")
    }

    private static let nativeBrowserShim = """
    (() => {
      const callbacks = new Map();
      let nextId = 0;

      window.__URLBlockerReply = (reply) => {
        const callback = callbacks.get(reply.id);
        if (!callback) { return; }

        callbacks.delete(reply.id);
        callback(reply.response);
      };

      function sendNativeMessage(_applicationId, message) {
        return new Promise((resolve) => {
          const id = String(++nextId);
          callbacks.set(id, resolve);
          window.webkit.messageHandlers.blocklist.postMessage({ id, message });
        });
      }

      const api = {
        runtime: {
          getManifest: () => ({ host_permissions: [] }),
          getPlatformInfo: () => Promise.resolve({ os: "ios" }),
          getURL: (path) => new URL(path, document.baseURI).href,
          sendNativeMessage
        },
        permissions: {
          contains: () => Promise.resolve(true),
          getAll: () => Promise.resolve({ origins: [] }),
          remove: () => Promise.resolve(true),
          request: () => Promise.resolve(true)
        },
        scripting: {
          getRegisteredContentScripts: () => Promise.resolve([]),
          registerContentScripts: () => Promise.resolve(),
          unregisterContentScripts: () => Promise.resolve()
        },
        tabs: {
          create: () => Promise.resolve(),
          getCurrent: () => Promise.resolve(null),
          query: () => Promise.resolve([]),
          remove: () => Promise.resolve(),
          update: () => Promise.resolve()
        }
      };

      window.browser = api;
      window.chrome = api;
    })();
    """

    private static let backgroundControllerShim = """
    (() => {
      const controller = window.BackgroundController.createBackgroundController(window.browser);

      window.browser.runtime.sendMessage = (message) => controller
        .handleMessage(message, {})
        .catch((error) => ({ type: "error", error: error.message }));
      window.chrome = window.browser;
    })();
    """
}

private enum AppScreen {
    case setup
    case blocklist
}

private enum ExtensionState: Equatable {
    case checking
    case disabled
    case enabled
}

private enum Safari {
    static let extensionBundleIdentifier = "com.akelly.URLBlockerIOS.Extension"
    static let extensionBundleName = "URLBlockerIOSExtension"

    static var optionsPageURL: URL {
        guard let url = extensionBundle.url(forResource: "options", withExtension: "html") else {
            fatalError("Missing options.html in Safari extension resources.")
        }

        return url
    }

    static var resourcesURL: URL {
        optionsPageURL.deletingLastPathComponent()
    }

    static func resourceText(_ name: String, withExtension fileExtension: String) -> String {
        guard let url = extensionBundle.url(forResource: name, withExtension: fileExtension) else {
            fatalError("Missing \(name).\(fileExtension) in Safari extension resources.")
        }

        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            fatalError("Could not load \(name).\(fileExtension) from Safari extension resources.")
        }

        return text
    }

    private static var extensionBundle: Bundle {
        guard let pluginsURL = Bundle.main.builtInPlugInsURL else {
            fatalError("Missing app plug-ins directory.")
        }

        let bundleURL = pluginsURL.appendingPathComponent("\(extensionBundleName).appex")

        guard let bundle = Bundle(url: bundleURL) else {
            fatalError("Missing URL Blocker extension bundle.")
        }

        return bundle
    }
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
