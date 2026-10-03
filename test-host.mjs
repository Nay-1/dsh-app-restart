/**
 * dsh-app-restart — Host 半自测。
 *
 * 三块：
 *   1. **注册契约**：cordis 插件形状、前缀路由、只依赖 webServer。
 *   2. **API 行为**：状态查询、跨站防线、非桌面宿主时的明确拒绝、日志端点。
 *   3. **重启助手真跑一遍**（重点）：用两个一次性的替身进程模拟「外壳 + 宿主」，
 *      其中替身宿主和真宿主一样监听 `disconnect` 事件然后自己退出 —— 于是这条
 *      「杀外壳 → 宿主优雅退出 → 重新拉起」的链路是被真的执行过的，不是读代码
 *      猜出来的。另有一条「外壳杀不掉就放弃」的安全失败用例。
 *
 * 替身进程都是本测试自己拉起来的 node，做完就收；不会碰到真正运行中的 DSH。
 *
 * 运行：node test-host.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

let pass = 0;
let failed = 0;
const check = (label, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${extra === undefined ? "" : ` -> ${extra}`}`);
  }
};

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const helperPath = join(packageDir, "lib", "relaunch-helper.cjs");

/* ------------------------------------------------------------------------ *
 * 1. 注册契约
 * ------------------------------------------------------------------------ */
console.log("\n[1] 注册契约");

const routes = [];
const effects = [];
const commands = [];
const warnings = [];
const ctx = {
  logger: { info: () => {}, warn: (message) => { warnings.push(String(message)); } },
  effect: (install, label) => {
    const disposer = install();
    effects.push({ label, disposer });
    return disposer;
  },
  webServer: {
    register: (route) => {
      routes.push(route);
      return () => {};
    }
  },
  commands: {
    register: (definition) => {
      commands.push(definition);
      return () => {};
    }
  }
};

const mod = await import(new URL("./lib/index.js", import.meta.url).href);
check("插件名与包名一致", mod.name === "dsh-app-restart");
check("inject 只硬依赖 webServer", Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === "webServer");
check("导出 apply", typeof mod.apply === "function");

mod.apply(ctx);
check("注册了一条路由", routes.length === 1);
check("是前缀路由 /app-restart/api", routes[0]?.kind === "prefix" && routes[0]?.path === "/app-restart/api");
check("handler 是函数", typeof routes[0]?.handler === "function");
check("路由与命令都在 ctx.effect 里注册（可卸载）",
  effects.length === 2 && effects.every((entry) => typeof entry.disposer === "function"));
check("助手文件随包发布", existsSync(helperPath));

/* ------------------------------------------------------------------------ *
 * 1b. 斜杠命令 /restart
 * ------------------------------------------------------------------------ */
console.log("\n[1b] 斜杠命令");

check("注册了一条命令", commands.length === 1);
check("命令名是 restart", commands[0]?.name === "restart");
check("命令有给用户看的说明", typeof commands[0]?.description === "string" && commands[0].description.length > 0);
check("命令不带 definitionId（可选字段，不硬造）", commands[0]?.definitionId === undefined);
check("handler 是函数", typeof commands[0]?.handler === "function");
check("没有多余的告警", warnings.length === 0);

// 在测试进程里它不是桌面宿主，所以命令应当结结实实地报错、而不是假装成功。
const commandResult = await commands[0].handler({ rawInput: "" });
check("非桌面宿主时命令返回 error（不是 success）", commandResult?.kind === "error", JSON.stringify(commandResult));
check("错误文案说明了原因", String(commandResult?.text ?? "").includes("桌面端"));
check("失败的命令没有偷偷触发重启", commands.length === 1 && effects.every((entry) => entry.label !== "restart"));

// commands 服务缺席：插件必须照样装得上（HTTP 接口和按钮不能跟着一起没）。
const bareRoutes = [];
const bareWarnings = [];
const bareEffects = [];
mod.apply({
  logger: { info: () => {}, warn: (message) => bareWarnings.push(String(message)) },
  effect: (install, label) => { bareEffects.push(label); return install(); },
  webServer: { register: (route) => { bareRoutes.push(route); return () => {}; } }
});
check("没有 commands 服务时仍然挂上 HTTP 路由", bareRoutes.length === 1);
check("没有 commands 服务时只注册了路由这一条 effect", bareEffects.length === 1);
check("并且明确告警说跳过了命令", bareWarnings.some((line) => line.includes("commands")));

