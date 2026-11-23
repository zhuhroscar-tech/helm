import AppKit

// 同一时间只开一个 Helm：已经在运行就把那个调到前台
if let me = Bundle.main.bundleIdentifier,
   let other = NSRunningApplication.runningApplications(withBundleIdentifier: me).first(where: { $0 != NSRunningApplication.current }) {
    other.activate()
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.run()
