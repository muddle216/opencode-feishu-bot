# 🤖 OpenCode 飞书机器人

## 🎯 项目定位

**OpenCode TUI 完全替代方案** - 抛弃终端/命令行/attach操作，全部功能在飞书内通过机器人完成。

### ✨ 核心特性

- **🚫 无终端依赖** - 完全抛弃命令行，所有操作在飞书内完成
- **🤖 纯飞书界面** - 通过飞书消息卡片和快捷指令操作
- **🔄 1:1功能映射** - 支持TUI所有功能，无缝迁移
- **⚡ 实时交互** - 会话内实时命令执行和流式响应
- **📱 移动端友好** - 完美支持手机端操作
- **🔒 企业级安全** - 完整的权限控制和日志记录

## 📋 支持的TUI全功能

### 会话管理
- ✅ 查看所有会话列表
- ✅ 创建新会话
- ✅ 进入/附着会话
- ✅ 退出会话
- ✅ 停止会话
- ✅ 删除会话

### 命令执行
- ✅ 会话内发送指令
- ✅ 实时命令交互（SSE流式输出）
- ✅ 子代理活动显示
- ✅ Thinking过程显示
- ✅ 工具执行状态显示
- ✅ 命令结果展示
- ✅ 错误处理和提示

### 监控管理
- ✅ 查看会话实时日志
- ✅ 查看系统状态
- ✅ 会话历史记录

## 🚀 快速开始

### 1. 环境配置
```bash
# 复制配置文件
cp .env.example .env

# 编辑配置
# FEISHU_APP_ID=xxx
# FEISHU_APP_SECRET=xxx
# FEISHU_VERIFICATION_TOKEN=xxx
# OPENCODE_API_URL=https://api.opencode.ai
# OPENCODE_API_TOKEN=your_token
```

### 2. 启动服务
```bash
npm install
npm run dev
```

### 3. 基本使用

```bash
# 查看帮助
/opencode help

# 查看会话列表
/opencode list

# 创建新会话
/opencode create 开发测试

# 进入会话
/opencode attach session_123456

# 查看系统状态
/opencode status
```

## 🤖 支持的命令

### 全局命令
| 命令 | 别名 | 描述 |
|------|------|------|
| `/opencode help` | `/opencode 帮助` | 显示帮助信息 |
| `/opencode list` | `/opencode ls`, `/opencode 列表` | 查看会话列表 |
| `/opencode create [描述]` | `/opencode new [描述]` | 创建新会话 |
| `/opencode attach [会话ID]` | `/opencode enter [会话ID]` | 进入会话 |
| `/opencode status` | `/opencode stat` | 查看系统状态 |

### 会话内命令（冒号前缀）
| 命令 | 描述 |
|------|------|
| `:help` / `:h` | 显示会话内帮助 |
| `:exit` / `:quit` / `:bye` | 退出会话 |
| `:clear` | 清空屏幕 |
| `:logs` | 查看会话日志 |
| `:status` | 查看会话状态 |
| `:history [n]` | 查看最近n条消息 |
| `:interrupt` | 中断当前操作 |
| `:compact` | 压缩会话历史 |
| `:share` | 获取分享链接 |
| `:agent.cycle` | 切换到下一个Agent |
| `[其他命令]` | 发送到OpenCode执行 |

### 输出前缀说明
执行命令时，会显示以下前缀标记不同类型的输出：
- `[:thinking ...]` - AI思考过程
- `[:tool ...]` - 工具执行状态
- `[:agent ...]` - 子代理活动
- `[:step ...]` - 步骤标记
- `[:permission ...]` - 权限请求

## 🏗️ 技术架构

### 架构图
```
飞书客户端 ←→ Express Webhook ←→ 会话管理器 ←→ OpenCode SDK (SSE流式)
```

### 技术栈
- **后端**：Node.js + Express
- **API客户端**：@opencode-ai/sdk (ESM)
- **飞书API**：Axios
- **日志系统**：Winston
- **容器化**：Docker支持

### 核心模块
1. **会话管理器** - 管理所有用户会话状态
2. **命令处理器** - 解析和执行用户命令
3. **SSE流处理** - 处理OpenCode流式响应
4. **消息渲染器** - 生成飞书消息卡片
5. **事件监听器** - 处理飞书事件回调

## 🔧 配置说明

### 环境变量
```bash
# 飞书配置
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx

# OpenCode配置
OPENCODE_API_URL=https://api.opencode.ai
OPENCODE_API_TOKEN=t-xxx

# 服务配置
PORT=3000
LOG_LEVEL=info
```

## 📊 监控与维护

### 日志管理
- 错误日志：`error.log`
- 综合日志：`combined.log`
- 日志级别：`debug`, `info`, `warn`, `error`

### 健康检查
```bash
curl http://localhost:3000/health
```

### 测试端点（无需飞书）
```bash
# 查看会话列表
GET /test/sessions

# 创建会话
POST /test/sessions
Body: { "title": "Test Session" }

# 发送消息
POST /test/sessions/:id/message
Body: { "message": "hello" }

# 获取会话详情
GET /test/sessions/:id
```

## 🔍 常见问题排查

### 1. 飞书消息发送失败 (code 230001)
**原因**: `receive_id` 无效或会话已关闭
**解决**: 检查 `chatId` 是否正确，确保会话活跃

### 2. 卡片嵌套错误 (code 11310)
**原因**: 在 card 元素内嵌套了另一个 card
**解决**: 使用 `{tag: 'div'}` 替代嵌套 card

### 3. SSE返回空事件
**原因**: 使用了 `session.prompt()` 而不是 `client.sse.post()`
**解决**: 使用 `opencodeClient.client.sse.post()` 获取流式响应

### 4. 命令无响应
**原因**: 会话未正确附着或已过期
**解决**: 使用 `/opencode attach [会话ID]` 重新进入会话

## 🚀 部署方式

### 本地开发
```bash
npm install
npm run dev
```

### 生产部署
```bash
npm install --production
npm start
```

### Docker部署
```bash
docker build -t opencode-feishu-bot .
docker run -d -p 3000:3000 --env-file .env opencode-feishu-bot
```

## 📄 许可证

MIT License

---

**OpenCode 飞书机器人 - 让开发更简单！** 🎉