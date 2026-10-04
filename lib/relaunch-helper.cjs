/**
 * dsh-app-restart — 分离式重启助手。
 *
 * 这个文件**不**由 cordis 加载，也不是 ESM 插件的一部分：它由 host 半
 * （`lib/index.js`）用 `spawn(process.execPath, [本文件, planJson])` 拉起来，
 * 而 `process.execPath` 是桌面端的 Electron 主程序 —— 所以它跑在
 * **Electron 的 Node 模式**里（父进程显式给了 `ELECTRON_RUN_AS_NODE=1`）。
 * 用 `.cjs` 是为了不依赖 ESM 加载路径，纯 CommonJS 最省事。
 *
 * 为什么必须另起一个进程：重启的第三步是「杀掉外壳」，而外壳一死，宿主
 * （也就是发起这次重启的进程）会顺着 IPC disconnect 优雅退出 —— 发起者自己
 * 活不到「重新拉起应用」那一步。助手是脱离的（detached + unref），
 * 两边都死了它还活着，正好把最后一棒跑完。
 *
 * 顺序（每步都写日志，出问题照着日志看）：
 *   1. 静默 settleMs —— 让 HTTP 回包先落地；
 *   2. 终止外壳（Electron 主进程）。**先杀外壳是刻意的**：这样宿主的去向只有一种，
 *      不会出现「宿主先死 → 外壳弹崩溃恢复框 → 再去杀外壳」那种会闪一个错误框、
 *      还会写一份崩溃报告的场面；而且万一外壳杀不掉，后面全部跳过，应用照旧运行
 *      —— 失败是安全的；
 *   3. 等宿主退出。这里有个平台差异（实测过，见 README「宿主是怎么没的」）：
 *        · Windows：宿主是外壳用**非 detached** 方式拉起来的子进程，系统把它和父进程
 *          放在同一个 Job 里，外壳一死宿主**立刻跟着被清掉**（没有任何 JS 钩子机会）；
 *        · macOS / Linux：父进程死不会带走子进程，宿主会收到 IPC 断开事件，
 *          走它自己的 `process.once("disconnect") → application.shutdown.shutdown(0)`
 *          优雅停机。
 *      两种情况这一步都只是「确认它没了」；万一它顽固地活着（比如某个平台上既没被
 *      带走、也没自己退），才补一刀；
 *   4. 静默一小会儿让端口/锁文件落地；
 *   5. 用**干净环境**重新拉起 `DeepSeek Harness.exe`（剥掉 ELECTRON_RUN_AS_NODE，
 *      否则新进程会变成又一个 Node 模式进程而不是桌面应用）。
 *
 * plan 走的是 argv 里的一段 JSON，**助手自己也要夹一遍**（`normalizePlan`）：
 * 时间预算一旦是 NaN，「等进程消失」那条循环就没有终点 —— 外壳已经被杀掉的应用
 * 会永远等不到「重新拉起」。host 半永远传的是钳过的数字，这里是最后一道防线。
 *
 * 日志：`plan.logPath`（宿主编的临时目录）。助手不删日志，方便事后排查；
 * 结尾会写一条机器可读的收尾行（`helper done: {...}` / `ABORT: ...` /
 * `helper crashed: ...`），host 半与客户端就是靠它判断上一次的结局。
 *
 * `normalizePlan` 是导出的纯函数，自测（`test-host.mjs`）直接 require 它，
 * 所以整个脚本体收在 `require.main === module` 里面。
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");

/**
 * 时间预算的上下限，与 host 半的 TIMING_LIMITS 同源（那边是"别让手滑的参数提前杀外壳"，
 * 这边是"别让非法参数把助手挂死"）。非法值一律回落到默认值，不抛错。
 */
const TIMING_LIMITS = {
  settleMs: { fallback: 1500, min: 300, max: 15000 },
  shellTimeoutMs: { fallback: 15000, min: 1000, max: 120000 },
  forceTimeoutMs: { fallback: 5000, min: 500, max: 60000 },
  hostTimeoutMs: { fallback: 20000, min: 1000, max: 120000 },
  quietMs: { fallback: 600, min: 100, max: 10000 }
};

