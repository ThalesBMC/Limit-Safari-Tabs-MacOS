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
  inactiveEnabled: false,
  inactiveMinutes: 30,
  protectPinned: true,
  protectAudible: true,
  protectAllowlist: true,
  minTabs: 5,
  corralMax: 100,
  corralExpireHours: 24, // Auto-delete closed tabs after this many hours (0 = never)
  debounceDelay: 1, // Wait X seconds before resetting timer (0 = instant)
  wrangleOption: "exactURLMatch", // "withDupes", "exactURLMatch", "hostnameAndTitleMatch"
};

// Default stats
const DEFAULT_STATS = {
  currentStreak: 0,
  bestStreak: 0,
  blockedToday: 0,
  blockedWeek: 0,
  blockedTotal: 0,
  inactiveClosed: 0,
  lastActiveDate: null,
  lastBlockDate: null,
  weekStartDate: null,
};

// Map of pending tabs: tabId -> { windowId, timestamp }
const pendingTabs = new Map();

// Set of tabs currently showing allowlisted URLs
// When these tabs navigate AWAY from allowlist, we check if over limit and close if needed
const allowlistTabs = new Set();

// Set of tab IDs recently restored from corral - exempt from tab limit close
const corralRestoredTabs = new Set();

// Track last-accessed time for each tab (tabId -> timestamp)
// Safari doesn't support tab.lastAccessed, so we track manually
const tabLastAccessed = new Map();

const INACTIVE_ALARM_NAME = "inactiveTabCheck";

// Debounce timer for onActivated (Tab Wrangler pattern: 1s delay)
let activatedDebounceTimer = null;
let activatedDebounceTabId = null;

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

// Increment inactive tabs closed count
async function incrementInactiveClosed(count = 1) {
  let stats = await getStats();
  stats.inactiveClosed = (stats.inactiveClosed || 0) + count;
  await saveStats(stats);
  return stats;
}

// Tab Corral: save closed tabs so the user can re-open them
// Supports Tab Wrangler dedup options: withDupes, exactURLMatch, hostnameAndTitleMatch
async function addToCorral(tabs) {
  try {
    const settings = await getSettings();
    const result = await browser.storage.local.get("tabCorral");
    const corral = result.tabCorral || [];
    const wrangleOption = settings.wrangleOption || "exactURLMatch";

    for (const tab of tabs) {
      // Deduplicate based on wrangleOption (Tab Wrangler pattern)
      if (wrangleOption === "exactURLMatch") {
        const existingIdx = corral.findIndex((t) => t.url === tab.url);
        if (existingIdx > -1) corral.splice(existingIdx, 1);
      } else if (wrangleOption === "hostnameAndTitleMatch") {
        try {
          const tabHostname = new URL(tab.url).hostname;
          const existingIdx = corral.findIndex((t) => {
            try {
              return new URL(t.url).hostname === tabHostname && t.title === (tab.title || "Untitled");
            } catch { return false; }
          });
          if (existingIdx > -1) corral.splice(existingIdx, 1);
        } catch {}
      }
      // "withDupes" - no dedup

      corral.unshift({
        url: tab.url || "",
        title: tab.title || "Untitled",
        favIconUrl: tab.favIconUrl || "",
        closedAt: Date.now(),
      });
    }

    // Trim to max size
    const max = settings.corralMax || 100;
    if (corral.length > max) corral.length = max;

    await browser.storage.local.set({ tabCorral: corral });
  } catch {}
}

// Check if URL is an internal/special page that should never be closed
function isInternalUrl(url) {
  if (!url) return true;
  if (url === "about:blank" || url === "about:newtab") return true;
  if (url.startsWith("about:")) return true;
  if (url.startsWith("safari-resource:")) return true;
  if (url.startsWith("safari-web-extension:")) return true;
  if (url.startsWith("favorites://")) return true;
  if (url.startsWith("chrome://")) return true;
  return false;
}

async function getCorral() {
  try {
    const result = await browser.storage.local.get("tabCorral");
    return result.tabCorral || [];
  } catch {
    return [];
  }
}

