#!/usr/bin/env node

import { ChatGPTBrowser } from "../src/browser.js";
import { USER_DATA_DIR } from "../src/config.js";

console.log("正在打开 ChatGPT MCP 专用 Chrome……");
console.log(`登录状态只保存在：${USER_DATA_DIR}`);
const browser = new ChatGPTBrowser();
try {
  const opened = await browser.openLogin();
  if (opened.automationFlag) {
    throw new Error("专用 Chrome 仍带有自动化标记，已停止登录以避免触发 Google 风控。");
  }
  console.log("请在新窗口中完成 ChatGPT 登录；脚本会自动识别成功，无需手动关闭窗口。");

  const deadline = Date.now() + 15 * 60_000;
  let signedIn = false;
  while (Date.now() < deadline) {
    signedIn = await browser.signedIn();
    if (signedIn) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (!signedIn) {
    throw new Error("等待登录超时，请重新运行 chatgpt-web-mcp login 或 npm run login。");
  }

  const status = await browser.status();
  console.log("登录成功，专用浏览器配置已经保存。");
  console.log(JSON.stringify(status, null, 2));
} finally {
  await browser.close();
}
