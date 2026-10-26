// Android version of the extension's blocked.js: fills the shared blocked.html
// from the block decision the service hands over through AndroidBlockScreen.
(function loadAndroidBlockedPage(root) {
  "use strict";

  const page = JSON.parse(root.AndroidBlockScreen.page());
  const blockedMessage = document.getElementById("blockedMessage");

  blockedMessage.innerHTML = page.blockedPageHtml;
  blockedMessage.hidden = page.blockedPageHtml === "";
  document.getElementById("blockedReason").textContent = page.reasonText;
  document.getElementById("closeButton").addEventListener("click", () => root.AndroidBlockScreen.close());
  document.getElementById("blockedCard").removeAttribute("data-loading");
})(globalThis);
