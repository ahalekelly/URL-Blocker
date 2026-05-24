import AuthenticationServices
import Foundation

enum NativeSupabaseAuth {
    enum Provider: String {
        case apple
        case google
    }

    static func signIn(provider: Provider, extensionBundleName: String, anchor: ASPresentationAnchor) async throws {
        try saveSession(from: try await callbackURL(provider: provider, extensionBundleName: extensionBundleName, anchor: anchor))
    }

    static func callbackURL(provider: Provider, extensionBundleName: String, anchor: ASPresentationAnchor) async throws -> URL {
        let config = try loadConfig(extensionBundleName: extensionBundleName)

        return try await WebAuthSession(anchor: anchor).start(
            url: authorizationURL(config: config, provider: provider),
            callbackScheme: config.redirectScheme
        )
    }

    static func authorizationURL(provider: Provider, extensionBundleName: String) throws -> URL {
        try authorizationURL(config: loadConfig(extensionBundleName: extensionBundleName), provider: provider)
    }

    static func saveSession(from callbackURL: URL) throws {
        try NativeBlocklistStore.saveSupabaseSession(parseSession(callbackURL))
    }

    private static func authorizationURL(config: SupabaseConfig, provider: Provider) throws -> URL {
        try oauthURL(config: config, provider: provider, callbackURL: "\(config.redirectScheme)://supabase-auth")
    }

    private static func oauthURL(config: SupabaseConfig, provider: Provider, callbackURL: String) throws -> URL {
        let baseURL = config.supabaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var components = URLComponents(string: "\(baseURL)/auth/v1/authorize")
        components?.queryItems = [
            URLQueryItem(name: "provider", value: provider.rawValue),
            URLQueryItem(name: "redirect_to", value: callbackURL)
        ]

        guard let url = components?.url else {
            throw NativeSupabaseAuthError("Could not build Supabase sign-in URL.")
        }

        return url
    }

    private static func parseSession(_ url: URL) throws -> [String: Any] {
        let parameters = URLComponents(string: "?\(url.fragment ?? url.query ?? "")")?.queryItems ?? []
        let values = Dictionary(uniqueKeysWithValues: parameters.compactMap { item -> (String, String)? in
            guard let value = item.value else { return nil }

            return (item.name, value)
        })

        if let error = values["error"] {
            throw NativeSupabaseAuthError(values["error_description"] ?? error)
        }

        guard let accessToken = values["access_token"], !accessToken.isEmpty else {
            throw NativeSupabaseAuthError("Supabase sign-in did not return an access token.")
        }

        guard let refreshToken = values["refresh_token"], !refreshToken.isEmpty else {
            throw NativeSupabaseAuthError("Supabase sign-in did not return a refresh token.")
        }

        let expiresAtMs = try expirationMs(values)

        return [
            "schemaVersion": 1,
            "accessToken": accessToken,
            "refreshToken": refreshToken,
            "expiresAtMs": expiresAtMs
        ]
    }

    private static func expirationMs(_ values: [String: String]) throws -> Int {
        if let expiresAt = values["expires_at"], let seconds = Int(expiresAt) {
            return seconds * 1000
        }

        if let expiresIn = values["expires_in"], let seconds = Int(expiresIn) {
            return Int(Date().timeIntervalSince1970 * 1000) + seconds * 1000
        }

        throw NativeSupabaseAuthError("Supabase sign-in did not return an expiration.")
    }

    private static func loadConfig(extensionBundleName: String) throws -> SupabaseConfig {
        guard let pluginsURL = Bundle.main.builtInPlugInsURL else {
            throw NativeSupabaseAuthError("Missing app plug-ins directory.")
        }

        let bundleURL = pluginsURL.appendingPathComponent("\(extensionBundleName).appex")

        guard let bundle = Bundle(url: bundleURL),
              let url = bundle.url(forResource: "supabase-config", withExtension: "json") else {
            throw NativeSupabaseAuthError("Missing supabase-config.json in Safari extension resources.")
        }

        let config = try JSONDecoder().decode(SupabaseConfig.self, from: Data(contentsOf: url))

        if config.schemaVersion != 1 {
            throw NativeSupabaseAuthError("Unsupported Supabase config version.")
        }

        if config.supabaseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            config.publishableKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NativeSupabaseAuthError("Supabase sync is not configured on this build.")
        }

        if URL(string: config.supabaseUrl) == nil {
            throw NativeSupabaseAuthError("Supabase URL is invalid.")
        }

        return config
    }
}

private struct SupabaseConfig: Decodable {
    let schemaVersion: Int
    let supabaseUrl: String
    let publishableKey: String
    let redirectScheme: String
    let screenTimeSyncAgeMs: Int
}

private final class WebAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    private var session: ASWebAuthenticationSession?

    init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
    }

    func start(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                    return
                }

                continuation.resume(throwing: error ?? NativeSupabaseAuthError("Supabase sign-in was cancelled."))
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            session.start()
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor
    }
}

private struct NativeSupabaseAuthError: LocalizedError {
    let errorDescription: String?

    init(_ message: String) {
        errorDescription = message
    }
}