async function restoreFromCorral(index) {
  try {
    const result = await browser.storage.local.get("tabCorral");
    const corral = result.tabCorral || [];
    if (index < 0 || index >= corral.length) return false;

    const entry = corral[index];
    corral.splice(index, 1);
    await browser.storage.local.set({ tabCorral: corral });

    const newTab = await browser.tabs.create({ url: entry.url, active: false });
    // Exempt this tab from being immediately closed by the tab limiter.
    // Without this, restoring a tab when at the limit (e.g. 3/3) would
    // trigger handleTabCreated → closeTab, defeating the purpose.
    corralRestoredTabs.add(newTab.id);
    setTimeout(() => corralRestoredTabs.delete(newTab.id), 5000);
    return true;
  } catch {
    return false;
  }
}

async function clearCorral() {
  try {
    // Use remove() instead of set() for complete deletion
    // Safari storage can be finicky with set({ key: [] })
    await browser.storage.local.remove("tabCorral");
    console.log("TabCap: Corral cleared successfully");
    return true;
  } catch (error) {
    console.error("TabCap: Error clearing corral:", error);
    return false;
  }
}

// Clean expired tabs from corral based on corralExpireHours setting
async function cleanExpiredCorral() {
  try {
    const settings = await getSettings();
    const expireHours = settings.corralExpireHours;
    
    // If 0, never expire
    if (!expireHours || expireHours <= 0) return;
    
    const result = await browser.storage.local.get("tabCorral");
    const corral = result.tabCorral || [];
    if (corral.length === 0) return;
    
    const now = Date.now();
    const expireMs = expireHours * 60 * 60 * 1000;
    
    const filtered = corral.filter(tab => {
      const age = now - (tab.closedAt || 0);
      return age < expireMs;
    });
    
    if (filtered.length !== corral.length) {
      await browser.storage.local.set({ tabCorral: filtered });
      console.log(`TabCap: Cleaned ${corral.length - filtered.length} expired tabs from corral`);
    }
  } catch (error) {
    console.error("TabCap: Error cleaning expired corral:", error);
  }
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
  // NOTE: We don't set tabLastAccessed here - it will be set by handleTabActivated
  // after the debounce period. This ensures quick tab-switches don't reset timers.

  const settings = await getSettings();
  if (!settings.enabled) return;

  // Skip tab limit enforcement for tabs restored from corral
  if (corralRestoredTabs.has(tab.id)) {
    console.log(`TabCap: Tab restored from corral, skipping limit check (id: ${tab.id})`);
    await broadcastTabCount();
    return;
  }

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
  // Safari doesn't always populate changeInfo.url (known bug in older versions).
  // Use tab.url (3rd param) as fallback when changeInfo.url is unavailable.
  const url = changeInfo.url || (tab && tab.url);
  if (!url) return;
  if (!isRealUrl(url)) return;

  const settings = await getSettings();
  if (!settings.enabled) return;
  if (!settings.allowlistEnabled) return;

  const isNowAllowlisted = isUrlAllowed(url, settings.allowlist);
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
  tabLastAccessed.delete(tabId);
  persistTabActivity();

  // Small delay to let Safari finish updating
  setTimeout(async () => {
    await broadcastTabCount();
    await updateBadge();
  }, 100);
}

