import Foundation

enum NativeBlocklistStore {
    static let stateKey = "blockerState"

    private static let schemaVersion = 5
    private static let maxBlockedPageHtmlLength = 4000
    private static let defaultBlockedPageHtml = "<h1>Blocked</h1><p>This page is on your blocklist.</p>"
    private static let defaultSchedule: [String: Any] = ["type": "always"]
    private static let appGroupIdentifier = "group.com.akelly.URLBlocker"
    private static let entryKinds = Set(["domain", "url", "urlWithSubpaths", "regex"])
    private static let entryIdPattern = #"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#
    private static let urlAliases = [
        "x.com/home": "x.com",
        "twitter.com/home": "twitter.com",
        "ycombinator.com/news": "ycombinator.com"
    ]

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
        let rawSchemaVersion = state["schemaVersion"] as? Int
        pushUnknownKeyErrors(&errors, state, stateKeys(rawSchemaVersion), "Blocklist", nil)

        guard let rawSchemaVersion, [1, 2, 3, 4, schemaVersion].contains(rawSchemaVersion) else {
            errors.append(BlocklistError(index: nil, message: "Unsupported blocklist version. Reset the blocklist to repair it."))
            throw BlocklistValidationError(errors)
        }

        guard let entries = state["entries"] as? [[String: Any]] else {
            errors.append(BlocklistError(index: nil, message: "Blocklist entries must be an array."))
            throw BlocklistValidationError(errors)
        }

        var blockedPageHtml = defaultBlockedPageHtml

        if rawSchemaVersion >= 2 {
            guard let rawBlockedPageHtml = state["blockedPageHtml"] as? String else {
                errors.append(BlocklistError(index: nil, message: "Blocked page HTML must be a string."))
                throw BlocklistValidationError(errors)
            }

            blockedPageHtml = rawBlockedPageHtml
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

        var schedule = defaultSchedule

        if rawSchemaVersion >= 5 && state["schedule"] is [String: Any] {
            do {
                schedule = try validateSchedule(state["schedule"])
            } catch let error as BlocklistValidationError {
                errors.append(contentsOf: error.errors)
            }
        } else if rawSchemaVersion >= 5 {
            errors.append(BlocklistError(index: nil, message: "Schedule must be an object."))
        }

        var normalizedEntries: [[String: Any]] = []
        var seenEntries = Set<String>()
        let collapseAliasDuplicates = rawSchemaVersion < schemaVersion

        entries.enumerated().forEach { index, entry in
            validateEntry(
                entry,
                index: index,
                collapseAliasDuplicates: collapseAliasDuplicates,
                errors: &errors,
                normalizedEntries: &normalizedEntries,
                seenEntries: &seenEntries
            )
        }

        if !errors.isEmpty {
            throw BlocklistValidationError(errors)
        }

        return [
            "schemaVersion": schemaVersion,
            "entries": normalizedEntries,
            "blockedPageHtml": normalizedBlockedPageHtml,
            "schedule": schedule
        ]
    }

    private static func validateEntry(
        _ entry: [String: Any],
        index: Int,
        collapseAliasDuplicates: Bool,
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

        let normalizedValue: String
        let aliased: Bool

        do {
            let result = try normalizeEntryValue(value, kind: kind)
            normalizedValue = result.value
            aliased = result.aliased
        } catch {
            errors.append(BlocklistError(index: index, message: error.localizedDescription))
            return
        }

        let normalizedEntry = ["id": id.lowercased(), "kind": kind, "value": normalizedValue]
        let duplicateKey = "\(kind):\(normalizedValue.lowercased())"

        if seenEntries.contains(duplicateKey) {
            if collapseAliasDuplicates && aliased { return }

            errors.append(BlocklistError(index: index, message: "Duplicate entry after normalization."))
            return
        }

        seenEntries.insert(duplicateKey)
        normalizedEntries.append(normalizedEntry)
    }

