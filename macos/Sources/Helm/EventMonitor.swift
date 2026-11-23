import AppKit
import UserNotifications

/// 订阅服务的 /api/events（SSE）：
///  - 有待批准 / 待回答时，Dock 图标显示数字；App 不在前台时发系统通知
///  - 记录正在运行的 agent 数，退出 App 前提醒
final class EventMonitor: NSObject, URLSessionDataDelegate {
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var port: Int?
    private var retry = 1.0
    private(set) var running = Set<String>()
    private var pending = Set<String>() // 待批准 a… 和待回答 q… 的 id

    func connect(port: Int) {
        disconnect()
        self.port = port
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 60 * 60 * 24
        cfg.timeoutIntervalForResource = 60 * 60 * 24 * 365
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        task = session?.dataTask(with: URL(string: "http://127.0.0.1:\(port)/api/events")!)
        task?.resume()
        refreshPending(port: port)
    }

    func disconnect() {
        port = nil
        task?.cancel()
        session?.invalidateAndCancel()
        session = nil
        buffer.removeAll()
        running.removeAll()
        pending.removeAll()
        updateBadge()
    }

    /// 连上之前就在等的批准 / 问题（SSE 的 hello 只带正在运行的对话）
    private func refreshPending(port: Int) {
        for (path, key) in [("api/approvals", "approvals"), ("api/questions", "questions")] {
            URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/\(path)")!) { [weak self] data, _, _ in
                guard let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let items = j[key] as? [[String: Any]] else { return }
                let ids = items.filter { ($0["state"] as? String) == "pending" }.compactMap { $0["id"] as? String }
                DispatchQueue.main.async { self?.pending.formUnion(ids); self?.updateBadge() }
            }.resume()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        retry = 1
        buffer.append(data)
        let sep = Data("\n\n".utf8)
        while let r = buffer.range(of: sep) {
            let chunk = String(decoding: buffer[buffer.startIndex..<r.lowerBound], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex..<r.upperBound)
            for line in chunk.split(separator: "\n") where line.hasPrefix("data: ") {
                if let obj = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8)) as? [String: Any] { handle(obj) }
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard session === self.session, let port else { return }
        // 服务重启或断开：退避重连（最多 30 秒一次）
        DispatchQueue.main.asyncAfter(deadline: .now() + retry) { [weak self] in
            guard let self, self.port == port else { return }
            self.connect(port: port)
        }
        retry = min(retry * 2, 30)
    }

    private func handle(_ ev: [String: Any]) {
        switch ev["type"] as? String {
        case "hello":
            running = Set(((ev["running"] as? [[String: Any]]) ?? []).compactMap { $0["threadId"] as? String })
        case "run_start":
            if let id = ev["threadId"] as? String { running.insert(id) }
        case "run_end":
            if let id = ev["threadId"] as? String { running.remove(id) }
            let title = ev["title"] as? String ?? ""
            if let err = ev["error"] as? String, !err.isEmpty {
                notify(L("任务出错", "Task failed"), "\(title)\n\(err)")
            } else if (ev["stopped"] as? Bool) != true {
                notify(L("任务完成", "Task finished"), title)
            }
        case "approval_request":
            let a = ev["approval"] as? [String: Any] ?? [:]
            if let id = a["id"] as? String { pending.insert(id) }
            notify(L("需要你批准", "Approval needed"), [a["title"] as? String, a["threadTitle"] as? String].compactMap { $0 }.joined(separator: " · "), always: true)
        case "approval_settled", "question_settled":
            if let id = ev["id"] as? String { pending.remove(id) }
        case "question_request":
            let q = ev["question"] as? [String: Any] ?? [:]
            if let id = q["id"] as? String { pending.insert(id) }
            notify(L("agent 有问题要问你", "An agent has a question"), [q["threadTitle"] as? String, q["intro"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "), always: true)
        default: break
        }
        updateBadge()
    }

    private func updateBadge() {
        NSApp.dockTile.badgeLabel = pending.isEmpty ? nil : String(pending.count)
    }

    /// always：要用户处理的（批准 / 问题）即使 App 在前台但窗口被挡住也提醒；其余只在 App 不在前台时提醒
    private func notify(_ title: String, _ body: String, always: Bool = false) {
        let windowVisible = NSApp.windows.contains { $0.isVisible && $0.isKeyWindow }
        if NSApp.isActive && (windowVisible || !always) { return }
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = String(body.prefix(300))
        c.sound = always ? .default : nil
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }
}
