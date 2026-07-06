#!/bin/bash
# ================================================================
# Titan Compress 前端自动化部署脚本 (Elite Edition with Cross-Origin Isolation)
# ================================================================

# --- 项目配置 ---
APP_NAME="compress"                 # 项目名称
URL_PREFIX="/compress/"             # 线上访问的子路径后缀
BUILD_OUTPUT_DIR="dist"            # 本地打包产物目录

# --- 远程服务器配置 ---
DEPLOY_HOST_ALIAS="racknerd"        # SSH 别名
DEPLOY_ROOT="/var/www/frontend"     # 服务器前端根目录
DEPLOY_DIR="$DEPLOY_ROOT/$APP_NAME" # 最终存放代码的目录
RELEASES_DIR="$DEPLOY_DIR/releases"
KEEP_RELEASES=2

# --- 本地变量 ---
TIMESTAMP=$(date +"%Y%m%d%H%M%S")
PACKAGE_FILE="$APP_NAME-$TIMESTAMP.tar.gz"
LOCAL_LOG_FILE="./deploy_frontend_$TIMESTAMP.log"

export COPYFILE_DISABLE=1 # 防止 Mac 下产生 ._ 文件

check_status() {
    if [ $1 -ne 0 ]; then
        echo "[$(date)] ❌ 错误: $2" | tee -a "$LOCAL_LOG_FILE"
        exit 1
    fi
}

# ------------------------------
# 1. 本地构建
# ------------------------------
local_build() {
    echo "--> [1/4] 开始前端构建 (pnpm build)..." | tee -a "$LOCAL_LOG_FILE"
    if [ ! -d "node_modules" ]; then
        echo "--> 安装依赖..."
        pnpm install
    fi
    pnpm run build
    check_status $? "前端构建产物失败，请检查编译日志。"
}

# ------------------------------
# 2. 打包产物
# ------------------------------
build_package() {
    echo "--> [2/4] 正在打包打包产物目录... ($BUILD_OUTPUT_DIR)" | tee -a "$LOCAL_LOG_FILE"
    if [ ! -d "$BUILD_OUTPUT_DIR" ]; then
        echo "❌ 打包目录 $BUILD_OUTPUT_DIR 不存在!"
        exit 1
    fi
    tar -czf "$PACKAGE_FILE" -C "$BUILD_OUTPUT_DIR" .
    check_status $? "压缩打包失败"
}

# ------------------------------
# 3. 上传到服务器
# ------------------------------
upload_package() {
    echo "--> [3/4] 正在上传至服务器 ($DEPLOY_HOST_ALIAS)..." | tee -a "$LOCAL_LOG_FILE"
    ssh "$DEPLOY_HOST_ALIAS" "mkdir -p $DEPLOY_DIR/releases"
    scp "$PACKAGE_FILE" "$DEPLOY_HOST_ALIAS:$DEPLOY_DIR/"
    check_status $? "上传失败，请检查网络或免密登录配置。"
    rm -f "$PACKAGE_FILE"
}

