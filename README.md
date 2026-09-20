# ChatGPT Web MCP

[English](README.en.md)

一个本地、非官方的 MCP Server，让 Codex 等 MCP 客户端通过独立的持久浏览器配置操作 `chatgpt.com`。它不使用 OpenAI 官方付费 API，也不需要 API Key。消息发送通过网页完成；历史读取可能使用当前网页会话的内部接口。它不读取用户日常浏览器配置，也不会把登录信息写进 MCP 配置。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属或背书关系。它依赖 ChatGPT 网页界面，页面改版、账号权限、地区或工作区策略都可能影响可用性。请遵守适用于你账号的条款，不要用它绕过访问控制、用量限制或安全机制。

## 主要能力

- 写入提示词、上传文件、发送消息并读取完整回答
- 新建普通或临时对话，选择历史对话
- 动态读取和选择页面实际显示的模型、思考强度与能力档位
- 普通请求默认使用“极高”；临时 Pro 身份探针默认停用，避免额外创建临时对话和发送测试消息
- 浏览器和 ChatGPT 页面默认常驻，工具结束后只断开本地控制连接
- 跨进程串行操作、低频节流、回答完成后的切换静默期
- 遇到页面限流文字或非历史接口 HTTP 429 时熔断；历史接口 429 不触发全局熔断，不自动重试该接口
- 对话达到 40 轮或出现 ChatGPT maximum-length banner 时，发送前先滚动加载完整 transcript（含较早历史），再归档并轮换普通对话；直接 `chatgpt_submit_prompt` 会安全拦截
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
- 输入与输出：`chatgpt_write_prompt`、`chatgpt_upload_files`、`chatgpt_submit_prompt`、`chatgpt_send_message`、`chatgpt_get_latest_response`、`chatgpt_archive_conversation`
- 安全：`chatgpt_circuit_breaker_status`、`chatgpt_clear_circuit_breaker`、`chatgpt_network_diagnostics`
- 策略路由：`chatgpt_probe_pro_identity`、`chatgpt_route_new_chat`

只有用户明确要求关闭专用浏览器时，才应调用 `chatgpt_close_browser`。

## 默认路由策略

普通请求默认新建非临时对话并选择页面可用的“极高”档位，使用 `chatgpt_route_new_chat(requestPro=false)`。

**临时 Pro 身份探针默认停用**（`CHATGPT_WEB_PROBE_ENABLED=false`）。`chatgpt_probe_pro_identity` 或 `requestPro=true` 会明确报错，不新建临时对话，也不发送“你是什么模型？”；`forceProbe=true` 不能绕过停用设置。这样可以避免探针产生额外对话和请求。停用探针不等于禁止手动选择页面实际提供的 Pro 档位，但本工具不保证账号实际路由到哪一个模型。

仅在确实需要实验性身份核对时，才手动设置 `CHATGPT_WEB_PROBE_ENABLED=true` 并重启 MCP。当前实验流程在临时对话的可用档位发送探针，读取网络响应的 `model_slug`：mini 回退默认档位，其他非空标记记为 `network-verified`，缺少标记则停止。**非 mini 不等于 Pro**，该流程不会强制选择 Pro。工具名及 `requestPro` 参数为兼容旧客户端而保留，不能把它们理解为 Pro 保证。

启用探针时，同一浏览器与页面会话持续复用可靠缓存；检测到关闭后保留 3 小时，再次请求时才重验。普通 MCP 调用结束只断开控制连接，不关闭网页，不启动重验计时。默认停用状态下不会因缓存过期自动发起探针，也不会要求重新登录。

