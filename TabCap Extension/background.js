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

// Set of tabs currently showing allowlisted URLs
// When these tabs navigate AWAY from allowlist, we check if over limit and close if needed
const allowlistTabs = new Set();

// How long to wait for URL before closing (ms)
const PENDING_TIMEOUT = 300;

// Update extension badge with current tab count
async function updateBadge() {
  try {
    const settings = await getSettings();
    
    // Show "OFF" when disabled
    if (!settings.enabled) {
      await browser.action.setBadgeText({ text: "OFF" });
      await browser.action.setBadgeBackgroundColor({ color: "#737373" });
      return;
    }
    
    // Get current tab count
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    
    if (!activeTab) {
      await browser.action.setBadgeText({ text: "" });
      return;
    }
    
    const count = await getCurrentTabCount(activeTab.windowId, settings);
    const max = settings.maxTabs;
    const ratio = count / max;
    
    // Set badge text as "X/Y"
    await browser.action.setBadgeText({ text: `${count}/${max}` });
    
    // Color based on proximity to limit
    let color;
    if (count >= max) {
      color = "#ef4444"; // Red - at limit
    } else if (ratio >= 0.7) {
      color = "#f59e0b"; // Yellow - 70%+ of limit
    } else {
      color = "#22c55e"; // Green - below 70%
    }
    
    await browser.action.setBadgeBackgroundColor({ color });
  } catch (error) {
    console.log("TabCap: Badge update error:", error);
  }
}

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

// Count tabs in a specific window (excluding allowlisted if enabled)
async function getWindowTabCount(windowId, settings) {
  const tabs = await browser.tabs.query({ windowId });

  // If allowlist is enabled, don't count allowlisted tabs
  if (settings && settings.allowlistEnabled && settings.allowlist.length > 0) {
    return tabs.filter((tab) => !isUrlAllowed(tab.url, settings.allowlist))
      .length;
  }

  return tabs.length;
}

// Count ALL tabs across all windows (excluding allowlisted if enabled)
async function getGlobalTabCount(settings) {
  const tabs = await browser.tabs.query({});

  // If allowlist is enabled, don't count allowlisted tabs
  if (settings && settings.allowlistEnabled && settings.allowlist.length > 0) {
    return tabs.filter((tab) => !isUrlAllowed(tab.url, settings.allowlist))
      .length;
  }

  return tabs.length;
}

// Get current tab count based on settings (per window or global)
async function getCurrentTabCount(windowId, settings) {
  if (settings.globalLimit) {
    return await getGlobalTabCount(settings);
  } else {
    return await getWindowTabCount(windowId, settings);
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
    allowlistTabs.delete(tabId);
    await browser.tabs.remove(tabId);
    await incrementBlocked();
    console.log(`TabCap: Tab ${tabId} closed`);
  } catch (error) {
    console.error("TabCap: Error closing tab:", error);
  }
}

// Check pending tab after timeout
// RULE: We ONLY close THIS pending tab if it's not allowlisted, NEVER other tabs
async function checkPendingTab(tabId) {
  const pending = pendingTabs.get(tabId);
  if (!pending) return;

  if (Date.now() - pending.timestamp < PENDING_TIMEOUT) return;

  pendingTabs.delete(tabId);

  const settings = await getSettings();
  if (!settings.enabled) return;
  if (!settings.allowlistEnabled) return; // Pending tabs only exist when allowlist is enabled

  try {
    const tab = await browser.tabs.get(tabId);

    // Check if this tab is in allowlist
    if (isRealUrl(tab.url) && isUrlAllowed(tab.url, settings.allowlist)) {
      // Tab is allowlisted - track it so we detect when it leaves
      allowlistTabs.add(tabId);
      console.log(
        `TabCap: Pending tab is in allowlist, tracking (id: ${tabId})`
      );
      return;
    }

    // Tab is NOT in allowlist - check if we're over limit
    const tabCount = await getCurrentTabCount(tab.windowId, settings);
    if (tabCount <= settings.maxTabs) {
      console.log(`TabCap: Within limit now, keeping tab`);
      return;
    }

    // Over limit and this tab is NOT allowlisted - close THIS tab only
    console.log(`TabCap: Closing pending tab (not in allowlist, over limit)`);
    await closeTab(tabId);
  } catch (error) {
    // Tab doesn't exist anymore
  }
}

