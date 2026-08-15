# ChatGPT Web MCP

[English](README.en.md)

一个本地、非官方的 MCP Server，让 Codex 等 MCP 客户端通过独立的持久浏览器配置操作 `chatgpt.com`。它不调用 ChatGPT API，不读取用户日常浏览器配置，也不会把登录信息写进 MCP 配置。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属或背书关系。它依赖 ChatGPT 网页界面，页面改版、账号权限、地区或工作区策略都可能影响可用性。请遵守适用于你账号的条款，不要用它绕过访问控制、用量限制或安全机制。

## 主要能力

- 写入提示词、上传文件、发送消息并读取完整回答
- 新建普通或临时对话，选择历史对话
- 动态读取和选择页面实际显示的模型、思考强度与能力档位
- 使用可配置的临时身份探针决定是否在正常对话继续使用 Pro，并在同一页面会话内持续复用可靠结果
- 浏览器和 ChatGPT 页面默认常驻，工具结束后只断开本地控制连接
- 跨进程串行操作、低频节流、回答完成后的切换静默期
- 遇到页面限流文字或 HTTP 429 时立即熔断，不自动关闭提示或重试
- 只记录脱敏后的异常请求方法、路径、状态码和资源类型

## 运行要求

- Node.js 20 或更高版本
- Google Chrome、Chromium 或 Microsoft Edge
- 支持本地 stdio MCP 的客户端，例如 Codex
- 可正常访问并手动登录的 ChatGPT 账号

项目会在 macOS、Windows 和 Linux 的常见位置查找浏览器。找不到时可通过 `CHATGPT_WEB_CHROME` 指定可执行文件。

## 安装

```bash
git clone https://github.com/Goudu666/chatgpt-web-mcp.git
cd chatgpt-web-mcp
npm ci
npm run doctor
```

为了在任意目录使用统一命令，可以建立本地全局链接：

```bash
npm link
chatgpt-web-mcp doctor
```

## 首次登录

```bash
chatgpt-web-mcp login
```

未执行 `npm link` 时也可以使用：

```bash
npm run login
```

在打开的专用浏览器窗口中手动登录。登录资料默认保存在 `~/.chatgpt-web-mcp/chrome-profile`，与日常浏览器配置分离。不要复制、提交或分享这个目录，也不要把密码、Cookie、令牌或验证码写进环境变量。

## 添加到 Codex

使用统一命令：

```bash
codex mcp add chatgpt-web -- chatgpt-web-mcp serve
codex mcp get chatgpt-web
```

如果 Codex 找不到全局命令，可以直接使用 Node.js 和项目的绝对路径：

```bash
codex mcp add chatgpt-web -- node /absolute/path/to/chatgpt-web-mcp/src/index.js
```

