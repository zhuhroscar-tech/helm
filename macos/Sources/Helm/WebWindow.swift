import AppKit
import WebKit

/// 主窗口：一个 WKWebView。负责
///  - 本机页面在窗口里打开，外部链接交给默认浏览器
///  - 下载（导出代码等）弹出保存对话框
///  - alert / confirm / prompt、文件选择框用原生面板
///  - 启动中 / 出错时显示本地的状态页，状态页上的按钮用 helm-app:// 链接回到 App
final class WebWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let webView: WKWebView
    var onAppAction: ((String) -> Void)?
    private var allowedPort: Int?
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]

    init() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // 网页的语言、主题等偏好存在这里，重开 App 还在
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.allowsBackForwardNavigationGestures = true // 触控板双指左右滑动 = 后退 / 前进，和 Safari 一样
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true } // 右键「检查元素」方便排查网页问题
        webView.setValue(false, forKey: "drawsBackground") // 启动时不闪白屏，跟随窗口背景（深色模式下是深色）

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 880),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "Helm"
        window.minSize = NSSize(width: 720, height: 480)
        window.backgroundColor = .windowBackgroundColor
        window.contentView = webView
        window.tabbingMode = .disallowed
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("HelmMainWindow")
        super.init(window: window)
        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: 内容

    func load(port: Int) {
        allowedPort = port
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
    }

    func showStatus(_ message: String) {
        allowedPort = nil
        webView.loadHTMLString(Self.page(body: "<div class=spin></div><p>\(Self.esc(message))</p>"), baseURL: nil)
    }

    func showError(title: String, detail: String, canChooseFolder: Bool = false) {
        allowedPort = nil
        let buttons = [
            "<a class=btn href='helm-app://restart'>\(L("重试", "Try again"))</a>",
            "<a class=btn href='helm-app://log'>\(L("打开日志", "Open log"))</a>",
            canChooseFolder ? "<a class=btn href='helm-app://choose-root'>\(L("选择 Helm 文件夹…", "Choose Helm folder…"))</a>" : "",
        ].joined()
        webView.loadHTMLString(Self.page(body: "<h1>\(Self.esc(title))</h1><pre>\(Self.esc(detail))</pre><div class=row>\(buttons)</div>"), baseURL: nil)
    }

    private static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }

    private static func page(body: String) -> String {
        """
        <!doctype html><meta charset=utf-8><meta name=color-scheme content="light dark">
        <style>
          :root { --bg:#f7f5f0; --fg:#2b2a27; --muted:#6f6b63; --line:#ddd8cc; --accent:#7a5a2b; }
          @media (prefers-color-scheme: dark) { :root { --bg:#1d1c1a; --fg:#ece9e2; --muted:#a29d93; --line:#3a3833; --accent:#c9a46a; } }
          html,body { height:100%; margin:0; background:var(--bg); color:var(--fg); font:14px -apple-system, "PingFang SC", sans-serif; }
          body { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px; box-sizing:border-box; text-align:center; }
          h1 { font-size:18px; font-weight:600; margin:0 0 12px; }
          p { color:var(--muted); margin:16px 0 0; }
          pre { text-align:left; white-space:pre-wrap; word-break:break-word; max-width:760px; max-height:50vh; overflow:auto; background:rgba(127,127,127,.08);
                border:1px solid var(--line); border-radius:8px; padding:12px; font:12px ui-monospace, Menlo, monospace; color:var(--muted); }
          .row { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; justify-content:center; }
          .btn { padding:7px 14px; border:1px solid var(--line); border-radius:7px; color:var(--fg); text-decoration:none; }
          .btn:first-child { background:var(--accent); border-color:var(--accent); color:#fff; }
          .spin { width:26px; height:26px; border:3px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:s 0.9s linear infinite; }
          @keyframes s { to { transform:rotate(360deg); } }
        </style>
        <body>\(body)</body>
        """
    }

    // MARK: 关窗 = 隐藏（服务继续跑，模拟实盘的每日更新和 agent 任务不中断）

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    // MARK: 导航

    private func isLocal(_ url: URL) -> Bool {
        guard let port = allowedPort, url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") else { return false }
        return url.port == port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "helm-app" { onAppAction?(url.host ?? ""); return decisionHandler(.cancel) }
        if action.shouldPerformDownload { return decisionHandler(.download) }
        // 双指滑动后退时，不退回到启动时的「正在启动…」状态页
        if action.navigationType == .backForward && allowedPort != nil && !isLocal(url) { return decisionHandler(.cancel) }
        if ["about", "blob", "data"].contains(url.scheme ?? "") || isLocal(url) { return decisionHandler(.allow) }
        // 外部链接（QuantConnect、资料来源等）用默认浏览器打开
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(!response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    /// 网页进程崩溃（内存压力等）：自动重新加载
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let port = allowedPort { load(port: port) }
    }

    // target=_blank：本机页面在当前窗口打开，外部链接交给浏览器
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isLocal(url) { webView.load(action.request) } else if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // MARK: 下载

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] r in
            guard r == .OK, let url = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url) // 用户已经在面板里确认过覆盖
            self?.downloadDestinations[ObjectIdentifier(download)] = url
            completionHandler(url)
        }
        if let w = window { panel.beginSheetModal(for: w, completionHandler: finish) } else { finish(panel.runModal()) }
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        NSAlert(error: error).runModal()
    }

    // MARK: 原生面板

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window!) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: L("取消", "Cancel"))
        a.beginSheetModal(for: window!) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24)); field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK"); a.addButton(withTitle: L("取消", "Cancel"))
        a.beginSheetModal(for: window!) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window!) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
}