// Handler: New tab created
// RULE: We ONLY close the NEW tab, NEVER existing tabs
async function handleTabCreated(tab) {
  const settings = await getSettings();
  if (!settings.enabled) return;

  // If allowlist is enabled, track allowlisted tabs (even if within limit)
  // This is needed to detect when they leave allowlist later
  if (settings.allowlistEnabled && isRealUrl(tab.url)) {
    if (isUrlAllowed(tab.url, settings.allowlist)) {
      allowlistTabs.add(tab.id);
      console.log(`TabCap: New tab in allowlist, tracking (id: ${tab.id})`);
    }
  }

  // Broadcast count update
  const tabCount = await getCurrentTabCount(tab.windowId, settings);
  const limitType = settings.globalLimit ? "global" : "window";

  console.log(
    `TabCap: Tab created. Count: ${tabCount}/${settings.maxTabs} (${limitType})`
  );

  browser.runtime
    .sendMessage({ type: "TAB_COUNT_UPDATED", count: tabCount })
    .catch(() => {});

  // Update badge
  await updateBadge();

  // If within limit, nothing to do
  if (tabCount <= settings.maxTabs) return;

  // Over limit - but we ONLY close the NEW tab, never existing ones

  // If allowlist is enabled, check if this new tab is in allowlist
  if (settings.allowlistEnabled) {
    // If URL is available, check if it's allowlisted
    if (isRealUrl(tab.url)) {
      if (isUrlAllowed(tab.url, settings.allowlist)) {
        // New tab is in allowlist - it doesn't count, keep it (already tracked above)
        console.log(`TabCap: New tab in allowlist, doesn't count toward limit`);
        return;
      }
      // New tab is NOT in allowlist - close IT (not old tabs)
      console.log(`TabCap: Closing NEW tab (not in allowlist, over limit)`);
      await closeTab(tab.id);
      return;
    }

    // No URL yet - wait and check later
    console.log(`TabCap: Tab pending URL check`);
    pendingTabs.set(tab.id, {
      windowId: tab.windowId,
      timestamp: Date.now(),
    });
    setTimeout(() => checkPendingTab(tab.id), PENDING_TIMEOUT + 50);
    return;
  }

  // Allowlist disabled - close the NEW tab (never existing tabs)
  console.log(`TabCap: Closing NEW excess tab`);
  await closeTab(tab.id);
}

// Handler: Tab updated
// Tracks tabs entering/leaving allowlist and enforces limits
async function handleTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo.url) return;
  if (!isRealUrl(changeInfo.url)) return;

  const settings = await getSettings();
  if (!settings.enabled) return;
  if (!settings.allowlistEnabled) return;

  const isNowAllowlisted = isUrlAllowed(changeInfo.url, settings.allowlist);
  const wasAllowlisted = allowlistTabs.has(tabId);

  // Case 1: Pending tab got its URL
  if (pendingTabs.has(tabId)) {
    pendingTabs.delete(tabId);

    if (isNowAllowlisted) {
      allowlistTabs.add(tabId);
      console.log(
        `TabCap: Pending tab is in allowlist, tracking (id: ${tabId})`
      );
      return;
    }

    // Not allowlisted - close if over limit
    const tabCount = await getCurrentTabCount(tab.windowId, settings);
    if (tabCount > settings.maxTabs) {
      console.log(`TabCap: Closing pending tab (not in allowlist, over limit)`);
      await closeTab(tabId);
    }
    return;
  }

  // Case 2: Tab navigated to allowlist site
  if (isNowAllowlisted && !wasAllowlisted) {
    allowlistTabs.add(tabId);
    console.log(`TabCap: Tab entered allowlist, tracking (id: ${tabId})`);
    // Broadcast updated count (this tab no longer counts)
    await broadcastTabCount();
    return;
  }

  // Case 3: Tab LEFT allowlist (was allowlisted, now isn't)
  if (!isNowAllowlisted && wasAllowlisted) {
    allowlistTabs.delete(tabId);
    console.log(`TabCap: Tab left allowlist (id: ${tabId})`);

    // This tab now counts toward the limit - check if we're over
    const tabCount = await getCurrentTabCount(tab.windowId, settings);

    if (tabCount > settings.maxTabs) {
      console.log(
        `TabCap: Over limit after leaving allowlist - closing tab (id: ${tabId})`
      );
      await closeTab(tabId);
    } else {
      console.log(`TabCap: Within limit, tab is now regular (id: ${tabId})`);
      await broadcastTabCount();
    }
  }
}

// Handler: Tab removed
async function handleTabRemoved(tabId) {
  pendingTabs.delete(tabId);
  allowlistTabs.delete(tabId);

  // Small delay to let Safari finish updating
  setTimeout(async () => {
    await broadcastTabCount();
    await updateBadge();
  }, 100);
}

// Handler: Tab activated (window/tab group changed)
async function handleTabActivated(activeInfo) {
  try {
    const settings = await getSettings();
    const count = await getCurrentTabCount(activeInfo.windowId, settings);
    browser.runtime
      .sendMessage({ type: "TAB_COUNT_UPDATED", count })
      .catch(() => {});
    await updateBadge();
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
      await updateBadge();
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
      await updateBadge();
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

// Periodic consistency check - broadcasts count to popup
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

    // Broadcast count to popup
    browser.runtime
      .sendMessage({ type: "TAB_COUNT_UPDATED", count: currentCount })
      .catch(() => {});

    // Update badge
    await updateBadge();

    // Note: Safari doesn't fire onUpdated when user types in URL bar
    // This is a known limitation - clicking links works, typing URLs doesn't
  } catch (error) {
    console.error("TabCap: Periodic check error:", error);
  }
}

// Initialize
(async () => {
  const stats = await getStats();
  await saveStats(stats);
  console.log("TabCap: Initialized - Auto-close mode");

  // Initialize badge
  await updateBadge();

  // Start periodic consistency check every 2 seconds
  setInterval(periodicCheck, 2000);
})();
