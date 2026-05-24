import Foundation
import SafariServices
import SwiftUI
import UIKit
import WebKit

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase

    @State private var appScreen = AppScreen.setup
    @State private var extensionState = ExtensionState.checking
    @State private var alert: AppAlert?
    @State private var syncState = NativeSyncState.current

    var body: some View {
        NavigationStack {
            switch appScreen {
            case .setup:
                setupView
            case .blocklist:
                VStack(spacing: 0) {
                    BlocklistWebView { error in
                        alert = AppAlert(title: "Blocklist Load Failed", error: error)
                    }
                    syncControls
                        .padding()
                        .background(.bar)
                }
                    .navigationTitle("Blocklist")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        Button("Open Extension Settings", action: openExtensionSettings)
                    }
            }
        }
        .task {
            refreshExtensionState()
            refreshSyncState()
        }
        .onChange(of: scenePhase) { phase in
            if phase != .active { return }

            refreshExtensionState()
            refreshSyncState()
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

            Section("Sync") {
                Text(syncState.message)
                    .foregroundStyle(.secondary)
                if syncState == .signedOut {
                    signInButton(provider: .google)
                    signInButton(provider: .apple)
                }
            }
        }
        .navigationTitle("URL Blocker")
    }

    private var syncControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(syncState.message)
                .font(.footnote)
                .foregroundStyle(.secondary)

            if syncState == .signedOut {
                ViewThatFits(in: .horizontal) {
                    HStack {
                        signInButton(provider: .google)
                        signInButton(provider: .apple)
                    }
                    VStack(alignment: .leading) {
                        signInButton(provider: .google)
                        signInButton(provider: .apple)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func signInButton(provider: NativeSupabaseAuth.Provider) -> some View {
        Button {
            signIn(provider: provider)
        } label: {
            SignInButtonLabel(provider: provider)
        }
        .buttonStyle(SignInButtonStyle(provider: provider))
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
                    alert = AppAlert(title: "Extension State Unavailable", error: error)
                }
                return
            }

            extensionState = .disabled
        }
    }

    private func refreshSyncState() {
        syncState = NativeSyncState.current
    }

    private func openExtensionSettings() {
        if #available(iOS 26.2, *) {
            Task { @MainActor in
                do {
                    try await SFSafariSettings.openExtensionsSettings(forIdentifiers: [Safari.extensionBundleIdentifier])
                } catch {
                    alert = AppAlert(title: "Settings Unavailable", error: error)
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
                alert = AppAlert(
                    title: "Settings Unavailable",
                    message: "Open iOS Settings, then go to Safari > Extensions.\n\nCode: UIApplicationOpenFailed"
                )
            }
        }
    }

    private func openBlocklistSettings() {
        appScreen = .blocklist
    }

    private func signIn(provider: NativeSupabaseAuth.Provider) {
        guard let anchor = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) else {
            alert = AppAlert(title: "Sign In Unavailable", message: "URL Blocker could not find an active app window.")
            return
        }

        Task { @MainActor in
            do {
                try await NativeSupabaseAuth.signIn(
                    provider: provider,
                    extensionBundleName: Safari.extensionBundleName,
                    anchor: anchor
                )
                syncState = .signedIn
            } catch {
                alert = AppAlert(title: "Sign In Failed", error: error)
            }
        }
    }
}

private enum NativeSyncState {
    case signedOut
    case signedIn

    static var current: NativeSyncState {
        NativeBlocklistStore.loadSupabaseSession() == nil ? .signedOut : .signedIn
    }

    var message: String {
        switch self {
        case .signedOut:
            return "Sign in to sync settings and screen time."
        case .signedIn:
            return "Signed in. Safari will sync the next time URL Blocker runs."
        }
    }
}

private struct SignInButtonLabel: View {
    let provider: NativeSupabaseAuth.Provider

    var body: some View {
        HStack(spacing: 10) {
            icon
                .frame(width: 20, height: 20)
            Text(title)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .font(.system(size: 16, weight: .medium))
    }

    private var title: String {
        switch provider {
        case .google:
            return "Sign In with Google"
        case .apple:
            return "Sign In with Apple"
        }
    }

    @ViewBuilder private var icon: some View {
        switch provider {
        case .google:
            GoogleSignInIcon()
        case .apple:
            Image(systemName: "apple.logo")
                .resizable()
                .scaledToFit()
        }
    }
}

private struct SignInButtonStyle: ButtonStyle {
    let provider: NativeSupabaseAuth.Provider

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity, minHeight: 46)
            .padding(.horizontal, 16)
            .background(background)
            .foregroundStyle(foreground)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(border, lineWidth: 1)
            }
            .shadow(color: shadow, radius: 2, x: 0, y: 1)
            .opacity(configuration.isPressed ? 0.75 : 1)
    }

    private var background: Color {
        switch provider {
        case .google:
            return .white
        case .apple:
            return .black
        }
    }

    private var border: Color {
        switch provider {
        case .google:
            return Color(red: 0.88, green: 0.88, blue: 0.88)
        case .apple:
            return .black
        }
    }

    private var foreground: Color {
        switch provider {
        case .google:
            return Color(red: 0.42, green: 0.42, blue: 0.42)
        case .apple:
            return .white
        }
    }

    private var shadow: Color {
        Color.black.opacity(0.18)
    }
}

