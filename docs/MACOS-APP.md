# Helm as a macOS app

`macos/` holds a small native shell (Swift + the system WebKit, about 1 MB). It starts the Node server from this repository and shows the same web UI in a real Mac window. Projects, data and LEAN stay in the repository; secrets live in `~/Library/Application Support/Helm/secrets` (new installs) and the app's server log in `~/Library/Logs/Helm`.

There is no prebuilt app to download. You build it on your own Mac from this repository, after `scripts/setup.sh` has installed the engine, and it is ad-hoc signed for that Mac only.

## Build and install

Needs only the Xcode command-line tools (`xcode-select --install`), not full Xcode.

```
macos/build.sh            # builds macos/dist/Helm.app
macos/build.sh --install  # also copies it to /Applications (or ~/Applications)
```

The repository path is written into the app at build time. If you move the repository, use **Helm → Choose Helm Folder…**.

## What the app does

- **Starts the server for you.** It reads your login shell's environment first, so `node`, `claude`, `dotnet` and `uv` are found the same way as in Terminal. Server output goes to `~/Library/Logs/Helm/server.log` (**Server → Show Server Log**).
- **Reuses a running server.** If `npm start` is already running on port 4377, the app connects to it and leaves it running when you quit.
- **Keeps running when the window is closed**, so agent tasks and the daily paper-trading update continue. Click the Dock icon to bring the window back. **Quit** stops the server it started, and asks first if agents are still running.
- **Notifications and Dock badge.** You get a notification when an agent needs approval or has a question, and when a task finishes while Helm is in the background. The Dock badge counts approvals and questions still waiting.
- **A full menu bar with shortcuts.** Helm · File · Edit · View · Project · Server · Window · Help. ⌘1–⌘5 switch pages, ⌘N new project, ⇧⌘N new idea, ⌘F find a project, ⌘J / ⌘K agent chat, ⌘R run a backtest, ⌘B compile check, ⌘, settings, ⇧⌘R reload the page. Project commands are greyed out outside a project. **Help → Keyboard Shortcuts** (⌘/) lists them all.
- **Mac behaviour.** Copy and paste work, plus ⌘+/⌘− zoom. External links open in your browser and downloads ask where to save. **Open at Login** is in the Helm menu, and **File → Open in Browser** opens the same page in Safari or Chrome.
- **Shows errors in the window.** If Node is missing or the server crashes, the window explains what happened, shows the last log lines and offers **Try again**.

## Signing

`build.sh` signs the app ad-hoc, which is enough on the Mac that built it. To give the app to other people, you need an Apple Developer account (99 USD a year), a Developer ID certificate and notarization:

```
HELM_SIGN_ID="Developer ID Application: Your Name (TEAMID)" HELM_BUNDLE_ID=com.yourdomain.helm macos/build.sh
ditto -c -k --keepParent macos/dist/Helm.app Helm.zip
xcrun notarytool submit Helm.zip --apple-id … --team-id … --wait
xcrun stapler staple macos/dist/Helm.app
```

`notarytool` and `stapler` need full Xcode. The other machine also needs the repository, Node and the rest of Helm's dependencies (`scripts/setup.sh`). The app is a shell around the repository, not a self-contained bundle.
