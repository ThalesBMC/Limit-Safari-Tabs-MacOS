// Safari Tab Limit - Popup Script

// Friction phrases
const FRICTION_PHRASES = [
  "I am intentionally choosing distraction",
  "I am breaking my focus on purpose",
  "I accept this will hurt my productivity",
  "I choose distraction over deep work",
  "I am consciously multitasking now",
  "I understand this breaks my momentum",
  "I know this will fragment my attention",
  "I accept the cost of context switching",
  "I am trading focus for convenience",
  "I acknowledge this hurts my flow state",
  "This is my choice and I own it",
  "I take full responsibility for this",
  "I am aware of what I am doing",
  "I choose short-term over long-term",
  "I am deliberately reducing my focus",
  "I will return to focused work soon",
  "This is temporary and intentional",
  "I promise to re-engage my focus",
  "I am making an exception not a habit",
  "I will protect my focus after this",
  "I am sabotaging my own success",
  "I am choosing chaos over clarity",
  "I am letting distraction win today",
  "I know better but I do it anyway",
  "I am betraying my future self",
  "I accept I am wasting my potential",
  "I am feeding my worst habits",
  "I prefer noise over signal right now",
  "I am choosing the easy path",
  "I am stealing time from my goals",
  "I know this dopamine is not worth it",
  "I am actively hurting my brain",
  "I choose scattered over centered",
  "I am giving up on deep thinking",
  "I am training my brain to quit",
];

// State
let settings = {
  enabled: true,
  maxTabs: 2,
  globalLimit: false,
  allowlistEnabled: false,
  allowlist: [],
  tabLimitLocked: false,
};

let stats = {
  currentStreak: 0,
  bestStreak: 0,
  blockedToday: 0,
  blockedWeek: 0,
  blockedTotal: 0,
};

// DOM Elements
let elements = {};

function initElements() {
  elements = {
    tabs: document.querySelectorAll(".tab"),
    tabContents: document.querySelectorAll(".tab-content"),
    statusCard: document.getElementById("statusCard"),
    statusIcon: document.getElementById("statusIcon"),
    statusText: document.getElementById("statusText"),
    currentTabsSpan: document.getElementById("currentTabs"),
    maxTabsSpan: document.getElementById("maxTabs"),
    maxTabsValue: document.getElementById("maxTabsValue"),
    decreaseBtn: document.getElementById("decreaseMax"),
    increaseBtn: document.getElementById("increaseMax"),
    disableBtn: document.getElementById("disableBtn"),
    lockBtn: document.getElementById("lockBtn"),
    lockIcon: document.getElementById("lockIcon"),
    unlockIcon: document.getElementById("unlockIcon"),
    stepper: document.getElementById("stepper"),
    lockHint: document.getElementById("lockHint"),
    pauseIcon: document.getElementById("pauseIcon"),
    pauseBars: document.querySelectorAll(".pause-bar"),
    playIcon: document.getElementById("playIcon"),
    globalLimitToggle: document.getElementById("globalLimitToggle"),
    globalHint: document.getElementById("globalHint"),
    allowlistToggle: document.getElementById("allowlistToggle"),
    allowlistContainer: document.getElementById("allowlistContainer"),
    allowlistInput: document.getElementById("allowlistInput"),
    addDomainBtn: document.getElementById("addDomainBtn"),
    domainsList: document.getElementById("domainsList"),
    settingsContainer: document.getElementById("settingsContainer"),
    activeState: document.getElementById("activeState"),
    inactiveState: document.getElementById("inactiveState"),
    enableBtn: document.getElementById("enableBtn"),
    currentStreak: document.getElementById("currentStreak"),
    bestStreak: document.getElementById("bestStreak"),
    blockedToday: document.getElementById("blockedToday"),
    blockedWeek: document.getElementById("blockedWeek"),
    blockedTotal: document.getElementById("blockedTotal"),
    frictionModal: document.getElementById("frictionModal"),
    modalTitle: document.getElementById("modalTitle"),
    modalMessage: document.getElementById("modalMessage"),
    phraseBox: document.getElementById("phraseBox"),
    phraseInput: document.getElementById("phraseInput"),
    modalCancel: document.getElementById("modalCancel"),
    modalConfirm: document.getElementById("modalConfirm"),
  };
}

function getRandomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function loadSettings() {
  try {
    const response = await browser.runtime.sendMessage({
      type: "GET_SETTINGS",
    });
    if (response) settings = { ...settings, ...response };
  } catch {}
}

async function saveSettings() {
  try {
    await browser.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
  } catch {}
}

async function loadStats() {
  try {
    const response = await browser.runtime.sendMessage({ type: "GET_STATS" });
    if (response) stats = { ...stats, ...response };
  } catch {}
}

async function updateTabCount() {
  try {
    const response = await browser.runtime.sendMessage({
      type: "GET_TAB_COUNT",
    });
    if (response && elements.currentTabsSpan) {
      elements.currentTabsSpan.textContent = response.count;
    }
  } catch {}
}

// Listen for real-time tab count updates from background
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "TAB_COUNT_UPDATED" && elements.currentTabsSpan) {
    elements.currentTabsSpan.textContent = message.count;
  }
});

function updateUI() {
  // Toggle active/inactive states
  if (elements.activeState) {
    elements.activeState.style.display = settings.enabled ? "block" : "none";
  }
  if (elements.inactiveState) {
    elements.inactiveState.style.display = settings.enabled ? "none" : "block";
  }

  // Max tabs
  if (elements.maxTabsSpan) elements.maxTabsSpan.textContent = settings.maxTabs;
  if (elements.maxTabsValue)
    elements.maxTabsValue.textContent = settings.maxTabs;

  // Lock UI
  updateLockUI();
  updatePausePlayIcon();

  // Global limit
  if (elements.globalLimitToggle)
    elements.globalLimitToggle.checked = settings.globalLimit;
  updateGlobalHint();

  // Allowlist
  if (elements.allowlistToggle)
    elements.allowlistToggle.checked = settings.allowlistEnabled;
  if (elements.allowlistContainer) {
    elements.allowlistContainer.classList.toggle(
      "enabled",
      settings.allowlistEnabled
    );
  }
  renderDomains();

  // Stats
  if (elements.currentStreak)
    elements.currentStreak.textContent = stats.currentStreak;
  if (elements.bestStreak) elements.bestStreak.textContent = stats.bestStreak;
  if (elements.blockedToday)
    elements.blockedToday.textContent = stats.blockedToday;
  if (elements.blockedWeek)
    elements.blockedWeek.textContent = stats.blockedWeek;
  if (elements.blockedTotal)
    elements.blockedTotal.textContent = stats.blockedTotal;
}

function updateLockUI() {
  const isLocked = settings.tabLimitLocked;

  if (elements.lockIcon)
    elements.lockIcon.style.display = isLocked ? "block" : "none";
  if (elements.unlockIcon)
    elements.unlockIcon.style.display = isLocked ? "none" : "block";
  if (elements.lockBtn) {
    elements.lockBtn.classList.toggle("locked", isLocked);
    elements.lockBtn.title = isLocked ? "Unlock tab limit" : "Lock tab limit";
  }
  if (elements.stepper) elements.stepper.classList.toggle("locked", isLocked);

  if (elements.lockHint) {
    const unlockedHint = elements.lockHint.querySelector(".unlocked-hint");
    const lockedHint = elements.lockHint.querySelector(".locked-hint");
    if (unlockedHint) unlockedHint.style.display = isLocked ? "none" : "inline";
    if (lockedHint) lockedHint.style.display = isLocked ? "inline" : "none";
  }
}

function updatePausePlayIcon() {
  const isEnabled = settings.enabled;

  if (elements.pauseIcon)
    elements.pauseIcon.style.display = isEnabled ? "block" : "none";
  elements.pauseBars.forEach(
    (bar) => (bar.style.display = isEnabled ? "block" : "none")
  );
  if (elements.playIcon)
    elements.playIcon.style.display = isEnabled ? "none" : "block";
  if (elements.disableBtn) {
    elements.disableBtn.title = isEnabled
      ? "Disable protection"
      : "Enable protection";
  }
}

