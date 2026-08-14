#!/usr/bin/env node

import fs from "node:fs";

import {
  BROWSER_STATE_FILE,
  CHROME_EXECUTABLE,
  NETWORK_LOG_FILE,
  RUNTIME_STATE_FILE,
  USER_DATA_DIR,
} from "../src/config.js";

const nodeMajor = Number(process.versions.node.split(".")[0]);
const checks = [
  {
    name: "Node.js >= 20",
    ok: nodeMajor >= 20,
    value: process.version,
  },
  {
    name: "Chrome / Chromium / Edge",
    ok: Boolean(CHROME_EXECUTABLE && fs.existsSync(CHROME_EXECUTABLE)),
    value: CHROME_EXECUTABLE || "not detected; set CHATGPT_WEB_CHROME",
  },
  {
    name: "Dedicated profile directory",
    ok: true,
    value: USER_DATA_DIR,
  },
];

for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.value}`);
}

console.log(`INFO  Browser state: ${BROWSER_STATE_FILE}`);
console.log(`INFO  Runtime state: ${RUNTIME_STATE_FILE}`);
console.log(`INFO  Sanitized network log: ${NETWORK_LOG_FILE}`);

if (checks.some((check) => !check.ok)) process.exitCode = 1;
