import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runNode = promisify(execFile);

function isolatedPolicyCheck(source, overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("CHATGPT_WEB_")),
  );
  return runNode(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...env, ...overrides },
  });
}

test("default intervals are five seconds and disabled probes never touch the browser", async () => {
  await isolatedPolicyCheck(`
    import assert from "node:assert/strict";
    import * as config from "./src/config.js";
    import { ChatGPTBrowser } from "./src/browser.js";
    for (const name of ["SEND_INTERVAL_MS", "CONVERSATION_CHANGE_INTERVAL_MS", "POST_RESPONSE_CONVERSATION_COOLDOWN_MS"]) {
      assert.equal(config[name], 5000, name);
    }
    assert.equal(config.PAGE_STARTUP_DELAY_MS, 6000);
    assert.equal(config.POST_BREAKER_COOLDOWN_MS, 300000);
    assert.equal(config.HISTORY_QUIET_PERIOD_MS, 300000);
    assert.equal(config.PROBE_ENABLED, false);
    assert.equal(config.REFRESH_BEFORE_NEW_CHAT, false);

    const browser = new ChatGPTBrowser();
    browser.page = async () => assert.fail("disabled probe must not open a page");
    browser.newChat = async () => assert.fail("disabled probe must not create a chat");
    browser.submitPrompt = async () => assert.fail("disabled probe must not send");
    await assert.rejects(browser.probeProIdentity({ force: true }), /默认停用/);
    await assert.rejects(browser.routeNewChat({ prompt: "offline fixture", requestPro: true, forceProbe: true }), /默认停用/);
  `);
});

test("exited MCP owner releases its generation lock without reading the browser", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "chatgpt-web-mcp-policy-"));
  const runtimeFile = path.join(directory, "runtime.json");
  try {
    await writeFile(runtimeFile, JSON.stringify({
      activeGeneration: { active: true, ownerPid: 2_147_483_647 },
    }));
    await isolatedPolicyCheck(`
      import assert from "node:assert/strict";
      import { readFile, writeFile } from "node:fs/promises";
      import { ChatGPTBrowser } from "./src/browser.js";
      import { RUNTIME_STATE_FILE } from "./src/config.js";
      const browser = new ChatGPTBrowser();
      browser.page = async () => assert.fail("stale-owner cleanup must not open a page");
      browser.getLatestResponse = async () => assert.fail("stale-owner cleanup needs no page read");
      assert.deepEqual(await browser.assertActionsAllowed("offline-test"), {
        allowed: true, staleGenerationCleared: true,
      });
      const state = JSON.parse(await readFile(RUNTIME_STATE_FILE, "utf8"));
      assert.equal(state.activeGeneration, null);
      assert.ok(state.lastGenerationInterruptedAt > 0);

      for (const ownerPid of [process.pid, null]) {
        await writeFile(RUNTIME_STATE_FILE, JSON.stringify({ activeGeneration: { active: true, ownerPid } }));
        await assert.rejects(browser.assertActionsAllowed("offline-test"), /生成任务/);
      }
    `, { CHATGPT_WEB_RUNTIME_STATE: runtimeFile });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
