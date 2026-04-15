# 🚀 OpenCode 飞书机器人部署指南

## 📋 目录
1. [环境要求](#环境要求)
2. [安装部署](#安装部署)
3. [飞书配置](#飞书配置)
4. [启动服务](#启动服务)
5. [验证部署](#验证部署)
6. [常见问题](#常见问题)

## 📋 环境要求

### 系统要求
- Linux/macOS/Windows
- Node.js 16.0+
- npm 8.0+
- 2GB+ 内存
- 10GB+ 磁盘空间

### 网络要求
- 服务器需要公网IP或内网穿透
- 开放端口：3000（可配置）
- 可访问飞书开放平台API
- 可访问OpenCode API服务

## 🚀 安装部署

### 1. 克隆项目
```bash
git clone https://github.com/yourusername/opencode-feishu-bot.git
cd opencode-feishu-bot
```

### 2. 安装依赖
```bash
npm install --production
```

### 3. 配置环境变量
```bash
cp .env.example .env
# 编辑配置文件
vim .env
```

**配置说明：**
```
# 飞书机器人配置
FEISHU_APP_ID=your_feishu_app_id
FEISHU_APP_SECRET=your_feishu_app_secret
FEISHU_VERIFICATION_TOKEN=your_feishu_verification_token

# OpenCode API配置
OPENCODE_API_URL=http://localhost:8080/api
OPENCODE_API_TOKEN=your_opencode_api_token

# 服务器配置
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info
```

## 🤖 飞书配置

### 1. 创建飞书应用
1. 访问 [飞书开发者平台](https://open.feishu.cn/)
2. 登录并创建企业内部应用
3. 填写应用基本信息
4. 记录 App ID 和 App Secret

### 2. 配置权限
在"权限管理"中添加以下权限：
- `im:message` - 发送消息
- `im:message:send_as_bot` - 以机器人身份发送消息
- `im:chat` - 群聊相关接口

### 3. 配置事件订阅
在"事件订阅"中：
1. 启用事件订阅
2. 填写请求网址：`http://your-server-ip:3000/webhook/feishu`
3. 填写加密密钥（与 `.env` 中的 `FEISHU_VERIFICATION_TOKEN` 保持一致）
4. 订阅以下事件：
   - `im.message.receive_v1` - 接收消息
   - `im.interactive_message.card.action` - 卡片交互

### 4. 配置机器人
在"机器人"中：
1. 启用机器人
2. 设置机器人名称为"OpenCode"
3. 上传机器人头像
4. 复制验证令牌

### 5. 添加机器人到群聊
1. 创建或选择一个飞书群聊
2. 添加机器人到群聊
3. 测试机器人是否正常工作

## 🎯 启动服务

### 直接启动
```bash
# 开发环境
npm run dev

# 生产环境
npm start
```

### 使用 PM2 管理（推荐）
```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start server.js --name opencode-feishu-bot

# 设置开机自启
pm2 startup
pm2 save
```

### 使用 Docker 部署
```bash
# 构建镜像
docker build -t opencode-feishu-bot .

# 运行容器
docker run -d \
  --name opencode-feishu-bot \
  -p 3000:3000 \
  --env-file .env \
  opencode-feishu-bot
```

## ✅ 验证部署

### 1. 健康检查
```bash
curl http://localhost:3000/health
```
预期输出：
```json
{
  "status": "ok",
  "timestamp": "2024-01-10T08:00:00.000Z",
  "version": "1.0.0",
  "uptime": 3600
}
```

### 2. 测试机器人
在飞书群聊中发送：
```
/opencode help
```

预期收到机器人回复的帮助信息卡片。

### 3. 功能测试
```
/opencode status      # 查看系统状态
/opencode list        # 查看会话列表  
/opencode create 测试  # 创建测试会话
```

## 🔧 配置管理

### 日志管理
- 错误日志：`error.log`
- 综合日志：`combined.log`
- 日志级别：debug, info, warn, error

### 性能监控
- 内存使用：Node.js 内置监控
- CPU 使用：系统监控
- 会话数量：通过 `/opencode status` 查看

### 安全配置
- 定期更新依赖包
- 使用 HTTPS（推荐）
- 配置防火墙规则
- 定期更换 API Token

## 🐛 常见问题

### 1. 机器人无响应
- 检查网络连接
- 验证飞书配置是否正确
- 查看日志文件排查错误
- 确认 webhook 地址可访问

### 2. API 调用失败
- 检查 OpenCode API 地址是否正确
- 验证 API Token 是否有效
- 确认 OpenCode 服务是否运行

### 3. 权限问题
- 确认飞书应用权限已正确配置
- 检查机器人是否已添加到群聊
- 验证用户是否有权限操作

### 4. 性能问题
- 增加服务器资源
- 优化 Node.js 内存配置
- 减少同时在线会话数量

## 📞 技术支持

### 联系方式
- 问题反馈：GitHub Issues
- 技术支持：your-email@example.com
- 文档更新：定期更新部署指南

### 版本更新
```bash
# 拉取最新代码
git pull

# 更新依赖
npm install --production

# 重启服务
pm2 restart opencode-feishu-bot
```

## 📄 许可证
MIT License - 详见 LICENSE 文件

---

**部署完成后，请在飞书群聊中使用 `/opencode help` 开始体验！** 🎉