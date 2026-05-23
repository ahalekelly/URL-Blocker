import Foundation

enum NativeBlocklistStore {
    private enum UrlAlias {
        case exact(source: String, target: String)
        case pathRegex(host: String, pathPattern: String, target: String)
    }

    static let stateKey = "blockerState"

    private static let schemaVersion = 6
    private static let maxBlockedPageHtmlLength = 4000
    private static let defaultLimitMinutes = 30
    private static let maxLimitMinutes = 960
    private static let defaultBlockedPageHtml = "<h1>Blocked</h1><p>This page is on your blocklist.</p>"
    private static let defaultSchedule: [String: Any] = ["type": "always"]
    private static let appGroupIdentifier = "group.com.akelly.URLBlocker"
    private static let entryKinds = Set(["domain", "url", "urlWithSubpaths", "regex"])
    private static let entryIdPattern = #"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#
    private static let urlAliases: [UrlAlias] = [
        .exact(source: "x.com/home", target: "x.com"),
        .exact(source: "twitter.com/home", target: "twitter.com"),
        .exact(source: "ycombinator.com/news", target: "ycombinator.com"),
        .pathRegex(
            host: "reddit.com",
            pathPattern: #"^/r/[a-z0-9_]+(?:/(?:hot|new|top|rising|controversial))?$"#,
            target: "reddit.com"
        )
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

        guard let rawSchemaVersion, rawSchemaVersion == schemaVersion else {
            errors.append(BlocklistError(index: nil, message: "Unsupported blocklist version. Reset the blocklist to repair it."))
            throw BlocklistValidationError(errors)
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

        guard state["schedule"] is [String: Any] else {
            errors.append(BlocklistError(index: nil, message: "Schedule must be an object."))
            throw BlocklistValidationError(errors)
        }

        let schedule: [String: Any]

        do {
            schedule = try validateSchedule(state["schedule"])
        } catch let error as BlocklistValidationError {
            errors.append(contentsOf: error.errors)
            throw BlocklistValidationError(errors)
        }

        guard let rawDomainLimits = state["domainLimits"] as? [[String: Any]] else {
            errors.append(BlocklistError(index: nil, message: "Domain limits must be an array."))
            throw BlocklistValidationError(errors)
        }

        var normalizedEntries: [[String: Any]] = []
        var seenEntries = Set<String>()

        entries.enumerated().forEach { index, entry in
            validateEntry(
                entry,
                index: index,
                errors: &errors,
                normalizedEntries: &normalizedEntries,
                seenEntries: &seenEntries
            )
        }

        if !errors.isEmpty {
            throw BlocklistValidationError(errors)
        }

        let domainLimits = try validateDomainLimits(rawDomainLimits, normalizedEntries)

        return [
            "schemaVersion": schemaVersion,
            "entries": normalizedEntries,
            "blockedPageHtml": normalizedBlockedPageHtml,
            "schedule": schedule,
            "domainLimits": domainLimits
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

        let normalizedValue: String

        do {
            let result = try normalizeEntryValue(value, kind: kind)
            normalizedValue = result.value
        } catch {
            errors.append(BlocklistError(index: index, message: error.localizedDescription))
            return
        }

        let normalizedEntry = ["id": id.lowercased(), "kind": kind, "value": normalizedValue]
        let duplicateKey = "\(kind):\(normalizedValue.lowercased())"

        if seenEntries.contains(duplicateKey) {
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
        case "domain":
            return (try normalizeDomainEntryValue(value), false)
        case "regex":
            let regex = try normalizeRegexEntryValue(value)
            _ = try domainForRegexEntryValue(regex)
            return (regex, false)
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

        if let alias = urlAliasTarget(host: host, path: storedPath, storedValue: storedValue) {
            return (alias, true)
        }

        return (storedValue, false)
    }

    private static func normalizeDomainEntryValue(_ rawValue: String) throws -> String {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)

        if matches(value, #"^[a-z][a-z0-9+.-]*://"#) {
            throw NativeBlocklistError("Enter a hostname, not a full URL.")
        }

        if matches(value, #"[/?#@]|:"#) {
            throw NativeBlocklistError("Domain entries cannot include paths, ports, credentials, queries, or fragments.")
        }

        guard let components = URLComponents(string: "http://\(value)"),
              let rawHost = components.host else {
            throw NativeBlocklistError("Enter a valid hostname.")
        }

        let host = stripLeadingWww(rawHost.lowercased())

        if host.isEmpty || host.hasPrefix(".") || host.hasSuffix(".") {
            throw NativeBlocklistError("Enter a valid hostname.")
        }

        if host.split(separator: ".").contains(where: { $0.isEmpty || $0.hasPrefix("-") || $0.hasSuffix("-") }) {
            throw NativeBlocklistError("Enter a valid hostname.")
        }

        if !matches(host, #"^[a-z0-9.-]+$"#) {
            throw NativeBlocklistError("Domain entries must normalize to lowercase ASCII or punycode.")
        }

        if isIpAddress(host) {
            throw NativeBlocklistError("IP address blocking is not supported in this version.")
        }

        return host
    }

    private static func normalizeRegexEntryValue(_ rawValue: String) throws -> String {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)

        if value.contains("#") {
            throw NativeBlocklistError("Regex entries cannot include fragments.")
        }

        if matches(value, #"\(\?<[=!]|\(\?<!"#) {
            throw NativeBlocklistError("Regex entries cannot use lookbehind.")
        }

        if matches(value, #"\\[1-9]"#) {
            throw NativeBlocklistError("Regex entries cannot use backreferences.")
        }

        if matches(value, #"^(?:\^)?\.\*(?:\$)?$"#) {
            throw NativeBlocklistError("Block-everything regexes are not supported in this version.")
        }

        do {
            _ = try NSRegularExpression(pattern: value, options: [.caseInsensitive])
        } catch {
            throw NativeBlocklistError("Regex is invalid: \(error.localizedDescription)")
        }

        return value
    }

    private static func domainForRegexEntryValue(_ value: String) throws -> String {
        let pattern = #"^\^(?:https\?|https|http)://([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)(?=/|\$)"#

        guard let range = value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) else {
            throw NativeBlocklistError("Regex entries must start with one literal http or https host.")
        }

        let prefix = String(value[range])
        let hostPattern = prefix
            .replacingOccurrences(of: #"^\^(?:https\?|https|http)://"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?=/|\$)$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\\\."#, with: ".", options: .regularExpression)

        return try normalizeDomainEntryValue(hostPattern)
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

    private static func validateDomainLimits(_ rawLimits: [[String: Any]], _ entries: [[String: Any]]) throws -> [[String: Any]] {
        var errors: [BlocklistError] = []
        let expectedDomains = Set(try entries.map(associatedDomain))
        var seenDomains = Set<String>()
        var domainLimits: [[String: Any]] = []

        rawLimits.forEach { limit in
            pushUnknownKeyErrors(&errors, limit, ["domain", "limitMinutes"], "Domain limit", nil)

            guard let rawDomain = limit["domain"] as? String else {
                errors.append(BlocklistError(index: nil, message: "Domain limit domain must be a string."))
                return
            }

            let domain: String

            do {
                domain = try normalizeDomainEntryValue(rawDomain)
            } catch {
                errors.append(BlocklistError(index: nil, message: error.localizedDescription))
                return
            }

            if domain != rawDomain {
                errors.append(BlocklistError(index: nil, message: "Domain limit domain must be normalized."))
                return
            }

            if seenDomains.contains(domain) {
                errors.append(BlocklistError(index: nil, message: "Duplicate domain limit: \(domain)."))
                return
            }

            guard let limitMinutes = limit["limitMinutes"] as? Int,
                  limitMinutes >= 1,
                  limitMinutes <= maxLimitMinutes else {
                errors.append(BlocklistError(index: nil, message: "Domain limit minutes must be between 1 and \(maxLimitMinutes)."))
                return
            }

            seenDomains.insert(domain)
            domainLimits.append(["domain": domain, "limitMinutes": limitMinutes])
        }

        expectedDomains.sorted().forEach { domain in
            if seenDomains.contains(domain) { return }

            errors.append(BlocklistError(index: nil, message: "Missing domain limit: \(domain)."))
        }

        seenDomains.sorted().forEach { domain in
            if expectedDomains.contains(domain) { return }

            errors.append(BlocklistError(index: nil, message: "Domain limit does not match a blocklist domain: \(domain)."))
        }

        if !errors.isEmpty {
            throw BlocklistValidationError(errors)
        }

        return domainLimits.sorted { left, right in
            (left["domain"] as? String ?? "") < (right["domain"] as? String ?? "")
        }
    }

    private static func domainLimitsForEntries(_ entries: [[String: Any]]) throws -> [[String: Any]] {
        let domains = Set(try entries.map(associatedDomain))

        return domains.sorted().map { domain in
            ["domain": domain, "limitMinutes": defaultLimitMinutes]
        }
    }

    private static func associatedDomain(_ entry: [String: Any]) throws -> String {
        guard let kind = entry["kind"] as? String, let value = entry["value"] as? String else {
            throw NativeBlocklistError("Entry must include a kind and value.")
        }

        switch kind {
        case "domain":
            return value
        case "url", "urlWithSubpaths":
            return try splitStoredUrl(value).host
        case "regex":
            return try domainForRegexEntryValue(value)
        default:
            throw NativeBlocklistError("Unknown matcher kind: \(kind)")
        }
    }

    private static func splitStoredUrl(_ value: String) throws -> (host: String, path: String) {
        guard let components = URLComponents(string: "https://\(value)"), let host = components.host else {
            throw NativeBlocklistError("URL entries must use http or https.")
        }

        return (host, components.path.isEmpty || components.path == "/" ? "" : components.path)
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
        let entries = try defaultBlockedPageEntries()

        return try validateState([
            "schemaVersion": schemaVersion,
            "entries": entries,
            "blockedPageHtml": defaultBlockedPageHtml,
            "schedule": defaultSchedule,
            "domainLimits": try domainLimitsForEntries(entries)
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

    private static func urlAliasTarget(host: String, path: String, storedValue: String) -> String? {
        for alias in urlAliases {
            switch alias {
            case .exact(let source, let target):
                if source == storedValue.lowercased() { return target }
            case .pathRegex(let aliasHost, let pathPattern, let target):
                if hostMatches(aliasHost, host), matches(path, pathPattern) { return target }
            }
        }

        return nil
    }

    private static func hostMatches(_ domain: String, _ host: String) -> Bool {
        host == domain || host.hasSuffix(".\(domain)")
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

    private static func isIpAddress(_ host: String) -> Bool {
        if host.contains(":") || host.contains("[") || host.contains("]") {
            return true
        }

        let parts = host.split(separator: ".")

        return parts.count == 4 && parts.allSatisfy { part in
            guard let number = Int(part), matches(String(part), #"^\d{1,3}$"#) else {
                return false
            }

            return number <= 255
        }
    }

    private static func stateKeys(_ schemaVersion: Int?) -> Set<String> {
        ["schemaVersion", "entries", "blockedPageHtml", "schedule", "domainLimits"]
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