/* ------------------------------------------------------------------------ *
 * 2. API 行为
 * ------------------------------------------------------------------------ */
console.log("\n[2] HTTP API");

const HEADER = { "x-dsh-plugin-call": "app-restart" };

/** 用最小 req/res 打这个 handler（req 要能被 for await 消费，所以是 Readable）。 */
const request = async (method, path, { headers = {}, body = "" } = {}) => {
  const req = Readable.from(body === "" ? [] : [Buffer.from(body, "utf8")]);
  req.method = method;
  req.url = path;
  req.headers = headers;
  const captured = { status: 0, body: "" };
  const res = {
    writeHead: (status) => { captured.status = status; },
    end: (text) => { captured.body = text ?? ""; }
  };
  await routes[0].handler(req, res);
  return { status: captured.status, json: captured.body === "" ? undefined : JSON.parse(captured.body) };
};

const status = await request("GET", "/app-restart/api/status", { headers: HEADER });
check("GET /status 返回 200", status.status === 200 && status.json?.ok === true);
check("测试进程不是桌面宿主 → supported=false", status.json?.result?.supported === false);
check("模式标成 unsupported", status.json?.result?.mode === "unsupported");
check("拒绝理由里点明缺 IPC 通道", (status.json?.result?.reasons ?? []).some((line) => line.includes("IPC")));
check("状态里带上宿主 pid", status.json?.result?.hostPid === process.pid);

const noLog = await request("GET", "/app-restart/api/log", { headers: HEADER });
check("还没有重启记录时 /log 是 404", noLog.status === 404 && noLog.json?.ok === false);

const unknown = await request("GET", "/app-restart/api/nope", { headers: HEADER });
check("未知路径 404", unknown.status === 404);

const noHeader = await request("POST", "/app-restart/api/restart", { body: "{}" });
check("缺自定义头 → 403（跨站写请求发不出来）", noHeader.status === 403);

const crossOrigin = await request("POST", "/app-restart/api/restart", {
  headers: { ...HEADER, origin: "http://evil.example", host: "127.0.0.1:19387" },
  body: "{}"
});
check("Origin 与 Host 不一致 → 403", crossOrigin.status === 403);

const sameOrigin = await request("POST", "/app-restart/api/restart", {
  headers: { ...HEADER, origin: "http://127.0.0.1:19387", host: "127.0.0.1:19387" },
  body: "{}"
});
check("同源 POST 放行到业务逻辑（这里因非桌面宿主而 409）", sameOrigin.status === 409, JSON.stringify(sameOrigin.json));
check("拒绝理由说得明白", String(sameOrigin.json?.error ?? "").includes("桌面端"));

const badJson = await request("POST", "/app-restart/api/restart", { headers: HEADER, body: "{not json" });
check("请求体不是 JSON → 400", badJson.status === 400);

/* ------------------------------------------------------------------------ *
 * 3. 重启助手端到端
 * ------------------------------------------------------------------------ */
console.log("\n[3] 重启助手端到端（替身进程）");

const workDir = join(tmpdir(), `dsh-app-restart-test-${process.pid}-${Date.now()}`);
mkdirSync(workDir, { recursive: true });
const tracking = { procs: [], dirs: [workDir] };

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};

/** 跑一次助手，等它自己结束，返回日志文本。 */
const runHelper = async (plan) => {
  const child = spawn(process.execPath, [helperPath, JSON.stringify(plan)], { stdio: "ignore" });
  tracking.procs.push(child.pid);
  const code = await new Promise((resolve) => { child.once("exit", (value) => resolve(value)); });
  const text = existsSync(plan.logPath) ? readFileSync(plan.logPath, "utf8") : "";
  return { code, text };
};

try {
  /* --- 3a. 正常路径 ----------------------------------------------------- */
  const logPath = join(workDir, "restart.log");
  const markerPath = join(workDir, "marker.json");
  const hostPidPath = join(workDir, "host.pid");
  const gracefulPath = join(workDir, "graceful.txt");

  // 替身宿主：和真宿主一样，EPC 断开就自己退出（真宿主还多一步优雅停机）。
  const hostCode = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(hostPidPath)}, String(process.pid));
