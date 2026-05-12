import Foundation

enum NativeBlocklistStore {
    static let stateKey = "blockerState"

    private static let schemaVersion = 4
    private static let maxBlockedPageHtmlLength = 4000
    private static let defaultBlockedPageHtml = "<h1>Blocked</h1><p>This page is on your blocklist.</p>"
    private static let appGroupIdentifier = "group.com.akelly.URLBlocker"
    private static let entryKinds = Set(["domain", "url", "urlWithSubpaths", "regex"])
    private static let entryIdPattern = #"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#

    static func handle(_ message: [String: Any]) -> [String: Any] {
        do {
            let type = try requireString(message["type"], "Native message type")

            switch type {
            case "getState":
                try requireKeys(message, ["type"], "getState message")
                return getState()
            case "saveState":
                try requireKeys(message, ["type", "state"], "saveState message")
                return saveState(message["state"])
            case "resetState":
                try requireKeys(message, ["type"], "resetState message")
                return resetState()
            default:
                return error("Unknown native message type: \(type).")
            }
        } catch {
            return self.error(error.localizedDescription)
        }
    }

    static func getState() -> [String: Any] {
        do {
            return ["type": "state", "state": try loadState()]
        } catch let error as BlocklistValidationError {
            return ["type": "stateError", "error": error.errors.map(\.message).joined(separator: "\n")]
        } catch {
            return self.error(error.localizedDescription)
        }
    }

    private static func saveState(_ rawState: Any?) -> [String: Any] {
        do {
            let state = try validateState(rawState)
            defaults.set(state, forKey: stateKey)
            return ["type": "saved", "state": state]
        } catch let error as BlocklistValidationError {
            return ["type": "validationError", "errors": error.errors.map(\.dictionary)]
        } catch {
            return self.error(error.localizedDescription)
        }
    }

    private static func resetState() -> [String: Any] {
        do {
            let state = try emptyState()
            defaults.set(state, forKey: stateKey)
            return ["type": "saved", "state": state]
        } catch let error as BlocklistValidationError {
            return ["type": "validationError", "errors": error.errors.map(\.dictionary)]
        } catch {
            return self.error(error.localizedDescription)
        }
    }

    private static func loadState() throws -> [String: Any] {
        guard let storedState = defaults.object(forKey: stateKey) else {
            return try emptyState()
        }

        return try validateState(storedState)
    }

    private static func validateState(_ rawState: Any?) throws -> [String: Any] {
        guard let state = rawState as? [String: Any] else {
            throw BlocklistValidationError([BlocklistError(index: nil, message: "Blocklist data must be an object.")])
        }

        var errors: [BlocklistError] = []
        pushUnknownKeyErrors(&errors, state, ["schemaVersion", "entries", "blockedPageHtml"], "Blocklist", nil)

        if state["schemaVersion"] as? Int != schemaVersion {
            errors.append(BlocklistError(index: nil, message: "Unsupported blocklist version. Reset the blocklist to repair it."))
        }

        guard let entries = state["entries"] as? [[String: Any]] else {
            errors.append(BlocklistError(index: nil, message: "Blocklist entries must be an array."))
            throw BlocklistValidationError(errors)
        }

        guard let blockedPageHtml = state["blockedPageHtml"] as? String else {
            errors.append(BlocklistError(index: nil, message: "Blocked page HTML must be a string."))
            throw BlocklistValidationError(errors)
        }

        let normalizedBlockedPageHtml = blockedPageHtml.trimmingCharacters(in: .whitespacesAndNewlines)

        if normalizedBlockedPageHtml.count > maxBlockedPageHtmlLength {
            errors.append(BlocklistError(index: nil, message: "Blocked page HTML is limited to \(maxBlockedPageHtmlLength) characters."))
        }

        if includesActiveHtml(normalizedBlockedPageHtml) {
            errors.append(BlocklistError(index: nil, message: "Blocked page HTML cannot include active or form elements."))
        }

        if includesInlineScript(normalizedBlockedPageHtml) {
            errors.append(BlocklistError(index: nil, message: "Blocked page HTML cannot include inline scripts."))
        }

        var normalizedEntries: [[String: Any]] = []
        var seenEntries = Set<String>()

        entries.enumerated().forEach { index, entry in
            validateEntry(entry, index: index, errors: &errors, normalizedEntries: &normalizedEntries, seenEntries: &seenEntries)
        }

        if !errors.isEmpty {
            throw BlocklistValidationError(errors)
        }

        return [
            "schemaVersion": schemaVersion,
            "entries": normalizedEntries,
            "blockedPageHtml": normalizedBlockedPageHtml
        ]
    }

