#!/usr/bin/env bash
set -e

BINARY_SRC="$(cd "$(dirname "$0")" && pwd)/target/release/titan-host"
INSTALL_DIR="$HOME/.local/bin/titan-host"
MANIFEST_DIR_CHROME="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_DIR_CHROMIUM="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
MANIFEST_NAME="com.titan.video.host.json"

echo "=== Titan Native Host — Mac 安装脚本 ==="

# 1. 检查 FFmpeg
if ! command -v ffmpeg &>/dev/null; then
  echo "❌ 未找到 FFmpeg，请先安装："
  echo "   brew install ffmpeg"
  exit 1
fi
echo "✅ FFmpeg: $(ffmpeg -version 2>&1 | head -1)"

# 2. 检查二进制
if [ ! -f "$BINARY_SRC" ]; then
  echo "❌ 未找到 titan-host 二进制，请先编译："
  echo "   cargo build --release"
  exit 1
fi

# 3. 安装二进制
mkdir -p "$INSTALL_DIR"
cp "$BINARY_SRC" "$INSTALL_DIR/titan-host"
chmod +x "$INSTALL_DIR/titan-host"
echo "✅ 二进制已安装到: $INSTALL_DIR/titan-host"

# 4. 生成 Manifest（Extension ID 暂为占位符）
MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "com.titan.video.host",
  "description": "Titan Native Host — GPU Video Compression",
  "path": "$INSTALL_DIR/titan-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://PLACEHOLDER_EXTENSION_ID/"
  ]
}
EOF
)

write_manifest() {
  local dir="$1"
  mkdir -p "$dir"
  echo "$MANIFEST_CONTENT" > "$dir/$MANIFEST_NAME"
  echo "✅ Manifest 已写入: $dir/$MANIFEST_NAME"
}

write_manifest "$MANIFEST_DIR_CHROME"
# 同时写入 Chromium（如果用户使用 Chromium）
if [ -d "$HOME/Library/Application Support/Chromium" ]; then
  write_manifest "$MANIFEST_DIR_CHROMIUM"
fi

echo ""
echo "=== 下一步 ==="
echo "1. 打开 chrome://extensions，启用开发者模式"
echo "2. 加载已解压的扩展 → 选择 Z/native-bridge/ 目录"
echo "3. 复制显示的 Extension ID"
echo "4. 运行以下命令替换占位符（替换 YOUR_EXTENSION_ID）："
echo ""
echo "   sed -i '' 's/PLACEHOLDER_EXTENSION_ID/YOUR_EXTENSION_ID/' \\"
echo "     \"$MANIFEST_DIR_CHROME/$MANIFEST_NAME\""
echo ""
echo "5. 在 chrome://extensions 中重新加载 Titan 扩展"
echo "6. 点击扩展图标，顶部应显示 GPU 引擎就绪"