/** 单个时间参数的钳制（字符串数字也认，非法值回落到 fallback）。 */
const clampMs = (value, limits) => {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return limits.fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(number)));
};

/**
 * 解析并归一化 host 半递过来的 plan。
 * @param raw - argv[2]，一段 JSON 文本。
 * @returns 归一化后的 plan（时间参数全部有限且在区间内、relaunchArgs 一定是字符串数组）。
 * @throws 文本不是 JSON、或不是对象时。
 */
const normalizePlan = (raw) => {
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("plan must be an object");
  const plan = { ...parsed };
  for (const [key, limits] of Object.entries(TIMING_LIMITS)) plan[key] = clampMs(parsed[key], limits);
  plan.relaunchArgs = Array.isArray(parsed.relaunchArgs) ? parsed.relaunchArgs.filter((arg) => typeof arg === "string") : [];
  return plan;
};

/**
 * 等宿主写下的 ack 标记。
 *
 * 客户端拿到回包就会让宿主写它（`POST /app-restart/api/delivered`），所以正常情况下
 * 助手几十毫秒就能动手；拿不到（老客户端、curl 直调、或者标记写失败）就按 settleMs
 * 兜底 —— 与没有 ack 之前完全一样，只是慢一点。这就是那 1.5 秒的全部含义：
 * 它是**上界**，不是固定等待。
 *
 * @param plan - 已归一化的 plan（`readyFile` 缺省时退化成纯 sleep）。
 * @param log - 写日志的函数。
 * @returns 实际等了多久（毫秒）。
 */
const waitForAck = async (plan, log) => {
  const started = Date.now();
  const budget = Number.isFinite(plan.settleMs) && plan.settleMs > 0 ? plan.settleMs : 0;
  const readyFile = typeof plan.readyFile === "string" && plan.readyFile !== "" ? plan.readyFile : undefined;
  if (readyFile === undefined) {
    await new Promise((resolve) => { setTimeout(resolve, budget); });
    log(`no ack channel in this plan; waited settleMs=${budget}ms`);
    return budget;
  }
  for (;;) {
    const elapsed = Date.now() - started;
    if (fs.existsSync(readyFile)) {
      log(`ack received after ${elapsed}ms; proceeding`);
      return elapsed;
    }
    if (elapsed >= budget) {
      log(`no ack within settleMs=${budget}ms; proceeding anyway`);
      return elapsed;
    }
    await new Promise((resolve) => { setTimeout(resolve, Math.min(25, Math.max(1, budget - elapsed))); });
  }
};

/**
 * 进程还在不在。`process.kill(pid, 0)` 在 Windows 上走 OpenProcess：
 * ESRCH = 没了；EPERM = 还在但没权限动它（照样算"在"）。
 */
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === "object" && error.code === "EPERM";
  }
};

/** 等进程消失；返回是否确实没了。时间预算非有限值时按 0 处理（立刻判定，不退化成死循环）。 */
const waitGone = async (pid, timeoutMs, label, log) => {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  const deadline = Date.now() + budget;
  for (;;) {
    if (!alive(pid)) {
      log(`gone: ${label} ${pid}`);
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, 120); });
  }
};

const terminate = (pid, label, log) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, "SIGTERM");
    log(`terminate: SIGTERM -> ${label} ${pid}`);
    return true;
  } catch (error) {
    const code = error !== null && typeof error === "object" ? error.code : undefined;
    log(`terminate: SIGTERM -> ${label} ${pid} failed (${code ?? String(error)})`);
    return code === "ESRCH";
  }
};

const relaunch = (plan) => {
  const env = { ...process.env };
  // 关键：新进程必须是「桌面应用」，不能是「Node 模式进程」。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_DESKTOP_NODE_EXECUTABLE;
  const child = spawn(plan.execPath, plan.relaunchArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    cwd: plan.cwd,
    env
  });
  child.unref();
  return child;
};

