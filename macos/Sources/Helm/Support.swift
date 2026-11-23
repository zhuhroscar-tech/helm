import AppKit
import Foundation

/// 界面文字跟随系统语言：中文系统显示中文，其余显示英文（网页里的语言仍由网页自己的设置决定）。
let isChinese: Bool = (Locale.preferredLanguages.first ?? "").hasPrefix("zh")
func L(_ zh: String, _ en: String) -> String { isChinese ? zh : en }

enum Paths {
    static let logDir: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Helm", isDirectory: true)
    static let serverLog: URL = logDir.appendingPathComponent("server.log")

    /// 仓库位置：用户在 App 里选过的 > 构建时写进 Info.plist 的 HelmRoot。必须含 server.mjs。
    static func helmRoot() -> URL? {
        let candidates = [UserDefaults.standard.string(forKey: "HelmRoot"), Bundle.main.object(forInfoDictionaryKey: "HelmRoot") as? String]
        for case let p? in candidates where isHelmRoot(URL(fileURLWithPath: p)) { return URL(fileURLWithPath: p) }
        return nil
    }
    static func isHelmRoot(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathComponent("server.mjs").path)
            && FileManager.default.fileExists(atPath: url.appendingPathComponent("public/index.html").path)
    }
}

/// GUI 程序从 launchd 启动，拿不到终端里的 PATH（node、claude、dotnet、uv 都在那里）。
/// 跑一次用户的登录 shell，把它的环境变量取回来；失败时退回常见路径。
enum ShellEnv {
    static func load(timeout: TimeInterval = 10) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let shell = userShell()
        let begin = "__HELM_ENV_BEGIN__", end = "__HELM_ENV_END__"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        // -i 读 .zshrc（nvm、conda 之类通常写在那里），-l 读 .zprofile；env -0 用 NUL 分隔，值里有换行也不会错
        p.arguments = ["-ilc", "printf '\\n\(begin)\\n'; /usr/bin/env -0; printf '\(end)'"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        var data = Data()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            data = out.fileHandleForReading.readDataToEndOfFile()
            done.signal()
        }
        do {
            try p.run()
            if done.wait(timeout: .now() + timeout) == .timedOut { p.terminate() }
        } catch { /* 用下面的兜底 */ }
        let text = String(decoding: data, as: UTF8.self)
        if let r1 = text.range(of: "\n\(begin)\n"), let r2 = text.range(of: end, range: r1.upperBound..<text.endIndex) {
            for item in text[r1.upperBound..<r2.lowerBound].split(separator: "\0") {
                guard let eq = item.firstIndex(of: "=") else { continue }
                let k = String(item[..<eq])
                if ["SHLVL", "_", "PWD", "OLDPWD", "TERM_SESSION_ID"].contains(k) { continue }
                env[k] = String(item[item.index(after: eq)...])
            }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let fallback = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.dotnet", "\(home)/.npm-global/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var parts = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        for f in fallback where !parts.contains(f) { parts.append(f) }
        env["PATH"] = parts.joined(separator: ":")
        // 在 Claude Code 里打开终端再启动 App 时会带进来，server 自己也会清，这里先去掉
        for k in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"] { env.removeValue(forKey: k) }
        return env
    }

    static func userShell() -> String {
        if let pw = getpwuid(getuid()), let sh = pw.pointee.pw_shell {
            let s = String(cString: sh)
            if FileManager.default.isExecutableFile(atPath: s) { return s }
        }
        return "/bin/zsh"
    }

    static func which(_ name: String, in env: [String: String]) -> URL? {
        for dir in (env["PATH"] ?? "").split(separator: ":") {
            let p = "\(dir)/\(name)"
            if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }
}

enum Net {
    /// 端口是否空闲（绑一下 127.0.0.1:port）
    static func isPortFree(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        // 和 Node 的 listen 一样带 SO_REUSEADDR：刚关掉的服务留下的 TIME_WAIT 连接不算占用
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } == 0
    }

    /// 让系统挑一个空闲端口
    static func freePort() -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } == 0
        guard ok else { return nil }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        guard withUnsafeMutablePointer(to: &addr, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }) == 0 else { return nil }
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    /// 这个端口上是不是一个正在运行的 Helm（/api/agents 返回 200 的 JSON 数组）
    static func isHelm(port: Int) async -> Bool {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/agents")!)
        req.timeoutInterval = 1.5
        guard let (data, resp) = try? await URLSession.shared.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200 else { return false }
        return (try? JSONSerialization.jsonObject(with: data)) is [Any]
    }
}

/// 日志最后几行：只看最近一次启动（从最后一个 ===== 分隔行开始），不混进以前的运行
func tail(of url: URL, lines n: Int) -> String {
    guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
    let last = text.range(of: "\n===== ", options: .backwards).map { String(text[$0.upperBound...]) } ?? text
    let lines = last.split(separator: "\n", omittingEmptySubsequences: true).dropFirst() // 第一行是分隔行本身
    return lines.suffix(n).joined(separator: "\n")
}