function updateGlobalHint() {
  if (elements.globalHint) {
    const perWindowHint = elements.globalHint.querySelector(".per-window-hint");
    const globalHint = elements.globalHint.querySelector(".global-hint");
    if (perWindowHint)
      perWindowHint.style.display = settings.globalLimit ? "none" : "inline";
    if (globalHint)
      globalHint.style.display = settings.globalLimit ? "inline" : "none";
  }
}

function renderDomains() {
  if (!elements.domainsList) return;
  elements.domainsList.innerHTML = "";

  settings.allowlist.forEach((domain, index) => {
    const tag = document.createElement("div");
    tag.className = "domain-tag";
    tag.innerHTML = `<span>${domain}</span><button data-index="${index}">×</button>`;
    elements.domainsList.appendChild(tag);
  });
}

// Friction modal
let currentFrictionAction = null;
let currentFrictionPhrase = "";

function showFrictionModal(action) {
  currentFrictionAction = action;
  currentFrictionPhrase = getRandomItem(FRICTION_PHRASES);

  const titles = {
    disable: "Disable Protection?",
    allowlist: "Enable Allowlist?",
    unlock: "Unlock Tab Limit?",
    disableGlobal: "Disable Global Limit?",
  };

  const messages = {
    disable: "This will allow unlimited tabs. Type the phrase to confirm:",
    allowlist:
      "This lets some sites bypass limits. Type the phrase to confirm:",
    unlock: "This allows changing your tab limit. Type the phrase to confirm:",
    disableGlobal:
      "This allows tabs in other windows. Type the phrase to confirm:",
  };

  elements.modalTitle.textContent = titles[action];
  elements.modalMessage.textContent = messages[action];
  elements.phraseBox.textContent = currentFrictionPhrase;
  elements.phraseInput.value = "";
  elements.modalConfirm.disabled = true;
  elements.frictionModal.classList.add("show");
  elements.phraseInput.focus();
}

function hideFrictionModal() {
  elements.frictionModal.classList.remove("show");
  elements.phraseInput.value = "";
  elements.phraseInput.classList.remove("error");
  currentFrictionAction = null;
}

function validatePhrase() {
  const typed = elements.phraseInput.value.trim().toLowerCase();
  const required = currentFrictionPhrase.toLowerCase();
  elements.modalConfirm.disabled = typed !== required;
  return typed === required;
}

async function confirmFrictionAction() {
  if (!validatePhrase()) {
    elements.phraseInput.classList.add("error");
    setTimeout(() => elements.phraseInput.classList.remove("error"), 300);
    return;
  }

  if (currentFrictionAction === "disable") settings.enabled = false;
  else if (currentFrictionAction === "allowlist")
    settings.allowlistEnabled = true;
  else if (currentFrictionAction === "unlock") settings.tabLimitLocked = false;
  else if (currentFrictionAction === "disableGlobal")
    settings.globalLimit = false;

  await saveSettings();
  updateUI();
  hideFrictionModal();
}

