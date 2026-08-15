#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ChatGPTBrowser } from "./browser.js";
import {
  DEFAULT_ANSWER_TIER,
  PROBE_ACCEPT_CLASSIFICATION,
  PROBE_FALLBACK_CLASSIFICATION,
  PROBE_PROMPT,
  PRO_ANSWER_TIER,
  PRO_PROBE_RECHECK_AFTER_CLOSE_MS,
  RESPONSE_TIMEOUT_MS,
} from "./config.js";
import { userFacingError } from "./errors.js";

const browser = new ChatGPTBrowser();
const server = new McpServer({
  name: "chatgpt-web",
  version: "0.2.1",
}, {
  instructions:
    `默认保持专用浏览器和 ChatGPT 页面常驻，除非用户明确要求，否则绝不调用 chatgpt_close_browser。新任务优先用 chatgpt_route_new_chat：普通请求使用配置的默认档位“${DEFAULT_ANSWER_TIER}”；用户明确要求 Pro 时，临时使用“${PRO_ANSWER_TIER}”并发送身份探针，接受分类为“${PROBE_ACCEPT_CLASSIFICATION}”，回退分类为“${PROBE_FALLBACK_CLASSIFICATION}”。同一浏览器和 ChatGPT 页面会话内始终复用可靠探针；页面或浏览器关闭后保留结果 ${Math.round(PRO_PROBE_RECHECK_AFTER_CLOSE_MS / 3_600_000)} 小时，之后才重新验证。只有用户明确要求重新验证时才设置 forceProbe。`,
});