process.on("disconnect", () => { fs.writeFileSync(${JSON.stringify(gracefulPath)}, "disconnect"); process.exit(0); });
setInterval(() => {}, 1000);
`;
  // 替身外壳：拉起替身宿主（带 IPC 通道），自己一直活着。
  const shellCode = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(hostCode)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
setInterval(() => {}, 1000);
`;
  // 「重新拉起」的目标：这里用 node 写一个标记文件，检查环境有没有被洗干净。
  const markerCode = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  desktopNode: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? null,
  cwd: process.cwd()
}));
`;

  const shell = spawn(process.execPath, ["-e", shellCode], { stdio: "ignore" });
  tracking.procs.push(shell.pid);
  await waitFor(() => existsSync(hostPidPath), 6000, "替身宿主上报 pid");
  const hostPid = Number(readFileSync(hostPidPath, "utf8"));
  check("替身外壳与替身宿主都起来了", alive(shell.pid) && alive(hostPid));

  const started = Date.now();
  const normal = await runHelper({
    hostPid,
    shellPid: shell.pid,
    execPath: process.execPath,
    cwd: workDir,
    relaunchArgs: ["-e", markerCode],
    logPath,
    runDir: workDir,
    settleMs: 300,
    shellTimeoutMs: 5000,
    forceTimeoutMs: 1000,
    hostTimeoutMs: 8000,
    quietMs: 150
  });
  const elapsed = Date.now() - started;

  check("助手正常退出", normal.code === 0, `exit=${normal.code}`);
  check("日志里记下了终止外壳", normal.text.includes("terminate: SIGTERM -> shell"));
  check("日志里确认外壳已消失", normal.text.includes("gone: shell"));
  check("日志里确认宿主也没了，而且根本没轮到补刀", normal.text.includes("host stopped without force")
    && !normal.text.includes("host did not stop on its own"));
  check("日志里记下了重新拉起", /relaunched: pid=\d+/.test(normal.text));
  check("日志收尾是成功", normal.text.includes('"relaunched":true'));
  check("外壳真的没了", !alive(shell.pid));
  check("宿主进程真的没了（不留孤儿）", !alive(hostPid));
  if (process.platform === "win32") {
    // 这条断言钉住的是一个**实测事实**，不是实现细节：Windows 上非 detached 的子进程
    // 和父进程同属一个 Job，父进程被 TerminateProcess 之后子进程立刻被系统清掉，
    // 连处理 SIGTERM / disconnect 的机会都没有 —— 生产环境里的真宿主就是这么没的。
    // 也正因为如此，助手必须自己是 detached 的（见 3d）。
    check("Windows：替身宿主随外壳一起被系统清掉，没机会跑 disconnect", !existsSync(gracefulPath));
  } else {
    check("POSIX：替身宿主收到 IPC 断开，自己走优雅退出", existsSync(gracefulPath));
  }
  check("助手确实等了 settleMs 才开始动手", elapsed >= 300, `${elapsed}ms`);

  await waitFor(() => existsSync(markerPath), 4000, "重新拉起的进程写出标记");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  check("重新拉起的进程剥掉了 ELECTRON_RUN_AS_NODE", marker.runAsNode === null, JSON.stringify(marker));
  check("重新拉起的进程还剥掉了 DSH_DESKTOP_NODE_EXECUTABLE", marker.desktopNode === null);
  check("重新拉起的工作目录是计划里那个", marker.cwd.toLowerCase() === workDir.toLowerCase());

  const order = [normal.text.indexOf("gone: shell"), normal.text.indexOf("host stopped without force")];
  check("顺序正确：先确认外壳没了，再等宿主退出", order[0] >= 0 && order[1] > order[0]);

  /* --- 3b. 外壳已经不在：照样继续 --------------------------------------- */
  const deadShell = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((resolve) => { deadShell.once("exit", resolve); });
  const log2 = join(workDir, "restart-2.log");
  const marker2 = join(workDir, "marker-2.json");
  const host2PidPath = join(workDir, "host2.pid");
  const host2Code = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(host2PidPath)}, String(process.pid));
process.on("disconnect", () => process.exit(0));
setInterval(() => {}, 1000);
`;
  const shell2 = spawn(process.execPath, ["-e", `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(host2Code)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
setInterval(() => {}, 1000);
`], { stdio: "ignore" });
  tracking.procs.push(shell2.pid);
  await waitFor(() => existsSync(host2PidPath), 6000, "第二个替身宿主上报 pid");
  const host2Pid = Number(readFileSync(host2PidPath, "utf8"));
  const second = await runHelper({
    hostPid: host2Pid,
    // 这个 pid 早就退出了：助手应当识别出来、不报错地继续。
    shellPid: deadShell.pid,
    execPath: process.execPath,
    cwd: workDir,
    relaunchArgs: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker2)}, "ok")`],
    logPath: log2,
    runDir: workDir,
    settleMs: 300,
    // 短一点：这里顺手把「宿主没有自己退出 → 补一刀」那条分支也跑到。
    shellTimeoutMs: 2000,
    forceTimeoutMs: 500,
    hostTimeoutMs: 1500,
    quietMs: 100
  });
  check("外壳早就没了也不报错，直接继续", second.text.includes("already gone; continuing"));
  check("宿主没有自己退出时会被补刀，日志里说清楚", second.text.includes("host did not stop on its own"));
  await waitFor(() => existsSync(marker2), 4000, "第二次重新拉起写出标记");
  check("第二次也把应用拉起来了", second.text.includes('"relaunched":true'));
  check("补刀之后宿主确实没了", !alive(host2Pid));

  /* --- 3c. 外壳杀不掉 → 安全失败 ---------------------------------------- */
  let unkillablePid;
  try {
    process.kill(4, 0);
    // PID 4 可杀 = 不是 Windows 的 System 进程，别拿它做这个实验。
  } catch (error) {
    if (error?.code === "EPERM") unkillablePid = 4;
  }
  if (unkillablePid === undefined) {
    console.log("  skip 外壳杀不掉的安全失败用例（拿不到一个必定 EPERM 的进程号）");
  } else {
    const log3 = join(workDir, "restart-3.log");
    const marker3 = join(workDir, "marker-3.json");
    const bystanderPath = join(workDir, "bystander.pid");
    const bystander = spawn(process.execPath, ["-e", `
