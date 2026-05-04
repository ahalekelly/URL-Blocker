import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["type": "ok"]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
