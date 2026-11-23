import Foundation

/// 启动、监控、停止 Node 服务（server.mjs）。
/// 4377 上已经有一个 Helm（比如终端里 npm start 起的）就直接连它，不重复启动，退出时也不关它。
@MainActor
final class ServerManager {
    enum State: Equatable {
        case idle
        case starting(String)
        case running(port: Int, owned: Bool)
        case failed(title: String, detail: String)
    }

    private(set) var state: State = .idle { didSet { onChange?(state) } }
    var onChange: ((State) -> Void)?
    let root: URL
    private var process: Process?
    private var stopping = false
    private var env: [String: String]?
    /// 每次 start / restart / shutdown 加一：还在等待中的旧 start() 醒来后发现代数变了就直接放弃（不会再起一个 node）
    private var generation = 0

    init(root: URL) { self.root = root }

    var port: Int? { if case let .running(p, _) = state { return p }; return nil }
    var owned: Bool { if case let .running(_, o) = state { return o }; return false }
    /// 自己起的 node 还活着（包括还在启动中、没进入 running 的时候）
    var hasProcess: Bool { process?.isRunning == true }
    var baseURL: URL? { port.map { URL(string: "http://127.0.0.1:\($0)/")! } }

    func start() async {
        if case .starting = state { return }
        generation += 1
        let gen = generation
        state = .starting(L("正在读取终端环境…", "Reading your shell environment…"))
        let preferred = UserDefaults.standard.integer(forKey: "HelmPort").nonZero ?? 4377
        if await Net.isHelm(port: preferred) { guard gen == generation else { return }; state = .running(port: preferred, owned: false); return }

        if env == nil { env = await Task.detached { ShellEnv.load() }.value }
        guard gen == generation else { return }
        guard let env, let node = ShellEnv.which("node", in: env) else {
            state = .failed(title: L("找不到 Node.js", "Node.js not found"),
                            detail: L("Helm 需要 Node 20 或更新版本。安装后（例如 brew install node）重新打开 Helm。", "Helm needs Node 20 or newer. Install it (for example brew install node), then reopen Helm."))
            return
        }
        // 4377 被别的程序占了就换一个空闲端口（网页的语言、主题偏好按端口存，所以尽量用固定端口）
        // 旧服务可能正在关闭（收到 SIGTERM 后会等进行中的请求）：先等它最多 5 秒
        var free = Net.isPortFree(preferred)
        for _ in 0..<20 where !free {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard gen == generation else { return }
            if await Net.isHelm(port: preferred) { state = .running(port: preferred, owned: false); return }
            free = Net.isPortFree(preferred)
        }
        guard gen == generation else { return }
        let port = free ? preferred : (Net.freePort() ?? preferred)
        state = .starting(L("正在启动 Helm 服务…", "Starting the Helm server…"))
        do { try launch(node: node, port: port, env: env) } catch {
            state = .failed(title: L("Helm 服务启动失败", "The Helm server failed to start"), detail: error.localizedDescription)
            return
        }
        // 等它能响应：最多 45 秒；中途进程退出就直接报错
        let deadline = Date().addingTimeInterval(45)
        while Date() < deadline {
            if process?.isRunning != true || gen != generation { return } // terminationHandler 已经把状态改成 failed / 已经被取消
            if await Net.isHelm(port: port) { state = .running(port: port, owned: true); return }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        stop()
        state = .failed(title: L("Helm 服务没有响应", "The Helm server did not respond"),
                        detail: L("45 秒内没有启动完成。日志的最后几行：", "It did not finish starting within 45 seconds. Last lines of the log:") + "\n\n" + tail(of: Paths.serverLog, lines: 25))
    }

    private func launch(node: URL, port: Int, env: [String: String]) throws {
        try FileManager.default.createDirectory(at: Paths.logDir, withIntermediateDirectories: true)
        rotateLog()
        if !FileManager.default.fileExists(atPath: Paths.serverLog.path) { FileManager.default.createFile(atPath: Paths.serverLog.path, contents: nil) }
        let log = try FileHandle(forWritingTo: Paths.serverLog)
        log.seekToEndOfFile()
        log.write("\n===== \(ISO8601DateFormatter().string(from: Date())) Helm.app starting server on port \(port) (\(node.path)) =====\n".data(using: .utf8)!)

        let p = Process()
        p.executableURL = node
        p.arguments = [root.appendingPathComponent("server.mjs").path]
        p.currentDirectoryURL = root
        var e = env
        e["PORT"] = String(port)
        e["HELM_APP"] = "1"
        p.environment = e
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus, bySignal = proc.terminationReason == .uncaughtSignal
            Task { @MainActor in self?.exited(code: code, bySignal: bySignal) }
        }
        stopping = false
        try p.run()
        process = p
    }

    private func exited(code: Int32, bySignal: Bool) {
        process = nil
        if stopping { stopping = false; state = .idle; return }
        let why = bySignal ? L("被信号 \(code) 终止（被别的程序或系统结束了）", "Killed by signal \(code) (ended by another program or the system)")
                           : L("退出码 \(code)", "Exit code \(code)")
        state = .failed(title: L("Helm 服务停止了", "The Helm server stopped"),
                        detail: why + L("。日志的最后几行：", ". Last lines of the log:") + "\n\n" + tail(of: Paths.serverLog, lines: 25))
    }

    /// 停掉自己启动的服务（SIGTERM，3 秒后还在就 SIGKILL）。连的是外部服务时什么都不做。
    func stop() {
        guard let p = process, p.isRunning else { return }
        stopping = true
        p.terminate()
        let pid = p.processIdentifier
        // 按 Process 判断还在不在（不是按 pid）：进程已经结束的话 pid 可能被别的程序复用了
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { if p.isRunning { kill(pid, SIGKILL) } }
    }

    /// 退出 App 时用：等进程真的结束（最多 4 秒）
    func stopAndWait() async {
        guard let p = process, p.isRunning else { return }
        stop()
        let deadline = Date().addingTimeInterval(4)
        while p.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
    }

    func restart() async {
        generation += 1
        await stopAndWait()
        state = .idle
        await start()
    }

    /// 不再用这个管理器（换了 Helm 文件夹）：取消还在等待的启动，不再通知界面
    func shutdown() {
        generation += 1
        onChange = nil
    }

    private func rotateLog() {
        let fm = FileManager.default
        guard let size = (try? fm.attributesOfItem(atPath: Paths.serverLog.path))?[.size] as? Int, size > 5_000_000 else { return }
        let old = Paths.logDir.appendingPathComponent("server.log.1")
        try? fm.removeItem(at: old)
        try? fm.moveItem(at: Paths.serverLog, to: old)
    }
}

private extension Int { var nonZero: Int? { self == 0 ? nil : self } }