    private static func normalizeEntryValue(_ value: String, kind: String) throws -> (value: String, aliased: Bool) {
        switch kind {
        case "url", "urlWithSubpaths":
            return try normalizeUrlEntryValue(value)
        case "domain", "regex":
            return (value, false)
        default:
            throw NativeBlocklistError("Unknown matcher kind: \(kind)")
        }
    }

    private static func normalizeUrlEntryValue(_ rawValue: String) throws -> (value: String, aliased: Bool) {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let urlString = matches(value, #"^[a-z][a-z0-9+.-]*://"#) ? value : "https://\(value)"

        guard let components = URLComponents(string: urlString),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let rawHost = components.host else {
            throw NativeBlocklistError("URL entries must use http or https.")
        }

        if components.user != nil || components.password != nil {
            throw NativeBlocklistError("URL entries cannot include usernames or passwords.")
        }

        if components.port != nil {
            throw NativeBlocklistError("URL entries cannot include non-default ports.")
        }

        let host = stripLeadingWww(rawHost.lowercased())
        let path = stripTrailingSlashes(components.path.isEmpty ? "/" : components.path)
        let storedPath = path == "/" ? "" : path
        let storedValue = "\(host)\(storedPath)"

        if let alias = urlAliases[storedValue.lowercased()] {
            return (alias, true)
        }

        return (storedValue, false)
    }

    private static func validateSchedule(_ rawSchedule: Any?) throws -> [String: Any] {
        guard let schedule = rawSchedule as? [String: Any] else {
            throw BlocklistValidationError([BlocklistError(index: nil, message: "Schedule must be an object.")])
        }

        var errors: [BlocklistError] = []

        guard let type = schedule["type"] as? String else {
            throw BlocklistValidationError([BlocklistError(index: nil, message: "Schedule type must be a string.")])
        }

        switch type {
        case "always":
            pushUnknownKeyErrors(&errors, schedule, ["type"], "Schedule", nil)

            if !errors.isEmpty {
                throw BlocklistValidationError(errors)
            }

            return defaultSchedule
        case "dailyWindow":
            pushUnknownKeyErrors(&errors, schedule, ["type", "startMinute", "endMinute"], "Schedule", nil)

            guard let startMinute = schedule["startMinute"] as? Int, isMinute(startMinute) else {
                errors.append(BlocklistError(index: nil, message: "Schedule start minute must be between 0 and 1439."))
                throw BlocklistValidationError(errors)
            }

            guard let endMinute = schedule["endMinute"] as? Int, isMinute(endMinute) else {
                errors.append(BlocklistError(index: nil, message: "Schedule end minute must be between 0 and 1439."))
                throw BlocklistValidationError(errors)
            }

            if startMinute == endMinute {
                errors.append(BlocklistError(index: nil, message: "Daily schedule start and end times must be different."))
            }

            if !errors.isEmpty {
                throw BlocklistValidationError(errors)
            }

            return ["type": "dailyWindow", "startMinute": startMinute, "endMinute": endMinute]
        default:
            throw BlocklistValidationError([BlocklistError(index: nil, message: "Unknown schedule type: \(type)")])
        }
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
            "schemaVersion": 4,
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

    private static func stripLeadingWww(_ host: String) -> String {
        host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    private static func stripTrailingSlashes(_ path: String) -> String {
        let stripped = path.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)

        return stripped.isEmpty ? "/" : stripped
    }

    private static func isMinute(_ value: Int) -> Bool {
        value >= 0 && value <= 1439
    }

    private static func stateKeys(_ schemaVersion: Int?) -> Set<String> {
        switch schemaVersion {
        case 1:
            return ["schemaVersion", "entries"]
        case 2:
            return ["schemaVersion", "entries", "blockedPageHtml"]
        case 3:
            return ["schemaVersion", "entries", "blockedPageHtml", "useSafariBlockingApi"]
        case 4:
            return ["schemaVersion", "entries", "blockedPageHtml"]
        case 5:
            return ["schemaVersion", "entries", "blockedPageHtml", "schedule"]
        default:
            return ["schemaVersion", "entries", "blockedPageHtml", "schedule"]
        }
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
