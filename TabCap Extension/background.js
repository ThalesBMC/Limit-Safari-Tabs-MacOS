// Safari Tab Limit - Extension Background Script
// Limits maximum tabs to maintain focus
// Supports per-window or global (all windows) limit

const MAX_TABS = 3;

// Default settings
const DEFAULT_SETTINGS = {
  enabled: true,
  maxTabs: MAX_TABS,
  globalLimit: false, // false = per window, true = all windows combined
  allowlistEnabled: false,
  allowlist: [],
  tabLimitLocked: false,
};

// Default stats
const DEFAULT_STATS = {
  currentStreak: 0,
  bestStreak: 0,
  blockedToday: 0,
  blockedWeek: 0,
  blockedTotal: 0,
  lastActiveDate: null,
  lastBlockDate: null,
  weekStartDate: null,
};

// Map of pending tabs: tabId -> { windowId, timestamp }
const pendingTabs = new Map();

// How long to wait for URL before closing (ms)
const PENDING_TIMEOUT = 300;

// Load settings
async function getSettings() {
  try {
    const result = await browser.storage.local.get("settings");
    return { ...DEFAULT_SETTINGS, ...result.settings };
  } catch (error) {
    return DEFAULT_SETTINGS;
  }
}

// Save settings
async function saveSettings(settings) {
  await browser.storage.local.set({ settings });
}

// Get start of current week (Sunday)
function getWeekStart() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const diff = now.getDate() - dayOfWeek;
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  return weekStart.toDateString();
}

// Load stats
async function getStats() {
  try {
    const result = await browser.storage.local.get("stats");
    let stats = { ...DEFAULT_STATS, ...result.stats };

    const today = new Date().toDateString();
    const weekStart = getWeekStart();

    // Reset daily count
    if (stats.lastBlockDate !== today) {
      stats.blockedToday = 0;
    }

    // Reset weekly count if new week
    if (stats.weekStartDate !== weekStart) {
      stats.blockedWeek = 0;
      stats.weekStartDate = weekStart;
    }

    stats = updateStreak(stats);
    return stats;
  } catch (error) {
    return DEFAULT_STATS;
  }
}

// Save stats
async function saveStats(stats) {
  await browser.storage.local.set({ stats });
}

// Update streak
function updateStreak(stats) {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  if (!stats.lastActiveDate) {
    stats.currentStreak = 1;
    stats.lastActiveDate = today;
  } else if (stats.lastActiveDate === today) {
    // Already active today
  } else if (stats.lastActiveDate === yesterday) {
    stats.currentStreak++;
    stats.lastActiveDate = today;
  } else {
    stats.currentStreak = 1;
    stats.lastActiveDate = today;
  }

  if (stats.currentStreak > stats.bestStreak) {
    stats.bestStreak = stats.currentStreak;
  }

  return stats;
}

// Increment blocked count
async function incrementBlocked() {
  let stats = await getStats();
  const today = new Date().toDateString();

  stats.blockedToday++;
  stats.blockedWeek++;
  stats.blockedTotal++;
  stats.lastBlockDate = today;
  stats = updateStreak(stats);

  await saveStats(stats);
  return stats;
}

// Count tabs in a specific window
async function getWindowTabCount(windowId) {
  const tabs = await browser.tabs.query({ windowId });
  return tabs.length;
}

// Count ALL tabs across all windows
async function getGlobalTabCount() {
  const tabs = await browser.tabs.query({});
  return tabs.length;
}

// Get current tab count based on settings (per window or global)
async function getCurrentTabCount(windowId, settings) {
  if (settings.globalLimit) {
    return await getGlobalTabCount();
  } else {
    return await getWindowTabCount(windowId);
  }
}

// Check if URL is in allowlist
function isUrlAllowed(url, allowlist) {
  if (!url || !allowlist || allowlist.length === 0) return false;

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, "");

    return allowlist.some((domain) => {
      const cleanDomain = domain.toLowerCase().replace(/^www\./, "");
      return hostname === cleanDomain || hostname.endsWith("." + cleanDomain);
    });
  } catch {
    return false;
  }
}

