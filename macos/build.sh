#!/bin/bash
# 构建 Helm.app（原生 macOS 外壳）。只需要 Xcode 命令行工具：xcode-select --install
#
#   macos/build.sh             → macos/dist/Helm.app
#   macos/build.sh --install   → 另外装到 /Applications（不可写时装到 ~/Applications）
#
# App 本身只有几 MB：它启动的是这个仓库里的 server.mjs，项目、数据、LEAN 都还在仓库里。
# 构建时把仓库路径写进 Info.plist（HelmRoot）；仓库搬家后在 App 菜单「选择 Helm 文件夹…」里重新指一次。
# 签名：本机临时签名（ad-hoc），自己用足够。要发给别人需要 Developer ID 签名 + 公证（见 docs/MACOS-APP.md）。
# Builds Helm.app (native macOS shell) from source; ad-hoc signed for this Mac. Messages follow LANG (zh* = Chinese).
set -euo pipefail

case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in zh*) HELM_ZH=1 ;; *) HELM_ZH=0 ;; esac
m() { if [ "$HELM_ZH" -eq 1 ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIST="$HERE/dist"
APP="$DIST/Helm.app"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 1.0.0)"
BUILD="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
BUNDLE_ID="${HELM_BUNDLE_ID:-local.helm.console}"
SIGN_ID="${HELM_SIGN_ID:--}"   # "-" = ad-hoc；有 Developer ID 时设成证书名

command -v swift >/dev/null || { echo "$(m 'Swift is required: run xcode-select --install' '需要 Swift：运行 xcode-select --install')"; exit 1; }

echo "==> $(m 'Compiling (release)' '编译（release）')"
swift build -c release --package-path "$HERE"
BIN="$(swift build -c release --package-path "$HERE" --show-bin-path)/Helm"

echo "==> $(m 'Assembling' '组装') $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Helm"

echo "==> $(m 'Icon' '图标')"
ICON_TMP="$(mktemp -d)"
trap 'rm -rf "$ICON_TMP"' EXIT
swift "$HERE/make-icon.swift" "$ICON_TMP/icon.png"
SET="$ICON_TMP/AppIcon.iconset"; mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON_TMP/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ICON_TMP/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"

# HelmRoot 里可能有 & < > 之类：按 XML 转义
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Helm</string>
  <key>CFBundleDisplayName</key><string>Helm</string>
  <key>CFBundleIdentifier</key><string>$(xml "$BUNDLE_ID")</string>
  <key>CFBundleExecutable</key><string>Helm</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(xml "$VERSION")</string>
  <key>CFBundleVersion</key><string>$(xml "$BUILD")</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>zh-Hans</string></array>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.finance</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT License</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>HelmRoot</key><string>$(xml "$ROOT")</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "==> $(m 'Signing' '签名') ($([ "$SIGN_ID" = "-" ] && m 'ad-hoc, this Mac only' '本机 ad-hoc' || echo "$SIGN_ID"))"
if [ "$SIGN_ID" = "-" ]; then
  codesign --force --sign - "$APP"
else
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP"
fi
codesign --verify --strict "$APP"

echo "==> $(m 'Done:' '完成：') $APP ($(du -sh "$APP" | cut -f1))"

if [ "${1:-}" = "--install" ]; then
  DEST="/Applications"
  [ -w "$DEST" ] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  # 正在运行的旧版先退出（它会顺便关掉自己启动的服务）
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  rm -rf "$DEST/Helm.app"
  cp -R "$APP" "$DEST/Helm.app"
  echo "==> $(m 'Installed to' '已安装到') $DEST/Helm.app"
fi