# ------------------------------
# 4. 远程部署与 Nginx
# ------------------------------
remote_deploy() {
    echo "--> [4/4] 正在执行服务器部署逻辑并自动同步网关..." | tee -a "$LOCAL_LOG_FILE"
    SKIP_COUNT=$((KEEP_RELEASES + 1))
    ssh "$DEPLOY_HOST_ALIAS" bash -s << EOF
        set -e
        APP_NAME="$APP_NAME"
        URL_PREFIX="$URL_PREFIX"
        DEPLOY_DIR="$DEPLOY_DIR"
        RELEASES_DIR="$RELEASES_DIR"
        SKIP_COUNT="$SKIP_COUNT"
        NEW_RELEASE="\$RELEASES_DIR/$TIMESTAMP"
        PACKAGE_FILE="\$DEPLOY_DIR/$PACKAGE_FILE"

        echo "--> [远程] 正在解压新版本..."
        mkdir -p "\$NEW_RELEASE"
        tar -xzf "\$PACKAGE_FILE" -C "\$NEW_RELEASE"
        rm -f "\$PACKAGE_FILE"

        echo "--> [远程] 切换静态资源软链..."
        ln -sfn "\$NEW_RELEASE" "\$DEPLOY_DIR/current"

        echo "--> [远程] 清理旧版本 (保留最近 $KEEP_RELEASES 个)..."
        ls -dt "\$RELEASES_DIR"/* | tail -n +\$SKIP_COUNT | xargs rm -rf

        # --- 自动同步 Nginx 前端网关路由，特别注入跨域隔离头 ---
        echo "--> [远程] 正在动态生成 Nginx 前端路由卡片..."
        sudo tee /etc/nginx/ghost-rider.d/\$APP_NAME.route > /dev/null << ROUTE_EOF
# \$APP_NAME 前端自动部署路由
location \$URL_PREFIX {
    alias \$DEPLOY_DIR/current/;
    index index.html;

    # 关键：开启跨域隔离以支持 SharedArrayBuffer (FFmpeg.wasm 依赖)
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    # 静态资源缓存策略
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)\\\$ {
        expires 60d;
        add_header Cache-Control "public, immutable";
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
        access_log off;
    }

    # HTML 文件强制不缓存，确保版本即时更新
    location ~* \.html\\\$ {
        expires -1;
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate";
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }

    try_files \\\$uri \\\$uri/ \${URL_PREFIX}index.html;
    access_log /var/log/nginx/\${APP_NAME}_access.log;
    error_log /var/log/nginx/\${APP_NAME}_error.log;
}
ROUTE_EOF

        echo "--> [远程] 🔄 热重载 Nginx..."
        sudo systemctl reload nginx
        echo "--> [远程] ✅ 前端部署与网关同步完成！"
EOF
    check_status $? "部署失败"

    echo "============================================"
    echo "🎉 全部流程结束！前端 $APP_NAME 已上线！" | tee -a "$LOCAL_LOG_FILE"
    echo "============================================"
    echo "🔗 外网访问地址: https://ghost-rider.cn$URL_PREFIX"
    echo "============================================"
}

# ------------------------------
# 5. 手动回滚前端资源 (一键秒切软链)
# ------------------------------
manual_rollback() {
    echo "============================================"
    echo "  正在获取前端历史可用版本列表 (保留最近 $KEEP_RELEASES 个)..."
    echo "============================================"
    
    ssh "$DEPLOY_HOST_ALIAS" "ls -t $RELEASES_DIR"
    
    echo "============================================"
    read -p "请输入要回滚的版本号 (例如 20251226xxxxxx): " TARGET_VERSION
    
    if [ -z "$TARGET_VERSION" ]; then
        echo "❌ 未输入版本号，操作取消"
        exit 1
    fi

    echo "正在回滚前端到版本 $TARGET_VERSION ..." | tee -a "$LOCAL_LOG_FILE"

    ssh "$DEPLOY_HOST_ALIAS" bash -s << EOF
        set -e
        DEPLOY_DIR="$DEPLOY_DIR"
        RELEASES_DIR="$RELEASES_DIR"
        TARGET="$TARGET_VERSION"
        
        if [ -d "\$RELEASES_DIR/\$TARGET" ]; then
            echo "--> 切换静态资源软链指向旧版本..."
            ln -sfn "\$RELEASES_DIR/\$TARGET" "\$DEPLOY_DIR/current"
            echo "✅ 回滚成功！前端当前工作版本已秒切为: \$TARGET"
        else
            echo "❌ 错误: 前端版本 \$TARGET 不存在！"
            exit 1
        fi
EOF
}

# ------------------------------
# 主菜单
# ------------------------------
main_menu() {
    echo "============================================"
    echo "  🚀 Titan Compress 前端自动部署脚本 (Target: $DEPLOY_HOST_ALIAS)"
    echo "============================================"
    echo "1) 部署前端新版本 (Deploy)"
    echo "2) 一键手动回滚到旧版本 (Rollback)"
    echo "3) 退出 (Exit)"
    read -p "请选择操作 [1/2/3]: " choice

    case $choice in
        1)
            local_build
            build_package
            upload_package
            remote_deploy
            ;;
        2)
            manual_rollback
            ;;
        *)
            exit 0
            ;;
    esac
}

if [ "$1" = "deploy" ]; then
    local_build
    build_package
    upload_package
    remote_deploy
elif [ "$1" = "rollback" ]; then
    manual_rollback
else
    main_menu
fi