function asResult(value, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function tool(name, description, schema, handler, { allowDuringPause = false } = {}) {
  server.tool(name, description, schema, async (input, extra) => {
    try {
      const result = await browser.runExclusive(
        async () => {
          if (!allowDuringPause) await browser.assertActionsAllowed(name);
          return handler(input);
        },
        { signal: extra.signal, name },
      );
      return asResult(result);
    } catch (error) {
      return asResult(userFacingError(error), true);
    }
  });
}

tool(
  "chatgpt_status",
  "检查专用浏览器、登录、当前对话、模式与临时对话状态。仅在诊断或确需状态时调用；正常发送无需预先调用。默认不展开高级菜单。",
  {
    includeSettings: z
      .boolean()
      .default(false)
      .describe("是否额外展开高级菜单读取模型和思考强度；默认 false。"),
  },
  ({ includeSettings }) => browser.status({ includeSettings }),
);

tool(
  "chatgpt_browser_lifecycle",
  "读取专用 ChatGPT 浏览器的常驻状态。MCP 调用结束后浏览器会继续保持打开，后续调用直接接管，不重复进站。",
  {},
  () => browser.browserLifecycle(),
  { allowDuringPause: true },
);

tool(
  "chatgpt_close_browser",
  "明确关闭 ChatGPT MCP 的专用常驻浏览器。仅在用户明确要求关闭时调用。",
  {},
  () => browser.terminateBrowser(),
  { allowDuringPause: true },
);

tool(
  "chatgpt_capabilities",
  "一次读取当前模式、模型、思考强度、临时状态和少量可见历史摘要；用于确需综合预检时，避免连续调用多个状态工具。不会展开模型或思考强度子菜单。",
  {
    historyLimit: z.number().int().min(0).max(20).default(5),
  },
  ({ historyLimit }) => browser.capabilities({ historyLimit }),
);

tool(
  "chatgpt_list_modes",
  "列出 ChatGPT 新版页面顶部当前可用的模式，例如“聊天”和“工作”。",
  {},
  () => browser.listModes(),
);

tool(
  "chatgpt_select_mode",
  "选择 ChatGPT 新版页面顶部模式，例如“聊天”或“工作”，并校验选中状态。",
  {
    mode: z.string().min(1).describe("页面显示的模式名称；建议先调用 chatgpt_list_modes。"),
  },
  ({ mode }) => browser.selectMode(mode),
);

tool(
  "chatgpt_list_models",
  "按“当前档位→高级→模型”的页面层级，动态列出当前 ChatGPT 账号实际可用的模型。不要猜测模型名称。",
  {},
  () => browser.listModels(),
);

tool(
  "chatgpt_select_model",
  "按“当前档位→高级→模型”选择当前对话使用的模型，并校验结果。",
  {
    model: z.string().min(1).describe("模型菜单显示的完整或唯一名称；建议先调用 chatgpt_list_models。"),
  },
  ({ model }) => browser.selectModel(model),
);

tool(
  "chatgpt_list_thinking_levels",
  "按“当前档位→高级→思考强度”的页面层级，列出账号实际可用的思考强度。",
  {},
  () => browser.listThinkingLevels(),
);

tool(
  "chatgpt_select_thinking_level",
  "选择 ChatGPT 网页当前对话的思考强度，并校验页面显示的结果。",
  {
    thinkingLevel: z
      .string()
      .min(1)
      .describe(
        "页面显示的完整思考强度名称；若列表表明控件仅为滑块，也可传其 min..max 范围内的数值字符串。建议先调用 chatgpt_list_thinking_levels。",
      ),
  },
  ({ thinkingLevel }) => browser.selectThinkingLevel(thinkingLevel),
);

tool(
  "chatgpt_answer_tier_status",
  "读取输入框右侧能力滑杆的当前档位和可访问值域，例如“极高，第 4 项，共 5 项”。不会发送提示词。",
  {},
  () => browser.answerTierStatus(),
);

tool(
  "chatgpt_select_answer_tier",
  `选择输入框右侧的能力档位。当前支持精确选择配置的最高档“${PRO_ANSWER_TIER}”，并校验页面显示结果。`,
  {
    answerTier: z.string().min(1).describe(`能力档位名称；最高档默认为“${PRO_ANSWER_TIER}”。`),
  },
  ({ answerTier }) => browser.selectAnswerTier(answerTier),
);

tool(
  "chatgpt_new_chat",
  "创建新的普通或临时对话，并可同时选择模式、模型、思考强度和能力档位。",
  {
    temporary: z.boolean().default(false).describe("true 表示临时对话，不进入历史记录。"),
    mode: z.string().min(1).optional().describe("可选模式，例如“聊天”或“工作”。"),
    model: z.string().min(1).optional().describe("可选模型名称。"),
    thinkingLevel: z.string().min(1).optional().describe("可选思考强度。"),
    answerTier: z.string().min(1).optional().describe(`可选能力档位；传“${PRO_ANSWER_TIER}”时使用滑杆最后一档。`),
  },
  ({ temporary, mode, model, thinkingLevel, answerTier }) =>
    browser.newChat({ temporary, mode, model, thinkingLevel, answerTier }),
);

tool(
  "chatgpt_set_temporary",
  "开启或关闭新对话的临时对话模式，并通过页面状态进行校验。切换可能会打开一个新对话。",
  {
    enabled: z.boolean(),
  },
  ({ enabled }) => browser.setTemporary(enabled),
);

tool(
  "chatgpt_write_prompt",
  "把提示词准确写入 ChatGPT 网页输入框但不发送，适合先上传文件或让用户检查草稿。",
  {
    prompt: z.string().min(1),
    append: z.boolean().default(false).describe("是否追加到已有草稿；默认覆盖。"),
  },
  ({ prompt, append }) => browser.writePrompt(prompt, { append }),
);

tool(
  "chatgpt_upload_files",
  "向当前 ChatGPT 对话上传用户明确授权的本地文件。路径必须是绝对路径。不会自动发送提示词。",
  {
    files: z.array(z.string().min(1)).min(1).describe("待上传文件的绝对路径列表。"),
  },
  ({ files }) => browser.uploadFiles(files),
);

tool(
  "chatgpt_submit_prompt",
  `发送当前输入框中的提示词，并可等待 ChatGPT 网页回答完成。当前能力档位为“${PRO_ANSWER_TIER}”或模型名称带 Pro 时自动无限等待，timeoutMs 仅用于普通档位。`,
  {
    wait: z.boolean().default(true),
    timeoutMs: z.number().int().min(5_000).max(900_000).default(RESPONSE_TIMEOUT_MS),
  },
  ({ wait, timeoutMs }) => browser.submitPrompt({ wait, timeoutMs }),
);

tool(
  "chatgpt_send_message",
  `组合工具：可新建或继续对话、选择模式/模型/思考强度/能力档位、切换临时对话、上传文件、写入提示词、发送并取得回答。能力档位为“${PRO_ANSWER_TIER}”或模型名称带 Pro 时自动无限等待；普通档位仍使用 timeoutMs。只有用户明确要求上传时才传 files。`,
  {
    prompt: z.string().min(1),
    files: z.array(z.string().min(1)).default([]),
    mode: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    thinkingLevel: z.string().min(1).optional(),
    answerTier: z.string().min(1).optional().describe(`可选能力档位；传“${PRO_ANSWER_TIER}”时无限等待。`),
    newChat: z.boolean().default(false),
    temporary: z.boolean().default(false),
    wait: z.boolean().default(true),
    timeoutMs: z.number().int().min(5_000).max(900_000).default(RESPONSE_TIMEOUT_MS),
  },
  (input) => browser.sendMessage(input),
);

tool(
  "chatgpt_probe_pro_identity",
  `执行 Pro 身份探针：同一浏览器和 ChatGPT 页面会话内始终复用同模式的可靠结果；页面或浏览器关闭后继续复用 ${Math.round(PRO_PROBE_RECHECK_AFTER_CLOSE_MS / 3_600_000)} 小时，之后才重新验证。没有可用缓存时才新建临时对话、切到“${PRO_ANSWER_TIER}”、发送“${PROBE_PROMPT}”并无限等待。返回原回答及配置的接受/回退/unknown 分类，不创建正常对话。`,
  {
    mode: z.string().min(1).optional(),
    force: z.boolean().default(false).describe("true 表示忽略缓存并重新执行探针；仅在用户明确要求时使用。"),
  },
  ({ mode, force }) => browser.probeProIdentity({ mode, force }),
);

tool(
  "chatgpt_route_new_chat",
  `按可配置策略新建并发送：普通请求使用“${DEFAULT_ANSWER_TIER}”；明确请求 Pro 时先执行临时身份探针，命中“${PROBE_ACCEPT_CLASSIFICATION}”才在正常对话继续使用“${PRO_ANSWER_TIER}”，命中“${PROBE_FALLBACK_CLASSIFICATION}”则回退默认档位，其他回答停止。浏览器始终常驻。`,
  {
    prompt: z.string().min(1).describe("最终正常对话要发送的实际提示词。"),
    files: z.array(z.string().min(1)).default([]),
    requestPro: z.boolean().default(false).describe("用户是否明确要求 Pro。"),
    forceProbe: z.boolean().default(false).describe("是否忽略会话级 Pro 探针缓存；仅在用户明确要求时设为 true。"),
    mode: z.string().min(1).optional(),
    wait: z.boolean().default(true),
    timeoutMs: z.number().int().min(5_000).max(900_000).default(RESPONSE_TIMEOUT_MS),
  },
  (input) => browser.routeNewChat(input),
);

tool(
  "chatgpt_list_history",
  "列出 ChatGPT 侧栏当前加载的历史对话，可按标题筛选。返回 title、conversationId 和 URL。",
  {
    query: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  },
  ({ query, limit }) => browser.listHistory({ query, limit }),
);

tool(
  "chatgpt_search_history",
  "使用 ChatGPT 网页自带的“搜索聊天”界面查找历史对话，因此不受侧栏当前加载数量限制。返回 title、conversationId 和 URL。",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(20),
  },
  ({ query, limit }) => browser.searchHistory({ query, limit }),
);