Codex 的 MCP 配置方式可参考 [OpenAI Docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## CLI

```text
chatgpt-web-mcp serve    启动 stdio MCP Server（默认命令）
chatgpt-web-mcp login    打开专用浏览器并等待手动登录
chatgpt-web-mcp status   读取当前本地状态
chatgpt-web-mcp doctor   检查 Node.js、浏览器和本地数据路径
chatgpt-web-mcp help     显示帮助
```

## MCP 工具

工具按用途分为以下几组：

- 状态：`chatgpt_status`、`chatgpt_capabilities`、`chatgpt_browser_lifecycle`
- 对话：`chatgpt_new_chat`、`chatgpt_set_temporary`、`chatgpt_list_history`、`chatgpt_search_history`、`chatgpt_select_history`
- 设置：`chatgpt_list_modes`、`chatgpt_select_mode`、`chatgpt_list_models`、`chatgpt_select_model`、`chatgpt_list_thinking_levels`、`chatgpt_select_thinking_level`、`chatgpt_answer_tier_status`、`chatgpt_select_answer_tier`
- 输入与输出：`chatgpt_write_prompt`、`chatgpt_upload_files`、`chatgpt_submit_prompt`、`chatgpt_send_message`、`chatgpt_get_latest_response`
- 安全：`chatgpt_circuit_breaker_status`、`chatgpt_clear_circuit_breaker`、`chatgpt_network_diagnostics`
- 策略路由：`chatgpt_probe_pro_identity`、`chatgpt_route_new_chat`

只有用户明确要求关闭专用浏览器时，才应调用 `chatgpt_close_browser`。

## 默认路由策略

普通请求默认新建非临时对话并选择“极高”。明确请求 Pro 时：

1. 优先复用同模式下仍有效的身份探针缓存；只要专用浏览器和原 ChatGPT 页面没有关闭，就不按时间重复探针。
2. 没有缓存时，新建临时对话并选择 Pro。
3. 发送“你是什么模型？”，无限等待回答完成。
4. 回答匹配 GPT-5.6 Pro 时，新建正常 Pro 对话。
5. 回答匹配 GPT-5.5 mini 时，新建正常“极高”对话。
6. 其他回答停止，不创建正常对话。

如果专用浏览器或原 ChatGPT 页面中途关闭，已有可靠结果会先继续复用 3 小时；3 小时后发起下一次 Pro 请求时才重新验证。普通 MCP 调用结束只断开本地控制连接，不关闭页面，因此不会触发重新验证计时。无法确定手动关闭的准确时刻时，从首次检测到会话中断开始计算，以减少额外请求。

以上是默认值，不是写死的账号假设。可通过环境变量替换：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CHATGPT_WEB_DEFAULT_TIER` | `极高` | 普通请求和回退使用的倒数第二档名称 |
| `CHATGPT_WEB_PRO_TIER` | `Pro` | 滑杆最高档名称 |
| `CHATGPT_WEB_PROBE_PROMPT` | `你是什么模型？` | 临时身份探针提示词 |
| `CHATGPT_WEB_PROBE_ACCEPT_ID` | `gpt-5.6-pro` | 接受分类标识 |
| `CHATGPT_WEB_PROBE_FALLBACK_ID` | `gpt-5.5-mini` | 回退分类标识 |
| `CHATGPT_WEB_PROBE_ACCEPT_PATTERN` | GPT-5.6 Pro 正则 | 接受回答的匹配表达式 |
| `CHATGPT_WEB_PROBE_FALLBACK_PATTERN` | GPT-5.5 mini 正则 | 回退回答的匹配表达式 |
| `CHATGPT_WEB_PRO_RECHECK_AFTER_CLOSE_MS` | `10800000` | 页面或浏览器关闭后，重新验证前继续复用可靠结果的时间 |

参考配置见 [.env.example](.env.example)。项目不会自动读取 `.env`；请通过 MCP 客户端、Shell 或系统环境注入变量。

## 安全节流

| 环境变量 | 默认值 |
| --- | ---: |
| `CHATGPT_WEB_PAGE_INTERACTION_INTERVAL_MS` | 1000 ms |
| `CHATGPT_WEB_SITE_ACTION_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_SEND_INTERVAL_MS` | 30000 ms |
| `CHATGPT_WEB_CONVERSATION_CHANGE_INTERVAL_MS` | 30000 ms |
| `CHATGPT_WEB_POST_RESPONSE_CONVERSATION_COOLDOWN_MS` | 30000 ms |
| `CHATGPT_WEB_POST_BREAKER_COOLDOWN_MS` | 300000 ms |
| `CHATGPT_WEB_HISTORY_QUIET_PERIOD_MS` | 300000 ms |

新建、临时切换和历史选择受独立的对话变更间隔约束。回答完成后至少静默 30 秒才允许切换；人工清除熔断后，首次站点操作默认再等待 5 分钟。历史记录限流还有独立的静默截止时间，清除熔断不会绕过它。

不要为了“更快”而在公开分支中降低这些默认值。

## 其他环境变量

- `CHATGPT_WEB_CHROME`：浏览器可执行文件绝对路径
- `CHATGPT_WEB_PROFILE`：专用浏览器配置目录
- `CHATGPT_WEB_HEADLESS`：是否无界面运行，默认 `false`
- `CHATGPT_WEB_ACTION_TIMEOUT_MS`：单次页面操作超时
- `CHATGPT_WEB_RESPONSE_TIMEOUT_MS`：普通档位回答超时
- `CHATGPT_WEB_RECONNECT_DELAY_MS`：浏览器异常重连间隔
- `CHATGPT_WEB_AUTH_CACHE_MS`：登录状态本地缓存时间
- `CHATGPT_WEB_PRO_RECHECK_AFTER_CLOSE_MS`：页面或浏览器关闭后的探针重验间隔，默认 3 小时
- `CHATGPT_WEB_BROWSER_STATE`、`CHATGPT_WEB_RUNTIME_STATE`：本地状态文件
- `CHATGPT_WEB_OPERATION_LOCK`：跨进程浏览器独占锁
- `CHATGPT_WEB_NETWORK_LOG`：脱敏网络异常日志

## 隐私与局限

- 登录资料、运行状态和诊断日志默认位于 `~/.chatgpt-web-mcp`，不在仓库中。
- 文件上传只接受调用者明确提供的绝对路径。
- 网络诊断不保存查询参数、Cookie、请求体、响应体或对话 ID。
- 等待回答使用页面内的变更事件，不持续轮询页面。
- 页面操作失败时会停止，不通过整页重载反复尝试。
- ChatGPT 网页不是稳定 API；选择器可能随页面更新而需要维护。
- 模型的自我说明只能作为路由信号，不等同于服务端可验证的模型证明。

## 开发

```bash
npm ci
npm test
npm run smoke
npm pack --dry-run
```

CI 只运行离线测试和打包检查，不登录 ChatGPT，也不执行真实网页请求。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请阅读 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
