import AppKit
import ServiceManagement
import UserNotifications
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, UNUserNotificationCenterDelegate {
    private var server: ServerManager?
    private var win: WebWindowController!
    private let events = EventMonitor()
    private var activity: NSObjectProtocol?
    private var quitting = false

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.mainMenu = buildMenu()
        win = WebWindowController()
        win.onAppAction = { [weak self] action in self?.appAction(action) }
        win.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)

        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        // App 在后台时系统会降频（App Nap），事件推送和通知会延迟；服务在跑的时候关掉它（不阻止 Mac 正常睡眠）
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Helm server and agents")

        guard let root = Paths.helmRoot() else {
            win.showError(title: L("找不到 Helm 文件夹", "Helm folder not found"),
                          detail: L("请选择包含 server.mjs 的 Helm 文件夹。", "Choose the Helm folder that contains server.mjs."), canChooseFolder: true)
            return
        }
        startServer(root: root)
    }

    private func startServer(root: URL) {
        let s = ServerManager(root: root)
        server = s
        s.onChange = { [weak self] st in self?.serverChanged(st) }
        Task { await s.start() }
    }

    private func serverChanged(_ st: ServerManager.State) {
        guard !quitting else { return }
        switch st {
        case .idle: break
        case let .starting(msg): win.showStatus(msg)
        case let .running(port, _):
            win.load(port: port)
            events.connect(port: port)
        case let .failed(title, detail):
            events.disconnect()
            win.showError(title: title, detail: detail)
            if !NSApp.isActive {
                let c = UNMutableNotificationContent(); c.title = title; c.body = L("打开 Helm 查看原因", "Open Helm to see why")
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "server-failed", content: c, trigger: nil))
            }
        }
    }

    private func appAction(_ action: String) {
        switch action {
        case "restart": restartServer(nil)
        case "log": showLog(nil)
        case "choose-root": chooseFolder(nil)
        default: break
        }
    }

    // MARK: 生命周期

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { win.showWindow(nil) }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let server, server.owned else { return .terminateNow }
        if !events.running.isEmpty {
            let a = NSAlert()
            a.messageText = L("还有 \(events.running.count) 个 agent 任务在运行", "\(events.running.count) agent task(s) still running")
            a.informativeText = L("退出 Helm 会中断它们。", "Quitting Helm will interrupt them.")
            a.addButton(withTitle: L("退出", "Quit"))
            a.addButton(withTitle: L("取消", "Cancel"))
            if a.runModal() != .alertFirstButtonReturn { return .terminateCancel }
        }
        quitting = true
        events.disconnect()
        Task {
            await server.stopAndWait()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ note: Notification) {
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
    }

    // 点通知 → 打开窗口
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        Task { @MainActor in
            self.win.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            done()
        }
    }

    // MARK: 菜单动作

    @objc func showMainWindow(_ sender: Any?) { win.showWindow(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func reloadPage(_ sender: Any?) { if let p = server?.port { win.load(port: p) } else { win.webView.reload() } }
    @objc func goBack(_ sender: Any?) { if win.webView.canGoBack { win.webView.goBack() } }
    @objc func goForward(_ sender: Any?) { if win.webView.canGoForward { win.webView.goForward() } }
    @objc func zoomIn(_ sender: Any?) { win.webView.pageZoom = min(win.webView.pageZoom + 0.1, 2.0) }
    @objc func zoomOut(_ sender: Any?) { win.webView.pageZoom = max(win.webView.pageZoom - 0.1, 0.6) }
    @objc func actualSize(_ sender: Any?) { win.webView.pageZoom = 1.0 }
    @objc func openInBrowser(_ sender: Any?) { if let u = server?.baseURL { NSWorkspace.shared.open(u) } }
    @objc func showLog(_ sender: Any?) {
        if FileManager.default.fileExists(atPath: Paths.serverLog.path) { NSWorkspace.shared.open(Paths.serverLog) } else { NSWorkspace.shared.open(Paths.logDir.deletingLastPathComponent()) }
    }
    @objc func openHelmFolder(_ sender: Any?) { if let r = server?.root ?? Paths.helmRoot() { NSWorkspace.shared.activateFileViewerSelecting([r.appendingPathComponent("server.mjs")]) } }

    @objc func restartServer(_ sender: Any?) {
        guard let server else { return chooseFolder(nil) }
        if case .running(_, false) = server.state {
            let a = NSAlert()
            a.messageText = L("Helm 服务是在别处启动的", "The Helm server was started elsewhere")
            a.informativeText = L("App 连的是已经在运行的服务（比如终端里的 npm start），请在那里重启它。", "The app is attached to a server that was already running (for example npm start in a terminal). Restart it there.")
            a.runModal()
            return
        }
        events.disconnect()
        Task { await server.restart() }
    }

    @objc func chooseFolder(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.message = L("选择包含 server.mjs 的 Helm 文件夹", "Choose the Helm folder that contains server.mjs")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard Paths.isHelmRoot(url) else {
            let a = NSAlert(); a.messageText = L("这个文件夹里没有 Helm（缺少 server.mjs）", "This folder doesn't contain Helm (server.mjs is missing)"); a.runModal()
            return
        }
        UserDefaults.standard.set(url.path, forKey: "HelmRoot")
        events.disconnect()
        Task {
            await server?.stopAndWait()
            startServer(root: url)
        }
    }

    @objc func toggleLoginItem(_ sender: Any?) {
        let svc = SMAppService.mainApp
        do {
            if svc.status == .enabled { try svc.unregister() } else { try svc.register() }
        } catch {
            let a = NSAlert()
            a.messageText = L("没能修改开机启动", "Couldn't change Open at Login")
            a.informativeText = error.localizedDescription + "\n\n" + L("可以在 系统设置 → 通用 → 登录项 里手动添加 Helm。", "You can add Helm manually in System Settings → General → Login Items.")
            a.runModal()
        }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(toggleLoginItem(_:)):
            item.state = SMAppService.mainApp.status == .enabled ? .on : .off
            return true
        case #selector(openInBrowser(_:)): return server?.port != nil
        case #selector(goBack(_:)): return win.webView.canGoBack
        case #selector(goForward(_:)): return win.webView.canGoForward
        default: return true
        }
    }

    // MARK: 菜单

    private func buildMenu() -> NSMenu {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let top = NSMenuItem(); let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            top.submenu = m; main.addItem(top)
            return m
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            if let target { i.target = target } else if let action, responds(to: action) { i.target = self }
            return i
        }

        _ = add("Helm", [
            item(L("关于 Helm", "About Helm"), #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp),
            .separator(),
            item(L("开机时启动", "Open at Login"), #selector(toggleLoginItem(_:))),
            item(L("选择 Helm 文件夹…", "Choose Helm Folder…"), #selector(chooseFolder(_:))),
            .separator(),
            item(L("隐藏 Helm", "Hide Helm"), #selector(NSApplication.hide(_:)), "h", target: NSApp),
            item(L("隐藏其他", "Hide Others"), #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], target: NSApp),
            item(L("全部显示", "Show All"), #selector(NSApplication.unhideAllApplications(_:)), target: NSApp),
            .separator(),
            item(L("退出 Helm", "Quit Helm"), #selector(NSApplication.terminate(_:)), "q", target: NSApp),
        ])
        _ = add(L("文件", "File"), [
            item(L("在浏览器中打开", "Open in Browser"), #selector(openInBrowser(_:)), "o", [.command, .shift]),
            item(L("在访达中显示 Helm 文件夹", "Show Helm Folder in Finder"), #selector(openHelmFolder(_:))),
            .separator(),
            item(L("关闭窗口", "Close Window"), #selector(NSWindow.performClose(_:)), "w"),
        ])
        // 没有「编辑」菜单的话，网页里的 ⌘C / ⌘V / ⌘A 都不起作用
        _ = add(L("编辑", "Edit"), [
            item(L("撤销", "Undo"), Selector(("undo:")), "z"),
            item(L("重做", "Redo"), Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item(L("剪切", "Cut"), #selector(NSText.cut(_:)), "x"),
            item(L("拷贝", "Copy"), #selector(NSText.copy(_:)), "c"),
            item(L("粘贴", "Paste"), #selector(NSText.paste(_:)), "v"),
            item(L("全选", "Select All"), #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = add(L("显示", "View"), [
            item(L("后退", "Back"), #selector(goBack(_:)), "["),
            item(L("前进", "Forward"), #selector(goForward(_:)), "]"),
            .separator(),
            item(L("重新载入", "Reload"), #selector(reloadPage(_:)), "r"),
            .separator(),
            item(L("实际大小", "Actual Size"), #selector(actualSize(_:)), "0"),
            item(L("放大", "Zoom In"), #selector(zoomIn(_:)), "="),
            item(L("缩小", "Zoom Out"), #selector(zoomOut(_:)), "-"),
            .separator(),
            item(L("进入全屏幕", "Enter Full Screen"), #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        _ = add(L("服务", "Server"), [
            item(L("重启 Helm 服务", "Restart Helm Server"), #selector(restartServer(_:))),
            item(L("显示服务日志", "Show Server Log"), #selector(showLog(_:)), "l", [.command, .option]),
        ])
        let windowMenu = add(L("窗口", "Window"), [
            item(L("最小化", "Minimize"), #selector(NSWindow.performMiniaturize(_:)), "m"),
            item(L("缩放", "Zoom"), #selector(NSWindow.performZoom(_:))),
            .separator(),
            item(L("Helm 主窗口", "Helm Main Window"), #selector(showMainWindow(_:)), "1"),
            item(L("前置全部窗口", "Bring All to Front"), #selector(NSApplication.arrangeInFront(_:)), target: NSApp),
        ])
        NSApp.windowsMenu = windowMenu
        return main
    }
}
