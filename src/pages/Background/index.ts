const MENU_ID = "linkedinExtension";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Linkdon Popup",
    contexts: ["all"],
    documentUrlPatterns: ["*://*.linkedin.com/*"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;

  const tabId = tab?.id;
  if (typeof tabId !== "number") {
    console.error("No valid tabId found.");
    return;
  }

  chrome.tabs.sendMessage(tabId, { type: "SHOW_DEV_ROLE_POPUP" }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to open popup:", chrome.runtime.lastError.message);
    }
  });
});