    private static func validateEntry(
        _ entry: [String: Any],
        index: Int,
        errors: inout [BlocklistError],
        normalizedEntries: inout [[String: Any]],
        seenEntries: inout Set<String>
    ) {
        pushUnknownKeyErrors(&errors, entry, ["id", "kind", "value"], "Entry", index)

        guard let id = entry["id"] as? String, matches(id, entryIdPattern) else {
            errors.append(BlocklistError(index: index, message: "Entry ID must be a valid UUID."))
            return
        }

        guard let kind = entry["kind"] as? String, entryKinds.contains(kind) else {
            errors.append(BlocklistError(index: index, message: "Choose a known matcher type."))
            return
        }

        guard let value = entry["value"] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errors.append(BlocklistError(index: index, message: "Enter a value."))
            return
        }

        let normalizedEntry = ["id": id, "kind": kind, "value": value]
        let duplicateKey = "\(kind):\(value.lowercased())"

        if seenEntries.contains(duplicateKey) {
            errors.append(BlocklistError(index: index, message: "Duplicate entry after normalization."))
            return
        }

        seenEntries.insert(duplicateKey)
        normalizedEntries.append(normalizedEntry)
    }

    private static func pushUnknownKeyErrors(
        _ errors: inout [BlocklistError],
        _ object: [String: Any],
        _ allowedKeys: Set<String>,
        _ label: String,
        _ index: Int?
    ) {
        object.keys.sorted().forEach { key in
            if allowedKeys.contains(key) { return }

            errors.append(BlocklistError(index: index, message: "\(label) has unknown key: \(key)."))
        }
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

    private static func emptyState() throws -> [String: Any] {
        try validateState([
            "schemaVersion": schemaVersion,
            "entries": try defaultBlockedPageEntries(),
            "blockedPageHtml": defaultBlockedPageHtml
        ])
    }

    private static func defaultBlockedPageEntries() throws -> [[String: Any]] {
        let data = try Data(contentsOf: defaultBlockedPageURL())
        let json = try JSONSerialization.jsonObject(with: data)

        guard let entries = json as? [[String: Any]] else {
            throw NativeBlocklistError("Default blocked pages must be an array.")
        }

        return entries
    }

    private static func defaultBlockedPageURL() throws -> URL {
        for bundle in defaultBlockedPageBundles() {
            if let url = bundle.url(forResource: "default-blocked-pages", withExtension: "json") {
                return url
            }
        }

        throw NativeBlocklistError("Missing default-blocked-pages.json.")
    }

    private static func defaultBlockedPageBundles() -> [Bundle] {
        var bundles = [Bundle.main]

        if let pluginsURL = Bundle.main.builtInPlugInsURL {
            ["URLBlockerIOSExtension", "URLBlockerMacExtension"].forEach { name in
                let url = pluginsURL.appendingPathComponent("\(name).appex")

                if let bundle = Bundle(url: url) {
                    bundles.append(bundle)
                }
            }
        }

        return bundles
    }

    private static func error(_ message: String) -> [String: Any] {
        ["type": "error", "error": message]
    }

    private static func includesActiveHtml(_ value: String) -> Bool {
        matches(value, #"</?(script|iframe|object|embed|form|input|button|textarea|select|option|link|meta|base|style)\b"#)
    }

    private static func includesInlineScript(_ value: String) -> Bool {
        matches(value, #"\son[a-z]+\s*=|javascript:"#)
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
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

private struct BlocklistValidationError: Error {
    let errors: [BlocklistError]

    init(_ errors: [BlocklistError]) {
        self.errors = errors
    }
}

private struct BlocklistError {
    let index: Int?
    let message: String

    var dictionary: [String: Any] {
        let jsonIndex: Any

        if let index = index {
            jsonIndex = index
        } else {
            jsonIndex = NSNull()
        }

        return ["index": jsonIndex, "message": message]
    }
}

private struct NativeBlocklistError: LocalizedError {
    let errorDescription: String?

    init(_ message: String) {
        errorDescription = message
    }
}