tool(
  "chatgpt_select_history",
  "通过 conversationId、ChatGPT /c/... URL 或唯一标题打开历史对话，并返回最近一条回答。优先使用 ID。",
  {
    conversationId: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  },
  (input) => browser.selectHistory(input),
);

tool(
  "chatgpt_get_latest_response",
  "读取当前 ChatGPT 对话最近一条完整回复和对话状态。默认不为状态展示额外展开高级菜单。",
  {
    includeSettings: z
      .boolean()
      .default(false)
      .describe("是否额外读取模型和思考强度；默认 false。"),
  },
  ({ includeSettings }) => browser.getLatestResponse({ includeSettings }),
  { allowDuringPause: true },
);

tool(
  "chatgpt_circuit_breaker_status",
  "只读取本地安全熔断和未确认生成任务状态，不访问 ChatGPT 网页。",
  {},
  () => browser.circuitBreakerStatus(),
  { allowDuringPause: true },
);

tool(
  "chatgpt_clear_circuit_breaker",
  "仅在用户已经人工确认 ChatGPT 限流提示消失后，清除本地安全熔断。不会访问网页。",
  {
    confirmed: z.literal(true).describe("必须由用户人工确认限流提示已经消失。"),
  },
  ({ confirmed }) => browser.clearCircuitBreaker({ confirmed }),
  { allowDuringPause: true },
);

tool(
  "chatgpt_network_diagnostics",
  "读取本地脱敏网络异常记录。只包含时间、方法、脱敏路径、状态码和资源类型；不含查询参数、Cookie、请求体或响应体。",
  {
    limit: z.number().int().min(1).max(500).default(100),
  },
  ({ limit }) => browser.networkDiagnostics({ limit }),
  { allowDuringPause: true },
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Disconnect Playwright only. The dedicated Chrome is intentionally kept
  // alive so the next MCP process can reuse its page and signed-in session.
  await browser.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
server.server.onclose = shutdown;
console.error("chatgpt-web-mcp ready");
