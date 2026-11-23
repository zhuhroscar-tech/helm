// swift-tools-version:5.9
// Helm 的 macOS 外壳：原生窗口 + 系统 WebKit，启动并托管仓库里的 Node 服务（server.mjs）。
// 构建：macos/build.sh（只需要 Xcode 命令行工具，不需要完整的 Xcode）
import PackageDescription

let package = Package(
    name: "Helm",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Helm",
            path: "Sources/Helm",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("ServiceManagement"),
            ]
        ),
    ]
)