function sanitizeDomain(input) {
  return input
    .trim() // Remove leading/trailing spaces
    .toLowerCase() // Convert to lowercase
    .replace(/\s+/g, "") // Remove all spaces
    .replace(/^https?:\/\//, "") // Remove http:// or https://
    .replace(/^www\./, "") // Remove www.
    .split("/")[0] // Remove path (keep only domain)
    .split("?")[0] // Remove query params
    .split("#")[0]; // Remove hash
}

async function addDomain() {
  const domain = sanitizeDomain(elements.allowlistInput.value);
  if (!domain) return;

  if (!settings.allowlist.includes(domain)) {
    settings.allowlist.push(domain);
    await saveSettings();
    updateUI();
  }

  elements.allowlistInput.value = "";
}

async function removeDomain(index) {
  settings.allowlist.splice(index, 1);
  await saveSettings();
  updateUI();
}

function setupEventListeners() {
  // Tab switching
  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetTab = tab.dataset.tab;
      elements.tabs.forEach((t) => t.classList.remove("active"));
      elements.tabContents.forEach((tc) => tc.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`${targetTab}-tab`).classList.add("active");

      // Reset scroll position
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      elements.tabContents.forEach((tc) => (tc.scrollTop = 0));
    });
  });

  // Lock button
  if (elements.lockBtn) {
    elements.lockBtn.addEventListener("click", async () => {
      if (settings.tabLimitLocked) {
        showFrictionModal("unlock");
      } else {
        settings.tabLimitLocked = true;
        await saveSettings();
        updateUI();
      }
    });
  }

  // Stepper
  if (elements.decreaseBtn) {
    elements.decreaseBtn.addEventListener("click", async () => {
      if (settings.tabLimitLocked) return;
      if (settings.maxTabs > 1) {
        settings.maxTabs--;
        await saveSettings();
        updateUI();
      }
    });
  }

  if (elements.increaseBtn) {
    elements.increaseBtn.addEventListener("click", async () => {
      if (settings.tabLimitLocked) return;
      if (settings.maxTabs < 500) {
        settings.maxTabs++;
        await saveSettings();
        updateUI();
      }
    });
  }

  // Disable button (header)
  if (elements.disableBtn) {
    elements.disableBtn.addEventListener("click", async () => {
      if (settings.enabled) {
        showFrictionModal("disable");
      } else {
        settings.enabled = true;
        await saveSettings();
        updateUI();
      }
    });
  }

  // Enable button (CTA in inactive state)
  if (elements.enableBtn) {
    elements.enableBtn.addEventListener("click", async () => {
      settings.enabled = true;
      await saveSettings();
      updateUI();
    });
  }

  // Global limit toggle (friction to DISABLE)
  if (elements.globalLimitToggle) {
    elements.globalLimitToggle.addEventListener("change", async (e) => {
      if (!e.target.checked) {
        // Trying to disable - requires friction
        e.target.checked = true; // Revert toggle
        showFrictionModal("disableGlobal");
      } else {
        // Enabling - no friction needed
        settings.globalLimit = true;
        await saveSettings();
        updateUI();
        await updateTabCount();
      }
    });
  }

  // Allowlist toggle
  if (elements.allowlistToggle) {
    elements.allowlistToggle.addEventListener("change", async (e) => {
      if (e.target.checked) {
        e.target.checked = false;
        showFrictionModal("allowlist");
      } else {
        settings.allowlistEnabled = false;
        await saveSettings();
        updateUI();
      }
    });
  }

  // Add domain
  if (elements.addDomainBtn)
    elements.addDomainBtn.addEventListener("click", addDomain);
  if (elements.allowlistInput) {
    elements.allowlistInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addDomain();
    });
  }

  // Remove domain
  if (elements.domainsList) {
    elements.domainsList.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON") {
        removeDomain(parseInt(e.target.dataset.index));
      }
    });
  }

  // Modal
  if (elements.modalCancel)
    elements.modalCancel.addEventListener("click", hideFrictionModal);
  if (elements.modalConfirm)
    elements.modalConfirm.addEventListener("click", confirmFrictionAction);
  if (elements.phraseInput) {
    elements.phraseInput.addEventListener("input", validatePhrase);
    elements.phraseInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmFrictionAction();
      if (e.key === "Escape") hideFrictionModal();
    });
    // Prevent copy and paste to ensure user types the phrase manually
    elements.phraseInput.addEventListener("paste", (e) => e.preventDefault());
    elements.phraseInput.addEventListener("copy", (e) => e.preventDefault());
  }
  if (elements.frictionModal) {
    elements.frictionModal.addEventListener("click", (e) => {
      if (e.target === elements.frictionModal) hideFrictionModal();
    });
  }
}

// Initialize
document.addEventListener("DOMContentLoaded", async () => {
  initElements();
  await loadSettings();
  await loadStats();
  updateUI();
  await updateTabCount();
  setupEventListeners();
  setInterval(updateTabCount, 1000);
});
