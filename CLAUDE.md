# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TabCap** is a Safari browser extension for macOS that limits the number of open tabs to promote focus and productivity. It consists of two components:

1. **Native macOS App** (`TabCap/TabCap/`) - Swift/Cocoa companion app that serves as the installer and settings launcher
2. **Safari Web Extension** (`TabCap Extension/`) - JavaScript extension implementing the core tab-limiting functionality

## Build Commands

This is an Xcode-based project with no external package managers.

```bash
# Build from command line
xcodebuild -project TabCap/TabCap.xcodeproj -scheme TabCap -configuration Debug build

# Build for release
xcodebuild -project TabCap/TabCap.xcodeproj -scheme TabCap -configuration Release build

# Clean build
xcodebuild -project TabCap/TabCap.xcodeproj -scheme TabCap clean
```

Or open `TabCap/TabCap.xcodeproj` in Xcode and use ⌘B to build.

**Deployment Target:** macOS 11.0

## Architecture

### Native App (Swift)
- `TabCap/TabCap/AppDelegate.swift` - App lifecycle management
- `TabCap/TabCap/ViewController.swift` - Main UI controller, handles extension state checking via SafariServices framework

### Safari Extension (JavaScript)
- `TabCap Extension/manifest.json` - Extension manifest (v3)
- `TabCap Extension/background.js` - Service worker containing all tab limiting logic, allowlist management, and storage operations
- `TabCap Extension/popup.js` - Popup UI logic for settings (tab limit, per-window toggle, allowlist, friction phrases)
- `TabCap Extension/popup.html` / `popup.css` - Extension popup interface

### Data Flow
1. User configures settings via popup UI → stored in `browser.storage.local`
2. Background service worker listens to `browser.tabs.onCreated` and `browser.tabs.onUpdated`
3. When tab limit exceeded, newest tab is closed (unless domain is allowlisted)
4. Stats (streaks, blocked counts) tracked locally

### Key Storage Keys (browser.storage.local)
- `tabLimit` - Max number of tabs (default: 3, max: 99)
- `isPerWindow` - Boolean for per-window vs global limit
- `allowlist` - Array of allowlisted domain strings
- `frictionPhrase` - Custom phrase user must type to open new tab when limit reached

## Bundle Identifiers
- App: `com.thales.tabcap`
- Extension: `com.thales.tabcap.Extension`

## Commit Convention

Uses conventional commits: `type(scope): description`

Types: `feat`, `fix`, `chore`, `refactor`, `docs`
