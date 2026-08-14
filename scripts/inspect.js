#!/usr/bin/env node

import { ChatGPTBrowser } from "../src/browser.js";

const browser = new ChatGPTBrowser();
try {
  console.log(JSON.stringify(await browser.status(), null, 2));
  if (process.argv.includes("--full") && (await browser.signedIn())) {
    console.log("\n可用模型：");
    console.log(JSON.stringify(await browser.listModels(), null, 2));
    console.log("\n可见历史对话：");
    console.log(JSON.stringify(await browser.listHistory({ limit: 10 }), null, 2));
  }
} finally {
  await browser.close();
}