require("node:fs").writeFileSync(${JSON.stringify(bystanderPath)}, String(process.pid));
setInterval(() => {}, 1000);
`], { stdio: "ignore" });
    tracking.procs.push(bystander.pid);
    await waitFor(() => existsSync(bystanderPath), 6000, "旁观进程起来");
    const bystanderPid = Number(readFileSync(bystanderPath, "utf8"));

    const aborted = await runHelper({
      hostPid: bystanderPid,
      shellPid: unkillablePid,
      execPath: process.execPath,
      cwd: workDir,
      relaunchArgs: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker3)}, "ok")`],
      logPath: log3,
      runDir: workDir,
      settleMs: 300,
      shellTimeoutMs: 500,
      forceTimeoutMs: 300,
      hostTimeoutMs: 2000,
      quietMs: 100
    });
    check("外壳杀不掉 → 明确放弃（ABORT）", aborted.text.includes("ABORT"));
    check("放弃时不拉起任何东西", !existsSync(marker3));
    check("放弃时宿主原样活着（界面不会变砖）", alive(bystanderPid));
    check("日志里说清了为什么", aborted.text.includes("still alive"));
  }
  /* --- 3d. 助手必须活得过「拉起它的宿主」 -------------------------------- */
  // host 半是用 detached + unref 拉助手的。少写 detached 会怎样？上面 3a 已经顺带
  // 证明了：普通子进程会跟着父进程一起被系统清掉，「重新拉起应用」永远跑不到。
  // 这个用例把那个前提单独钉一遍：让替身宿主拉起助手后**立刻自己去死**，
  // 助手仍然要把应用拉起来。
  const log4 = join(workDir, "restart-4.log");
  const marker4 = join(workDir, "marker-4.json");
  const orphanPlan = {
    hostPid: deadShell.pid,
    shellPid: deadShell.pid,
    execPath: process.execPath,
    cwd: workDir,
    relaunchArgs: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker4)}, "ok")`],
    logPath: log4,
    runDir: workDir,
    settleMs: 300,
    shellTimeoutMs: 1000,
    forceTimeoutMs: 300,
    hostTimeoutMs: 1000,
    quietMs: 100
  };
  // 这段就是 host 半 spawnHelper 的形状（detached + unref + ELECTRON_RUN_AS_NODE）。
  const spawnerCode = `