// Check if URL is real (not blank/special)
function isRealUrl(url) {
  if (!url || url === "") return false;
  if (url === "about:blank" || url === "about:newtab") return false;
  if (url.startsWith("safari-resource:")) return false;
  if (url.startsWith("favorites://")) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

// Close tab
async function closeTab(tabId) {
  try {
    pendingTabs.delete(tabId);
    await browser.tabs.remove(tabId);
    await incrementBlocked();
    console.log(`TabCap: Tab ${tabId} closed`);
  } catch (error) {
    console.error("TabCap: Error closing tab:", error);
  }
}

// Check pending tab after timeout
async function checkPendingTab(tabId) {
  const pending = pendingTabs.get(tabId);
  if (!pending) return;

  if (Date.now() - pending.timestamp < PENDING_TIMEOUT) return;

  pendingTabs.delete(tabId);

  const settings = await getSettings();
  if (!settings.enabled) return;

  try {
    const tab = await browser.tabs.get(tabId);
    const tabCount = await getCurrentTabCount(tab.windowId, settings);

    if (tabCount <= settings.maxTabs) return;

    // Check allowlist if URL is available
    if (
      isRealUrl(tab.url) &&
      settings.allowlistEnabled &&
      isUrlAllowed(tab.url, settings.allowlist)
    ) {
      console.log(`TabCap: Tab in allowlist, keeping`);
      return;
    }

    // Close the tab
    console.log(
      `TabCap: Pending timeout, closing tab (${
        settings.globalLimit ? "global" : "per-window"
      } limit)`
    );
    await closeTab(tabId);
  } catch (error) {
    // Tab doesn't exist
  }
}

// Handler: New tab created
async function handleTabCreated(tab) {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const tabCount = await getCurrentTabCount(tab.windowId, settings);
  const limitType = settings.globalLimit ? "global" : "window";

  console.log(
    `TabCap: Tab created. Count: ${tabCount}/${settings.maxTabs} (${limitType})`
  );

  // Broadcast count update
  browser.runtime
    .sendMessage({ type: "TAB_COUNT_UPDATED", count: tabCount })
    .catch(() => {});

  if (tabCount <= settings.maxTabs) return;

  // If URL is available, check allowlist
  if (isRealUrl(tab.url)) {
    if (
      settings.allowlistEnabled &&
      isUrlAllowed(tab.url, settings.allowlist)
    ) {
      console.log(`TabCap: Tab in allowlist, keeping`);
      return;
    }

    // Close immediately
    console.log(`TabCap: Closing excess tab`);
    await closeTab(tab.id);
    return;
  }

  // No URL yet - mark as pending
  console.log(`TabCap: Tab pending URL check`);
  pendingTabs.set(tab.id, {
    windowId: tab.windowId,
    timestamp: Date.now(),
  });

  setTimeout(() => checkPendingTab(tab.id), PENDING_TIMEOUT + 50);
}

// Handler: Tab updated (for pending tabs)
async function handleTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo.url) return;
  if (!pendingTabs.has(tabId)) return;
  if (!isRealUrl(changeInfo.url)) return;

  pendingTabs.delete(tabId);

  const settings = await getSettings();
  if (!settings.enabled) return;

  const tabCount = await getCurrentTabCount(tab.windowId, settings);
  if (tabCount <= settings.maxTabs) return;

  // Check allowlist
  if (
    settings.allowlistEnabled &&
    isUrlAllowed(changeInfo.url, settings.allowlist)
  ) {
    console.log(`TabCap: Tab URL in allowlist, keeping`);
    return;
  }

  // Close the tab
  console.log(`TabCap: Closing tab, not in allowlist`);
  await closeTab(tabId);
}

// Handler: Tab removed
async function handleTabRemoved(tabId) {
  pendingTabs.delete(tabId);

  // Small delay to let Safari finish updating
  setTimeout(() => broadcastTabCount(), 100);
}