/**
 * 跑完一整条重启链路；每一步都写 `plan.logPath`。
 * @param plan - 已归一化的 plan。
 * @returns 结局对象（`{relaunched:true,pid}` 或 `{relaunched:false,reason}`）。
 */
const run = async (plan) => {
  const log = (message) => {
    try {
      fs.appendFileSync(plan.logPath, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      /* 日志写不进去也不能让重启停下 */
    }
  };

  try {
    log(`helper start: pid=${process.pid} host=${plan.hostPid} shell=${plan.shellPid} exec=${plan.execPath}`);
    log(`timing: ${JSON.stringify({
      settleMs: plan.settleMs,
      shellTimeoutMs: plan.shellTimeoutMs,
      forceTimeoutMs: plan.forceTimeoutMs,
      hostTimeoutMs: plan.hostTimeoutMs,
      quietMs: plan.quietMs
    })}`);

    // 1. 等客户端确认「回包已经拿到」：ack 一到立刻动手，最多等到 settleMs 兜底。
    const waited = await waitForAck(plan, log);
    log(`settle: waited ${waited}ms (ceiling ${plan.settleMs}ms)`);

    // 2. 外壳。
    if (!alive(plan.shellPid)) {
      log(`shell ${plan.shellPid} already gone; continuing`);
    } else {
      terminate(plan.shellPid, "shell", log);
      let gone = await waitGone(plan.shellPid, plan.shellTimeoutMs, "shell", log);
      if (!gone) {
        log("shell survived the first SIGTERM; sending another");
        terminate(plan.shellPid, "shell", log);
        gone = await waitGone(plan.shellPid, plan.forceTimeoutMs, "shell", log);
      }
      if (!gone) {
        // 安全失败：宿主还活着、界面照旧，什么都不拉起。
        log(`ABORT: shell ${plan.shellPid} is still alive; nothing was relaunched and the app keeps running`);
        log('helper done: {"relaunched":false,"reason":"shell-alive"}');
        return { relaunched: false, reason: "shell-alive" };
      }
    }

    // 3. 宿主：Windows 上它已经跟着外壳一起被系统清掉了；其它平台它自己优雅退出。
    if (await waitGone(plan.hostPid, plan.hostTimeoutMs, "host", log)) {
      log("host stopped without force");
    } else {
      log("host did not stop on its own; terminating it");
      terminate(plan.hostPid, "host", log);
      if (!await waitGone(plan.hostPid, plan.forceTimeoutMs, "host", log)) {
        log(`WARN: host ${plan.hostPid} is still alive; relaunching anyway (the new instance may hit the single-instance lock)`);
      }
    }

    // 4. 端口与锁文件落地。
    await new Promise((resolve) => { setTimeout(resolve, plan.quietMs); });

    // 5. 重新拉起桌面应用。
    try {
      const child = relaunch(plan);
      log(`relaunched: pid=${child.pid} args=${JSON.stringify(plan.relaunchArgs)}`);
      log(`helper done: ${JSON.stringify({ relaunched: true, pid: child.pid })}`);
      return { relaunched: true, pid: child.pid };
    } catch (error) {
      log(`relaunch FAILED: ${error !== null && error !== undefined && error.stack ? error.stack : String(error)}`);
      log('helper done: {"relaunched":false,"reason":"spawn-failed"}');
      return { relaunched: false, reason: "spawn-failed" };
    }
  } catch (error) {
    log(`helper crashed: ${error !== null && error !== undefined && error.stack ? error.stack : String(error)}`);
    return { relaunched: false, reason: "crashed" };
  }
};

if (require.main === module) {
  const raw = process.argv[2];
  let plan;
  try {
    if (typeof raw !== "string" || raw === "") throw new TypeError("missing plan");
    plan = normalizePlan(raw);
  } catch {
    process.exit(2);
  }
  void run(plan);
}

module.exports = { normalizePlan, TIMING_LIMITS };
