// 生成 Helm 的 App 图标（1024×1024 PNG）：暖棕色圆角方块上一个白色舵轮。
// 用法：swift make-icon.swift out.png（build.sh 会调用，再用 sips + iconutil 做成 .icns）
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext

// macOS 图标网格：内容 824×824，居中，圆角约 185
let inset: CGFloat = 100
let tile = CGRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 28, color: NSColor.black.withAlphaComponent(0.28).cgColor)
ctx.addPath(tilePath); ctx.setFillColor(NSColor.black.cgColor); ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(tilePath); ctx.clip()
let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                      colors: [NSColor(srgbRed: 0.62, green: 0.45, blue: 0.24, alpha: 1).cgColor,
                               NSColor(srgbRed: 0.34, green: 0.23, blue: 0.11, alpha: 1).cgColor] as CFArray,
                      locations: [0, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: size / 2, y: tile.maxY), end: CGPoint(x: size / 2, y: tile.minY), options: [])
ctx.restoreGState()

// 舵轮：外圈 + 内毂 + 8 根辐条（伸出外圈成把手）
let c = CGPoint(x: size / 2, y: size / 2)
let cream = NSColor(srgbRed: 0.98, green: 0.95, blue: 0.89, alpha: 1).cgColor
ctx.setStrokeColor(cream); ctx.setFillColor(cream); ctx.setLineCap(.round)
let rimR: CGFloat = 230
ctx.setLineWidth(46)
ctx.addEllipse(in: CGRect(x: c.x - rimR, y: c.y - rimR, width: 2 * rimR, height: 2 * rimR)); ctx.strokePath()
for i in 0..<8 {
    let a = CGFloat(i) * .pi / 4 + .pi / 8
    let inner: CGFloat = 60, outer: CGFloat = 330
    ctx.setLineWidth(34)
    ctx.move(to: CGPoint(x: c.x + inner * cos(a), y: c.y + inner * sin(a)))
    ctx.addLine(to: CGPoint(x: c.x + (rimR + 20) * cos(a), y: c.y + (rimR + 20) * sin(a)))
    ctx.strokePath()
    ctx.setLineWidth(52) // 把手更粗
    ctx.move(to: CGPoint(x: c.x + (rimR + 40) * cos(a), y: c.y + (rimR + 40) * sin(a)))
    ctx.addLine(to: CGPoint(x: c.x + outer * cos(a), y: c.y + outer * sin(a)))
    ctx.strokePath()
}
let hubR: CGFloat = 78
ctx.fillEllipse(in: CGRect(x: c.x - hubR, y: c.y - hubR, width: 2 * hubR, height: 2 * hubR))
ctx.setFillColor(NSColor(srgbRed: 0.45, green: 0.31, blue: 0.16, alpha: 1).cgColor)
ctx.fillEllipse(in: CGRect(x: c.x - 30, y: c.y - 30, width: 60, height: 60))

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