// Handler: Tab activated (window/tab group changed)
async function handleTabActivated(activeInfo) {
  try {
    const settings = await getSettings();
    const count = await getCurrentTabCount(activeInfo.windowId, settings);
    browser.runtime
      .sendMessage({ type: "TAB_COUNT_UPDATED", count })
      .catch(() => {});
  } catch {}
}

// Handler: Tab moved (reordered or moved between groups)
async function handleTabMoved(tabId, moveInfo) {
  await broadcastTabCount();
}

// Handler: Tab attached to window (moved from another window/group)
async function handleTabAttached(tabId, attachInfo) {
  await broadcastTabCount();
}

// Handler: Tab detached from window (moving to another window/group)
async function handleTabDetached(tabId, detachInfo) {
  await broadcastTabCount();
}

// Broadcast current tab count to popup
async function broadcastTabCount() {
  try {
    const settings = await getSettings();
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab) {
      const count = await getCurrentTabCount(activeTab.windowId, settings);
      browser.runtime
        .sendMessage({ type: "TAB_COUNT_UPDATED", count })
        .catch(() => {});
    }
  } catch {}
}

// Message listener
browser.runtime.onMessage.addListener(async (message) => {
  switch (message.type) {
    case "GET_SETTINGS":
      return await getSettings();

    case "SAVE_SETTINGS":
      await saveSettings(message.settings);
      return { success: true };

    case "GET_STATS":
      return await getStats();

    case "GET_TAB_COUNT":
      try {
        const settings = await getSettings();
        const [activeTab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (activeTab) {
          const count = await getCurrentTabCount(activeTab.windowId, settings);
          return { count };
        }
      } catch {}
      return { count: 0 };

    default:
      return null;
  }
});

// Register listeners
browser.tabs.onCreated.addListener(handleTabCreated);
browser.tabs.onUpdated.addListener(handleTabUpdated);
browser.tabs.onRemoved.addListener(handleTabRemoved);
browser.tabs.onActivated.addListener(handleTabActivated);
browser.tabs.onMoved.addListener(handleTabMoved);
browser.tabs.onAttached.addListener(handleTabAttached);
browser.tabs.onDetached.addListener(handleTabDetached);

// Periodic consistency check - ensures count is always correct
async function periodicCheck() {
  try {
    const settings = await getSettings();
    if (!settings.enabled) return;

    // Get current window's tabs
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!activeTab) return;

    const currentCount = await getCurrentTabCount(activeTab.windowId, settings);

    // Always broadcast the correct count
    browser.runtime
      .sendMessage({ type: "TAB_COUNT_UPDATED", count: currentCount })
      .catch(() => {});

    // If over limit, find and close excess tabs
    if (currentCount > settings.maxTabs) {
      console.log(
        `TabCap: Periodic check found ${currentCount}/${settings.maxTabs} tabs - cleaning up`
      );

      // Get tabs to evaluate
      const tabs = settings.globalLimit
        ? await browser.tabs.query({})
        : await browser.tabs.query({ windowId: activeTab.windowId });

      // Sort by id descending (newest first)
      tabs.sort((a, b) => b.id - a.id);

      let tabsToClose = currentCount - settings.maxTabs;

      for (const tab of tabs) {
        if (tabsToClose <= 0) break;

        // Skip active tab
        if (tab.active) continue;

        // Skip allowlisted tabs
        if (
          settings.allowlistEnabled &&
          isRealUrl(tab.url) &&
          isUrlAllowed(tab.url, settings.allowlist)
        ) {
          continue;
        }

        // Close this tab
        console.log(`TabCap: Periodic cleanup closing tab ${tab.id}`);
        await closeTab(tab.id);
        tabsToClose--;
      }
    }
  } catch (error) {
    console.error("TabCap: Periodic check error:", error);
  }
}

// Initialize
(async () => {
  const stats = await getStats();
  await saveStats(stats);
  console.log("TabCap: Initialized - Auto-close mode");

  // Start periodic consistency check every 2 seconds
  setInterval(periodicCheck, 2000);
})();
