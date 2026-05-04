import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let userInfo = item.userInfo as? [String: Any],
              let message = userInfo[SFExtensionMessageKey] as? [String: Any] else {
            context.completeRequest(returningItems: nil, completionHandler: nil)
            return
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: NativeBlocklistStore.handle(message)]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
