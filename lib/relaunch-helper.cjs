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
 *   1. 静默 settleMs —— 让 HTTP 回包和前端「正在重启…」先落地；
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
 * 日志：`plan.logPath`（宿主编的临时目录）。助手不删日志，方便事后排查。
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");

const rawPlan = process.argv[2];
if (typeof rawPlan !== "string" || rawPlan === "") {
  process.exitCode = 2;
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(rawPlan);
} catch {
  process.exitCode = 2;
  process.exit(2);
}

const log = (message) => {
  try {
    fs.appendFileSync(plan.logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* 日志写不进去也不能让重启停下 */
  }
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

const terminate = (pid, label) => {
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

/** 等进程消失；返回是否确实没了。 */
const waitGone = async (pid, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(pid)) {
      log(`gone: ${label} ${pid}`);
      return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(120);
  }
};

const relaunch = () => {
  const env = { ...process.env };
  // 关键：新进程必须是「桌面应用」，不能是「Node 模式进程」。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_DESKTOP_NODE_EXECUTABLE;
  const child = spawn(plan.execPath, Array.isArray(plan.relaunchArgs) ? plan.relaunchArgs : [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    cwd: plan.cwd,
    env
  });
  child.unref();
  return child;
};

const main = async () => {
  log(`helper start: pid=${process.pid} host=${plan.hostPid} shell=${plan.shellPid} exec=${plan.execPath}`);
  log(`timing: ${JSON.stringify({
    settleMs: plan.settleMs,
    shellTimeoutMs: plan.shellTimeoutMs,
    forceTimeoutMs: plan.forceTimeoutMs,
    hostTimeoutMs: plan.hostTimeoutMs,
    quietMs: plan.quietMs
  })}`);

  // 1. 先让回包飞一会儿。
  await sleep(plan.settleMs);

  // 2. 外壳。
  if (!alive(plan.shellPid)) {
    log(`shell ${plan.shellPid} already gone; continuing`);
  } else {
    terminate(plan.shellPid, "shell");
    let gone = await waitGone(plan.shellPid, plan.shellTimeoutMs, "shell");
    if (!gone) {
      log("shell survived the first SIGTERM; sending another");
      terminate(plan.shellPid, "shell");
      gone = await waitGone(plan.shellPid, plan.forceTimeoutMs, "shell");
    }
    if (!gone) {
      // 安全失败：宿主还活着、界面照旧，什么都不拉起。
      log(`ABORT: shell ${plan.shellPid} is still alive; nothing was relaunched and the app keeps running`);
      return { relaunched: false, reason: "shell-alive" };
    }
  }

  // 3. 宿主：Windows 上它已经跟着外壳一起被系统清掉了；其它平台它自己优雅退出。
  if (await waitGone(plan.hostPid, plan.hostTimeoutMs, "host")) {
    log("host stopped without force");
  } else {
    log("host did not stop on its own; terminating it");
    terminate(plan.hostPid, "host");
    if (!await waitGone(plan.hostPid, plan.forceTimeoutMs, "host")) {
      log(`WARN: host ${plan.hostPid} is still alive; relaunching anyway (the new instance may hit the single-instance lock)`);
    }
  }

  // 4. 端口与锁文件落地。
  await sleep(plan.quietMs);

  // 5. 重新拉起桌面应用。
  try {
    const child = relaunch();
    log(`relaunched: pid=${child.pid} args=${JSON.stringify(plan.relaunchArgs ?? [])}`);
    return { relaunched: true, pid: child.pid };
  } catch (error) {
    log(`relaunch FAILED: ${error !== null && error !== undefined && error.stack ? error.stack : String(error)}`);
    return { relaunched: false, reason: "spawn-failed" };
  }
};

main().then((outcome) => {
  log(`helper done: ${JSON.stringify(outcome)}`);
}).catch((error) => {
  log(`helper crashed: ${error !== null && error !== undefined && error.stack ? error.stack : String(error)}`);
});