相关配置：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CHATGPT_WEB_PROBE_ENABLED` | `false` | 是否显式启用实验性临时身份探针 |
| `CHATGPT_WEB_DEFAULT_TIER` | `极高` | 普通请求和回退使用的倒数第二档名称 |
| `CHATGPT_WEB_PRO_TIER` | `Pro` | 滑杆最高档名称 |
| `CHATGPT_WEB_PROBE_PROMPT` | `你是什么模型？` | 临时身份探针提示词 |
| `CHATGPT_WEB_PROBE_ACCEPT_ID` | `gpt-5.6-pro` | 接受分类标识 |
| `CHATGPT_WEB_PROBE_FALLBACK_ID` | `gpt-5.5-mini` | 回退分类标识 |
| `CHATGPT_WEB_PROBE_ACCEPT_PATTERN` | GPT-5.6 Pro 正则 | 接受回答的匹配表达式 |
| `CHATGPT_WEB_PROBE_FALLBACK_PATTERN` | GPT-5.5 mini 正则 | 回退回答的匹配表达式 |
| `CHATGPT_WEB_PRO_RECHECK_AFTER_CLOSE_MS` | `10800000` | 页面或浏览器关闭后，重新验证前继续复用可靠结果的时间 |

参考配置见 [.env.example](.env.example)。项目不会自动读取 `.env`；请通过 MCP 客户端、Shell 或系统环境注入变量。

## 新对话前的可选刷新

`CHATGPT_WEB_REFRESH_BEFORE_NEW_CHAT=false`，默认不额外刷新旧页面。设置为 `true` 并重启 MCP 后，新建对话执行“检查草稿和附件 → 刷新当前页面 → 站内新建”。刷新失败或出现限流时停止，不重试。

这与现有的“发送前刷新”是两个步骤。开启后，一次新建并发送通常会刷新两次，增加请求量和耗时；它用于按需处理旧页面状态，不是防限流功能。已完成的小规模测试只能说明该流程可用，不能证明额外刷新能降低限流。浏览器与网页仍默认常驻。

## 安全节流

| 环境变量 | 默认值 |
| --- | ---: |
| `CHATGPT_WEB_PAGE_INTERACTION_INTERVAL_MS` | 1000 ms |
| `CHATGPT_WEB_SITE_ACTION_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_SEND_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_CONVERSATION_CHANGE_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_POST_RESPONSE_CONVERSATION_COOLDOWN_MS` | 5000 ms |
| `CHATGPT_WEB_PAGE_STARTUP_DELAY_MS` | 6000 ms |
| `CHATGPT_WEB_POST_BREAKER_COOLDOWN_MS` | 300000 ms |
| `CHATGPT_WEB_HISTORY_QUIET_PERIOD_MS` | 300000 ms |

**默认 5 秒是最小间隔，不是每 5 秒必定完成一次操作，也不是免于限流或封禁的保证。** 页面加载、页面交互、生成回答以及其他等待会叠加；完成上一条回答后才开始下一条，不并发发送。已有客户端环境变量会覆盖新默认值；例如原先显式配置了 `30000`，升级后仍使用 30 秒。

新建、临时切换和历史选择受独立的 5 秒对话变更间隔约束，回答完成后至少静默 5 秒才允许切换。首次打开 ChatGPT 页面后仍等待 6 秒。若账号出现请求频繁提示，应停止并增大间隔，例如把上述三个 `5000` 配置改回 `30000`，不要反复重试。

人工确认限流消失并清除本地熔断后，首次站点操作仍等待 5 分钟；页面明确提示历史限流时还有独立的 5 分钟静默截止时间，清除熔断不会绕过它。仅历史接口返回 HTTP 429 不触发全局熔断：浏览器响应保留诊断日志，主动读取失败则沿用页面 transcript 回退，不自动重试该接口。网页明确出现“请求过于频繁”等限流提示时仍停止。缺少现成请求头时不再额外打开页面取认证信息。

保留 PR 的旧进程锁回收逻辑：记录的 MCP 进程已退出时，后续操作会自动清除其生成标记，避免遗留锁阻塞。进程仍存活或标记未记录进程 ID 时，不按此规则清除；这不会同时清除限流熔断，也不会关闭浏览器。

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
- `CHATGPT_WEB_MAX_CONVERSATION_TURNS`：发送前自动轮换阈值，默认 `40`
- `CHATGPT_WEB_CONTEXT_ARCHIVE_DIR`：对话轮换前 Markdown 归档目录

## 隐私与局限

- 登录资料、运行状态和诊断日志默认位于 `~/.chatgpt-web-mcp`，不在仓库中。
- 文件上传只接受调用者明确提供的绝对路径。
- 网络诊断不保存查询参数、Cookie、请求体、响应体或对话 ID。
- 等待回答使用页面内的变更事件，不持续轮询页面。
- 每次发送前只做一次当前对话整页刷新并重新校验；页面、对话 URL、用户草稿或附件状态异常时停止，不自动重试。
- 对话轮换前的完整 transcript（含懒加载的较早消息）由 `chatgpt_archive_conversation` 或原子发送路径以 `0600` Markdown 文件保存；归档目录应按部署需要纳入受控的研究文档路径。
- ChatGPT 网页不是稳定 API；选择器可能随页面更新而需要维护。
- 模型自我说明和网络模型标记都不构成对实际服务模型的独立证明；尤其不能把“非 mini”当作 Pro 保证。

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
