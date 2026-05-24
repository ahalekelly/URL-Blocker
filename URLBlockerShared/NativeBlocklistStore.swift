import Foundation

enum NativeBlocklistStore {
    private enum StoredValue {
        case state
        case screenTimeUsage
        case settingsSync
        case supabaseSession

        var storageKey: String {
            switch self {
            case .state:
                return "blockerState"
            case .screenTimeUsage:
                return "screenTimeUsage"
            case .settingsSync:
                return "settingsSync"
            case .supabaseSession:
                return "supabaseSession"
            }
        }

        var valueKey: String {
            switch self {
            case .state:
                return "state"
            case .screenTimeUsage:
                return "usage"
            case .settingsSync:
                return "sync"
            case .supabaseSession:
                return "session"
            }
        }

        var label: String {
            switch self {
            case .state:
                return "Blocklist state"
            case .screenTimeUsage:
                return "Screen time usage"
            case .settingsSync:
                return "Settings sync metadata"
            case .supabaseSession:
                return "Supabase session"
            }
        }

        var loadedResponseType: String {
            switch self {
            case .state:
                return "storedState"
            case .screenTimeUsage:
                return "storedScreenTimeUsage"
            case .settingsSync:
                return "storedSettingsSync"
            case .supabaseSession:
                return "storedSupabaseSession"
            }
        }

        var savedResponseType: String {
            switch self {
            case .state:
                return "savedState"
            case .screenTimeUsage:
                return "savedScreenTimeUsage"
            case .settingsSync:
                return "savedSettingsSync"
            case .supabaseSession:
                return "savedSupabaseSession"
            }
        }
    }

    private static let appGroupIdentifier = "group.com.akelly.URLBlocker"

    static func handle(_ message: [String: Any]) -> [String: Any] {
        do {
            let type = try requireString(message["type"], "Native message type")

            switch type {
            case "loadState":
                try requireKeys(message, ["type"], "loadState message")
                return try load(.state)
            case "saveState":
                try requireKeys(message, ["type", "state"], "saveState message")
                return try save(message["state"], .state)
            case "loadScreenTimeUsage":
                try requireKeys(message, ["type"], "loadScreenTimeUsage message")
                return try load(.screenTimeUsage)
            case "saveScreenTimeUsage":
                try requireKeys(message, ["type", "usage"], "saveScreenTimeUsage message")
                return try save(message["usage"], .screenTimeUsage)
            case "loadSettingsSync":
                try requireKeys(message, ["type"], "loadSettingsSync message")
                return try load(.settingsSync)
            case "saveSettingsSync":
                try requireKeys(message, ["type", "sync"], "saveSettingsSync message")
                return try save(message["sync"], .settingsSync)
            case "loadSupabaseSession":
                try requireKeys(message, ["type"], "loadSupabaseSession message")
                return try load(.supabaseSession)
            case "saveSupabaseSession":
                try requireKeys(message, ["type", "session"], "saveSupabaseSession message")
                return try save(message["session"], .supabaseSession)
            case "clearSupabaseSession":
                try requireKeys(message, ["type"], "clearSupabaseSession message")
                return clearSupabaseSession()
            default:
                throw NativeBlocklistError("Unknown native message type: \(type).")
            }
        } catch {
            return self.error(error)
        }
    }

    private static func load(_ storedValue: StoredValue) throws -> [String: Any] {
        var response: [String: Any] = ["type": storedValue.loadedResponseType]

        if let value = defaults.object(forKey: storedValue.storageKey) {
            response[storedValue.valueKey] = try storedDictionary(value, storedValue.label)
        }

        return response
    }

    private static func save(_ rawValue: Any?, _ storedValue: StoredValue) throws -> [String: Any] {
        let value = try requireDictionary(rawValue, storedValue.label)
        defaults.set(try jsonData(value, storedValue.label), forKey: storedValue.storageKey)

        return ["type": storedValue.savedResponseType, storedValue.valueKey: value]
    }

    static func saveSupabaseSession(_ rawSession: [String: Any]) throws {
        _ = try save(rawSession, .supabaseSession)
    }

    static func loadSupabaseSession() -> [String: Any]? {
        guard let value = defaults.object(forKey: StoredValue.supabaseSession.storageKey) else {
            return nil
        }

        return try? storedDictionary(value, StoredValue.supabaseSession.label)
    }

    private static func clearSupabaseSession() -> [String: Any] {
        defaults.removeObject(forKey: StoredValue.supabaseSession.storageKey)

        return ["type": "clearedSupabaseSession"]
    }

    private static func requireDictionary(_ value: Any?, _ label: String) throws -> [String: Any] {
        guard let dictionary = value as? [String: Any] else {
            throw NativeBlocklistError("\(label) must be an object.")
        }

        return dictionary
    }

    private static func storedDictionary(_ value: Any, _ label: String) throws -> [String: Any] {
        if let data = value as? Data {
            return try requireDictionary(JSONSerialization.jsonObject(with: data), label)
        }

        let dictionary = try requireDictionary(value, label)
        _ = try jsonData(dictionary, label)

        return dictionary
    }

    private static func jsonData(_ dictionary: [String: Any], _ label: String) throws -> Data {
        if !JSONSerialization.isValidJSONObject(dictionary) {
            throw NativeBlocklistError("\(label) must contain only JSON values.")
        }

        return try JSONSerialization.data(withJSONObject: dictionary)
    }

    private static func requireKeys(_ object: [String: Any], _ allowedKeys: Set<String>, _ label: String) throws {
        let unknownKey = object.keys.first { !allowedKeys.contains($0) }

        if let unknownKey {
            throw NativeBlocklistError("\(label) has unknown key: \(unknownKey).")
        }
    }

    private static func requireString(_ value: Any?, _ label: String) throws -> String {
        guard let string = value as? String, !string.isEmpty else {
            throw NativeBlocklistError("\(label) must be a string.")
        }

        return string
    }

    private static func error(_ error: Error) -> [String: Any] {
        let nsError = error as NSError

        return [
            "type": "error",
            "error": nsError.localizedDescription,
            "errorCode": "\(nsError.domain) \(nsError.code)"
        ]
    }

    private static var defaults: UserDefaults {
        #if os(iOS)
        if let defaults = UserDefaults(suiteName: appGroupIdentifier) {
            return defaults
        }
        #endif

        return .standard
    }
}

private struct NativeBlocklistError: LocalizedError {
    let errorDescription: String?

    init(_ message: String) {
        errorDescription = message
    }
}
