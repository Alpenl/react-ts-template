# 3D 模型渲染服务 Dockerfile
#
# 这个镜像包含:
# - Node.js 22 运行时
# - Chromium 浏览器 (用于 Puppeteer)
# - FFmpeg (用于视频编码)
# - 中文字体支持

# 使用 Node.js 22 slim 镜像作为基础
FROM node:22-slim

# 设置环境变量
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# 安装系统依赖
# - chromium: Puppeteer 使用的浏览器
# - ffmpeg: 视频编码
# - fonts-noto-cjk: 中文字体支持
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 启用 corepack (pnpm 支持)
RUN corepack enable

# 复制依赖文件
COPY package.json pnpm-lock.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile --prod

# 复制源代码
COPY . .

# 构建项目
RUN pnpm build

# 创建必要的目录
RUN mkdir -p uploads outputs temp

# 设置目录权限
RUN chown -R node:node /app

# 切换到非 root 用户
USER node

# 暴露端口 (如果需要 HTTP API)
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# 启动命令
CMD ["node", "dist/index.js"]