const { spawn } = require("node:child_process");
const input = JSON.parse(process.argv[1]);
const child = spawn(input.execPath, [input.helperPath, JSON.stringify(input.plan)], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  cwd: input.plan.cwd,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
});
child.unref();
`;
  const spawner = spawn(process.execPath, ["-e", spawnerCode, JSON.stringify({
    helperPath,
    execPath: process.execPath,
    plan: orphanPlan
  })], { stdio: "ignore" });
  tracking.procs.push(spawner.pid);
  await new Promise((resolve) => { spawner.once("exit", resolve); });
  check("替身宿主拉起助手后自己先退了", !alive(spawner.pid));
  await waitFor(() => existsSync(marker4), 8000, "宿主死后助手把应用拉起来");
  check("宿主已经不在，助手照样完成了重新拉起", existsSync(marker4));
  check("日志收尾同样是成功", readFileSync(log4, "utf8").includes('"relaunched":true'));
  /* --- 3e. 生产拓扑：外壳 → 宿主 → 助手（助手要活过整条链） --------------- */
  // 这是插件成立的前提，单独钉一遍：外壳非 detached 拉起宿主（和真外壳一样），
  // 宿主 detached 拉起助手（和 host 半一样），然后杀掉外壳。Windows 上宿主会跟着
  // 外壳一起被系统清掉，而助手必须活下来把应用重新拉起来 —— 少了 detached，
  // 助手会被同一个 Job 一起带走，「重新拉起」永远跑不到。
  const log5 = join(workDir, "restart-5.log");
  const marker5 = join(workDir, "marker-5.json");
  const host5PidPath = join(workDir, "host5.pid");
  const host5Code = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const plan = {
  hostPid: process.pid,
  shellPid: process.ppid,
  execPath: ${JSON.stringify(process.execPath)},
  cwd: ${JSON.stringify(workDir)},
  relaunchArgs: ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker5)}, "ok")`)}],
  logPath: ${JSON.stringify(log5)},
  runDir: ${JSON.stringify(workDir)},
  settleMs: 400,
  shellTimeoutMs: 3000,
  forceTimeoutMs: 500,
  hostTimeoutMs: 3000,
  quietMs: 100
};
fs.writeFileSync(${JSON.stringify(host5PidPath)}, String(process.pid));
const child = spawn(plan.execPath, [${JSON.stringify(helperPath)}, JSON.stringify(plan)], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  cwd: plan.cwd,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
});
child.unref();
fs.appendFileSync(${JSON.stringify(log5)}, "dummy host spawned helper pid=" + child.pid + "\\n");
setInterval(() => {}, 1000);
`;
  const shell5 = spawn(process.execPath, ["-e", `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(host5Code)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
setInterval(() => {}, 1000);
`], { stdio: "ignore" });
  tracking.procs.push(shell5.pid);
  await waitFor(() => existsSync(host5PidPath) && existsSync(log5), 8000, "生产拓扑准备好");
  const host5Pid = Number(readFileSync(host5PidPath, "utf8"));
  await waitFor(() => readFileSync(log5, "utf8").includes("spawned helper"), 4000, "助手已被拉起");
  check("生产拓扑就位：外壳 → 宿主 → 助手", alive(shell5.pid) && alive(host5Pid));

  // 杀掉外壳：宿主会跟着没，助手必须活着把应用拉起来。
  try { process.kill(shell5.pid, "SIGTERM"); } catch { /* ignore */ }
  await waitFor(() => existsSync(marker5), 10000, "外壳死后助手完成重新拉起");
  check("外壳死后，助手仍然把应用拉起来了", existsSync(marker5));
  check("宿主跟着外壳一起没了（不留孤儿）", !alive(host5Pid));
  check("日志收尾成功", readFileSync(log5, "utf8").includes('"relaunched":true'));
} finally {
  for (const pid of tracking.procs.reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch { /* 已经没了 */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const dir of tracking.dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* 忽略 */ }
  }
}

console.log(`\n${failed === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${failed} 失败`);
process.exitCode = failed === 0 ? 0 : 1;
