import Foundation

enum NativeBlocklistStore {
    private enum StoredValue {
        case state
        case screenTimeUsage

        var storageKey: String {
            switch self {
            case .state:
                return "blockerState"
            case .screenTimeUsage:
                return "screenTimeUsage"
            }
        }

        var valueKey: String {
            switch self {
            case .state:
                return "state"
            case .screenTimeUsage:
                return "usage"
            }
        }

        var label: String {
            switch self {
            case .state:
                return "Blocklist state"
            case .screenTimeUsage:
                return "Screen time usage"
            }
        }

        var loadedResponseType: String {
            switch self {
            case .state:
                return "storedState"
            case .screenTimeUsage:
                return "storedScreenTimeUsage"
            }
        }

        var savedResponseType: String {
            switch self {
            case .state:
                return "savedState"
            case .screenTimeUsage:
                return "savedScreenTimeUsage"
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
                return load(.state)
            case "saveState":
                try requireKeys(message, ["type", "state"], "saveState message")
                return try save(message["state"], .state)
            case "loadScreenTimeUsage":
                try requireKeys(message, ["type"], "loadScreenTimeUsage message")
                return load(.screenTimeUsage)
            case "saveScreenTimeUsage":
                try requireKeys(message, ["type", "usage"], "saveScreenTimeUsage message")
                return try save(message["usage"], .screenTimeUsage)
            default:
                return error("Unknown native message type: \(type).")
            }
        } catch {
            return self.error(error.localizedDescription)
        }
    }

    private static func load(_ storedValue: StoredValue) -> [String: Any] {
        var response: [String: Any] = ["type": storedValue.loadedResponseType]

        if let value = defaults.object(forKey: storedValue.storageKey) {
            response[storedValue.valueKey] = value
        }

        return response
    }

    private static func save(_ rawValue: Any?, _ storedValue: StoredValue) throws -> [String: Any] {
        let value = try requireDictionary(rawValue, storedValue.label)
        defaults.set(value, forKey: storedValue.storageKey)

        return ["type": storedValue.savedResponseType, storedValue.valueKey: value]
    }

    private static func requireDictionary(_ value: Any?, _ label: String) throws -> [String: Any] {
        guard let dictionary = value as? [String: Any] else {
            throw NativeBlocklistError("\(label) must be an object.")
        }

        if !PropertyListSerialization.propertyList(dictionary, isValidFor: .binary) {
            throw NativeBlocklistError("\(label) must contain only property list values.")
        }

        return dictionary
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

    private static func error(_ message: String) -> [String: Any] {
        ["type": "error", "error": message]
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