private struct GoogleSignInIcon: View {
    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0.81, to: 1)
                .stroke(Color(red: 0.917, green: 0.262, blue: 0.207), style: stroke)
            Circle()
                .trim(from: 0, to: 0.31)
                .stroke(Color(red: 0.259, green: 0.522, blue: 0.957), style: stroke)
            Circle()
                .trim(from: 0.31, to: 0.58)
                .stroke(Color(red: 0.204, green: 0.659, blue: 0.325), style: stroke)
            Circle()
                .trim(from: 0.58, to: 0.81)
                .stroke(Color(red: 0.984, green: 0.737, blue: 0.020), style: stroke)
            Rectangle()
                .fill(Color(red: 0.259, green: 0.522, blue: 0.957))
                .frame(width: 8, height: 3)
                .offset(x: 4)
        }
        .rotationEffect(.degrees(-35))
    }

    private var stroke: StrokeStyle {
        StrokeStyle(lineWidth: 3, lineCap: .butt)
    }
}

private struct BlocklistWebView: UIViewRepresentable {
    let onError: (Error) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onError: onError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let userContentController = WKUserContentController()
        userContentController.addUserScript(WKUserScript(source: Self.browserShim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        userContentController.add(context.coordinator, name: "blocklist")
        configuration.userContentController = userContentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.loadFileURL(Safari.optionsPageURL, allowingReadAccessTo: Safari.resourcesURL)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        let onError: (Error) -> Void

        init(onError: @escaping (Error) -> Void) {
            self.onError = onError
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let id = body["id"] as? String else {
                return
            }

            guard let request = body["message"] as? [String: Any] else {
                reply(id: id, response: [
                    "type": "error",
                    "error": "Blocklist message must include a message object.",
                    "errorCode": "BlocklistScriptMessageInvalid"
                ])
                return
            }

            reply(id: id, response: NativeBlocklistStore.handle(request))
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onError(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onError(error)
        }

        private func reply(id: String, response: [String: Any]) {
            let payload: [String: Any] = ["id": id, "response": response]
            let data = try! JSONSerialization.data(withJSONObject: payload)
            let json = String(data: data, encoding: .utf8)!
            webView?.evaluateJavaScript("__URLBlockerReply(\(json));") { _, error in
                if let error {
                    self.onError(error)
                }
            }
        }
    }

    private static var browserShim: String {
        [
            nativeBrowserShim(defaultBlockedPagesURL: Safari.resourceDataURL(
                "default-blocked-pages",
                withExtension: "json",
                mimeType: "application/json"
            ), supabaseConfigURL: Safari.resourceDataURL(
                "supabase-config",
                withExtension: "json",
                mimeType: "application/json"
            )),
            Safari.resourceText("blocker", withExtension: "js"),
            Safari.resourceText("supabase-sync", withExtension: "js"),
            Safari.resourceText("background", withExtension: "js"),
            backgroundControllerShim
        ].joined(separator: "\n")
    }

    private static func nativeBrowserShim(defaultBlockedPagesURL: String, supabaseConfigURL: String) -> String {
        """
    (() => {
      const callbacks = new Map();
      const resourceURLs = new Map([
        ["default-blocked-pages.json", \(Safari.javaScriptString(defaultBlockedPagesURL))],
        ["supabase-config.json", \(Safari.javaScriptString(supabaseConfigURL))]
      ]);
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
          getURL: (path) => resourceURLs.get(path) || new URL(path, document.baseURI).href,
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
    }

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

    static func resourceDataURL(_ name: String, withExtension fileExtension: String, mimeType: String) -> String {
        let data = Data(resourceText(name, withExtension: fileExtension).utf8).base64EncodedString()

        return "data:\(mimeType);base64,\(data)"
    }

    static func javaScriptString(_ value: String) -> String {
        let data = try! JSONEncoder().encode(value)

        return String(data: data, encoding: .utf8)!
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
}