// Handler: Tab activated (window/tab group changed)
// Tab Wrangler pattern: debounceOnActivated - only reset timer after tab is
// active for 1 second. Prevents rapid tab-switching from resetting all timers.
async function handleTabActivated(activeInfo) {
  const settings = await getSettings();

  const delay = settings.debounceDelay != null ? settings.debounceDelay : 1;
  const delayMs = delay * 1000;

  if (delay > 0) {
    // Cancel previous debounce if user switched away quickly
    if (activatedDebounceTimer) {
      clearTimeout(activatedDebounceTimer);
      activatedDebounceTimer = null;
    }
    activatedDebounceTabId = activeInfo.tabId;
    activatedDebounceTimer = setTimeout(() => {
      // Only update if this tab is still the one being debounced
      if (activatedDebounceTabId === activeInfo.tabId) {
        tabLastAccessed.set(activeInfo.tabId, Date.now());
        persistTabActivity();
      }
      activatedDebounceTimer = null;
      activatedDebounceTabId = null;
    }, delayMs);
  } else {
    tabLastAccessed.set(activeInfo.tabId, Date.now());
    persistTabActivity();
  }

  // Service worker may have just woken up - run inactive check
  // to catch tabs that expired while worker was suspended
  checkInactiveTabs().catch(() => {});

  try {
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

// Handler: Window focus changed (user switched between Safari windows)
async function handleWindowFocusChanged(windowId) {
  // windowId is -1 when all windows lose focus (Safari goes to background)
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  
  // Service worker woke up - check inactive tabs
  checkInactiveTabs().catch(() => {});
  await broadcastTabCount();
}

// Handler: New window created
async function handleWindowCreated(window) {
  checkInactiveTabs().catch(() => {});
  await broadcastTabCount();
}

// Handler: Window removed/closed
async function handleWindowRemoved(windowId) {
  checkInactiveTabs().catch(() => {});
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

// Persist tab activity to storage (survives service worker restart)
// Debounced to avoid excessive writes on rapid tab switches.
// Also flushes on every alarm tick (since the debounce setTimeout can be
// killed if the service worker terminates before it fires).
let persistTimer = null;
let persistDirty = false;
function persistTabActivity() {
  persistDirty = true;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    await _flushPersist();
  }, 2000);
}

async function _flushPersist() {
  if (!persistDirty) return;
  persistDirty = false;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  try {
    const data = Object.fromEntries(tabLastAccessed);
    await browser.storage.local.set({ tabActivity: data });
  } catch {}
}

// Force immediate persist (for critical moments like before close)
async function persistTabActivityNow() {
  persistDirty = true;
  await _flushPersist();
}

// Restore tab activity from storage on service worker startup
async function restoreTabActivity() {
  try {
    const result = await browser.storage.local.get("tabActivity");
    if (result.tabActivity) {
      // Only restore entries for tabs that still exist
      const allTabs = await browser.tabs.query({});
      const existingIds = new Set(allTabs.map((t) => t.id));

      for (const [idStr, timestamp] of Object.entries(result.tabActivity)) {
        const id = parseInt(idStr);
        if (existingIds.has(id)) {
          tabLastAccessed.set(id, timestamp);
        }
      }
    }

    // Ensure all current tabs have an entry
    const allTabs = await browser.tabs.query({});
    const now = Date.now();
    for (const tab of allTabs) {
      if (!tabLastAccessed.has(tab.id)) {
        tabLastAccessed.set(tab.id, now);
      }
    }

    await persistTabActivity();
  } catch {}
}

// Check and close inactive tabs
// Guarded by mutex and throttle to prevent concurrent/excessive execution
let inactiveCheckRunning = false;
let lastInactiveCheck = 0;
const INACTIVE_CHECK_THROTTLE = 2000; // 2s minimum between checks (was 10s)

async function checkInactiveTabs(force = false) {
  // Throttle: skip if checked recently (unless forced by alarm)
  const now = Date.now();
  if (!force && now - lastInactiveCheck < INACTIVE_CHECK_THROTTLE) return;

  // Mutex: skip if already running
  if (inactiveCheckRunning) return;
  inactiveCheckRunning = true;
  lastInactiveCheck = now;

  try {
    await _doInactiveCheck();
  } finally {
    inactiveCheckRunning = false;
  }
}

async function _doInactiveCheck() {
  const settings = await getSettings();
  if (!settings.inactiveEnabled) return;

  const now = Date.now();
  const limitMs = settings.inactiveMinutes * 60 * 1000;

  // Handle sleep/wake drift: if any timestamp is in the future
  // (clock changed), recalibrate
  for (const [tabId, ts] of tabLastAccessed) {
    if (ts > now) {
      tabLastAccessed.set(tabId, now);
    }
  }

  const allTabs = await browser.tabs.query({});

  // Group tabs by window to enforce "keep at least 1 per window"
  const windowTabs = new Map();
  for (const tab of allTabs) {
    if (!windowTabs.has(tab.windowId)) {
      windowTabs.set(tab.windowId, []);
    }
    windowTabs.get(tab.windowId).push(tab);
  }

  const minTabs = Math.max(0, settings.minTabs != null ? settings.minTabs : 5);
  const tabsToClose = [];

  for (const tab of allTabs) {
    // Never close the active tab
    // Only refresh timestamp if no debounce is pending for this tab
    if (tab.active) {
      if (activatedDebounceTabId !== tab.id) {
        tabLastAccessed.set(tab.id, now);
      }
      continue;
    }

    // Never close internal/special pages (Tab Wrangler: about:, chrome://)
    if (isInternalUrl(tab.url)) {
      tabLastAccessed.set(tab.id, now);
      continue;
    }

    // Protected tabs: refresh timestamp (like Tab Wrangler) instead of
    // just skipping. This prevents them from accumulating stale timestamps
    // that would cause immediate close if protection is later disabled.
    if (settings.protectPinned && tab.pinned) {
      tabLastAccessed.set(tab.id, now);
      continue;
    }
    if (settings.protectAudible && tab.audible) {
      tabLastAccessed.set(tab.id, now);
      continue;
    }
    if (settings.protectAllowlist && settings.allowlistEnabled && settings.allowlist.length > 0) {
      if (isUrlAllowed(tab.url, settings.allowlist)) {
        tabLastAccessed.set(tab.id, now);
        continue;
      }
    }

    const lastAccessed = tabLastAccessed.get(tab.id);
    if (!lastAccessed) {
      tabLastAccessed.set(tab.id, now);
      continue;
    }

    const elapsed = now - lastAccessed;
    if (elapsed >= limitMs) {
      tabsToClose.push({ id: tab.id, windowId: tab.windowId, elapsed });
    }
  }

  // Sort by elapsed descending (close the oldest-inactive first)
  tabsToClose.sort((a, b) => b.elapsed - a.elapsed);

  // Track how many tabs remain per window
  const windowRemaining = new Map();
  for (const [windowId, tabs] of windowTabs) {
    windowRemaining.set(windowId, tabs.length);
  }

  // minTabs check: if a window is already at or below minTabs,
  // reset all its candidates' timestamps (Tab Wrangler pattern).
  // This gives them a fresh timer instead of closing immediately
  // when a new tab arrives.
  for (const [windowId, tabs] of windowTabs) {
    if (tabs.length <= minTabs) {
      for (const tab of tabs) {
        tabLastAccessed.set(tab.id, now);
      }
    }
  }

  // Filter out candidates from windows already at minTabs
  const eligibleToClose = tabsToClose.filter(({ windowId }) => {
    return windowRemaining.get(windowId) > minTabs;
  });

  // Determine which tabs we can actually close (respect minTabs per window)
  const tabsToActuallyClose = [];
  for (const { id, windowId } of eligibleToClose) {
    if (windowRemaining.get(windowId) <= minTabs) {
      // Reset timestamp for tabs we can't close yet
      tabLastAccessed.set(id, now);
      continue;
    }
    
    // Save tab info to corral before closing
    const tab = allTabs.find((t) => t.id === id);
    if (tab) tabsToActuallyClose.push({ id, windowId, tab });
    
    // Pre-decrement to calculate correctly for subsequent tabs in same window
    windowRemaining.set(windowId, windowRemaining.get(windowId) - 1);
  }

  // Close all eligible tabs in parallel for instant bulk close
  if (tabsToActuallyClose.length > 0) {
    const closedTabs = tabsToActuallyClose.map(({ tab }) => tab);
    
    // Clean up tracking first
    for (const { id } of tabsToActuallyClose) {
      tabLastAccessed.delete(id);
    }
    
    // Close all tabs in parallel
    const closePromises = tabsToActuallyClose.map(async ({ id }) => {
      try {
        await browser.tabs.remove(id);
        return { id, success: true };
      } catch (error) {
        console.log(`TabCap: Error closing inactive tab ${id}:`, error);
        return { id, success: false };
      }
    });
    
    const results = await Promise.all(closePromises);
    const successCount = results.filter(r => r.success).length;
    console.log(`TabCap: Closed ${successCount} inactive tabs at once`);
    
    // Save to corral and update stats
    await addToCorral(closedTabs);
    await incrementInactiveClosed(successCount);
    await persistTabActivityNow();
    await broadcastTabCount();
    await updateBadge();
  }
}

// Get inactive tabs info for popup display
async function getInactiveTabsInfo() {
  const settings = await getSettings();
  const now = Date.now();
  const allTabs = await browser.tabs.query({});
  const result = [];

  for (const tab of allTabs) {
    if (tab.active) continue;

    const lastAccessed = tabLastAccessed.get(tab.id) || now;
    let isProtected = false;
    let protectReason = "";

    if (settings.protectPinned && tab.pinned) {
      isProtected = true;
      protectReason = "pinned";
    } else if (settings.protectAudible && tab.audible) {
      isProtected = true;
      protectReason = "audible";
    } else if (settings.protectAllowlist && settings.allowlistEnabled && settings.allowlist.length > 0) {
      if (isUrlAllowed(tab.url, settings.allowlist)) {
        isProtected = true;
        protectReason = "allowlist";
      }
    }

    result.push({
      id: tab.id,
      title: tab.title || "Untitled",
      lastAccessed,
      isProtected,
      protectReason,
    });
  }

  // Sort by last accessed (oldest first)
  result.sort((a, b) => a.lastAccessed - b.lastAccessed);
  return result;
}

// Setup or clear the inactive tabs alarm
async function setupInactiveAlarm() {
  const settings = await getSettings();

  // Clear existing alarm
  try {
    await browser.alarms.clear(INACTIVE_ALARM_NAME);
  } catch {}

  if (settings.inactiveEnabled) {
    // Check every minute (minimum alarm interval)
    await browser.alarms.create(INACTIVE_ALARM_NAME, { periodInMinutes: 1 });
    console.log("TabCap: Inactive tab alarm created");
  }
}

// Alarm listener
browser.alarms.onAlarm.addListener(async (alarm) => {
  // Safety net: flush any dirty persist data on every alarm tick.
  // This handles the case where the debounce setTimeout was killed
  // when the service worker was terminated.
  await _flushPersist();

  if (alarm.name === INACTIVE_ALARM_NAME) {
    await checkInactiveTabs(true); // force=true bypasses throttle
  } else if (alarm.name === "periodicCheck") {
    await periodicCheck();
    await cleanExpiredCorral(); // Clean old tabs from corral
  }
});

// Message listener
browser.runtime.onMessage.addListener(async (message) => {
  switch (message.type) {
    case "GET_SETTINGS":
      return await getSettings();

    case "SAVE_SETTINGS": {
      // Tab Wrangler pattern: reset all timers when inactivity time changes
      const oldSettings = await getSettings();
      const newSettings = message.settings;
      await saveSettings(newSettings);

      if (oldSettings.inactiveMinutes !== newSettings.inactiveMinutes) {
        const now = Date.now();
        for (const tabId of tabLastAccessed.keys()) {
          tabLastAccessed.set(tabId, now);
        }
        await persistTabActivityNow();
        console.log("TabCap: Timer reset - inactivity time changed");
      }

      await updateBadge();
      await setupInactiveAlarm();

      return { success: true };
    }

    case "GET_STATS":
      return await getStats();

    case "GET_INACTIVE_TABS":
      const inactiveTabs = await getInactiveTabsInfo();
      return { tabs: inactiveTabs };

    case "GET_CORRAL":
      return { tabs: await getCorral() };

    case "RESTORE_FROM_CORRAL": {
      const restored = await restoreFromCorral(message.index);
      return { success: restored };
    }

    case "CLEAR_CORRAL": {
      const success = await clearCorral();
      return { success };
    }

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

// Window listeners - help wake up service worker more frequently
browser.windows.onFocusChanged.addListener(handleWindowFocusChanged);
browser.windows.onCreated.addListener(handleWindowCreated);
browser.windows.onRemoved.addListener(handleWindowRemoved);

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

  // Restore tab activity tracking from storage
  await restoreTabActivity();

  // Setup inactive tab alarm
  await setupInactiveAlarm();

  // Run immediate check for tabs that expired while worker was down
  await checkInactiveTabs();

  // Initialize badge
  await updateBadge();

  // Setup periodic consistency check via alarm (replaces unreliable setInterval)
  // setInterval dies when the service worker is terminated; alarms survive
  try {
    await browser.alarms.create("periodicCheck", { periodInMinutes: 1 });
  } catch (e) {
    console.log("TabCap: Could not create periodic alarm, falling back to setInterval");
    setInterval(periodicCheck, 30000);
  }
})();
