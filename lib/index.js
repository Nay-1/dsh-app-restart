/**
 * dsh-app-restart — Host half.
 *
 * 把**整个 DSH 桌面应用**重启一遍（Electron 外壳 + Host 进程），让新装的插件、
 * 改过的 profile 配置真正生效 —— 也就是官方 README 里那句「改完必须重启 DSH」
 * 所做的事，只是不用手动退出再打开。
 *
 * 对外两个入口，共用同一条重启链路：
 *   - 斜杠命令 `/restart`：由 **client 半**注册成客户端贡献（原因见文件末尾的长注释：
 *     宿主命令拿不到 `/` 菜单的图标与中文名）；
 *   - HTTP：`/app-restart/api`（`status` / `log` / `restart`），命令打的就是它，
 *     手动排查也可以直接打。
 *
 * ---------------------------------------------------------------------------
 * 为什么是「杀外壳 + 重新拉起 exe」这一套
 * ---------------------------------------------------------------------------
 * 先把取证结论摆在这里，免得后人再挖一遍 app.asar（0.2.0-rc.2）：
 *
 *   1. 桌面端是「外壳 + Host」两个进程：外壳是 Electron 主进程
 *      （`DeepSeek Harness.exe`，持窗口/托盘/单实例锁），Host 是它用同一个 exe
 *      加 `ELECTRON_RUN_AS_NODE=1` 拉起来的子进程，跑
 *      `@deepseek-ai/dsh-desktop-host/lib/index.js`，固定 `--port 19387`。
 *   2. **官方没有给插件或前端留任何重启接口**。全 asar 只有两处 `app.relaunch()`，
 *      都在主进程里，而且都要人手点：崩溃恢复对话框（默认按钮就是「重启」）与
 *      **仅开发构建**才出现的菜单项「重启应用与 Host」。渲染进程的 IPC 通道表里
 *      没有 restart/quit，`window.dshDesktop` 也没有；宿主服务清单里没有
 *      lifecycle/supervisor，宿主只接受 `shutdown / quit-inspection / update-tasks`
 *      三种来信，没有「请外壳重启」这种消息。
 *   3. 宿主也不需要我们操心：外壳是用**非 detached** 的方式把它拉起来的，而 Node 在
 *      Windows 上会把这种子进程和父进程放进同一个 Job，**父进程一死子进程立刻被系统
 *      清掉**（实测：连 `SIGTERM` 处理函数和 `disconnect` 事件都来不及跑）。macOS /
 *      Linux 没有这个机制，但宿主自己写了 `process.once("disconnect", () => stop())`
 *      → `application.shutdown.shutdown(0)`，父进程一死它就走优雅停机。
 *      两条路都通向「宿主没了」，助手只需要确认。
 *
 * 于是重启流程是：打 `/restart`（或直接 POST 本路由）→ 本路由回包 → 拉一个分离的助手
 * 进程（同一个 exe + `ELECTRON_RUN_AS_NODE=1`，跑包内 `lib/relaunch-helper.cjs`）→
 * 助手等一小会儿（让回包落地）→ 终止外壳 → 宿主随之消失 →
 * 助手确认两个进程都没了 → 用干净环境重新拉起 `DeepSeek Harness.exe`。
 *
 *   ⚠️ 助手必须是 detached + unref 的：同一次实测表明，**普通子进程会随父进程一起
 *   被杀**，只有 detached 的子进程能活到「重新拉起应用」那一步。宿主正是那个要死的
 *   父进程，所以这一条是整套机制成立的前提。
 *
 * 这个顺序有一个很好的性质：**失败是安全的**。万一外壳杀不掉，助手直接放弃、
 * 什么都不拉起 —— 此时宿主还活着、界面照旧；绝不会出现「界面已经死了、新实例又被
 * 单实例锁挡回去」那种两头不靠的状态。
 *
 * 说清楚代价：重启会**打断正在跑的任务**（这是重启的定义，不是副作用），Windows 上
 * 宿主是被系统连带清掉的，所以拿不到「优雅停机」那一步 —— 会话日志是逐事件追加落盘的，
 * 丢数据的窗口和一次崩溃相当；要「先停干净再退出」的话，请用托盘/菜单里的正常退出。
 *
 * ---------------------------------------------------------------------------
 * 边界
 * ---------------------------------------------------------------------------
 *   - 只在真正的桌面 Host 里工作：判据是「进程连着外壳的 IPC 通道」+「入口是
 *     dsh-desktop-host」+「拿得到 ppid 与 exe 路径」，缺一条就明确拒绝，
 *     不去猜（`dsh web` 那种跑在终端里的 Host 当然不该被这条命令杀掉）。
 *   - 重启会中断正在跑的任务，所以命令是「自己明确打出来」才算数（没有二次确认的
 *     按钮可点）；这里只负责执行。
 *   - 路由不受 DSH 连接鉴权网关保护，因此写接口要求自定义头 + 同源校验，
 *     让浏览器里任意网页都发不出重启请求（详见 admitWrite）。
 *   - 重启过程的每一步都写日志（临时目录），出问题时用 `GET /log` 取日志尾巴。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-app-restart";

/** 只硬依赖 HTTP 服务；别的什么都不需要，取不到也不影响重启本身。 */
export const inject = ["webServer"];

const API_PREFIX = "/app-restart/api";
/** 分离式助手：随包发布，用 Electron 的 Node 模式跑（见 spawnHelper）。 */
const HELPER_PATH = fileURLToPath(new URL("./relaunch-helper.cjs", import.meta.url));
/** 每次重启一个运行目录（放日志）；只保留最近几次，免得临时目录长草。 */
const RUN_ROOT = join(tmpdir(), "dsh-app-restart");
const KEEP_RUNS = 5;
/** GET /log 最多吐多少字节。 */
const LOG_TAIL_BYTES = 12 * 1024;

/**
 * 与 client 半约定的调用头。理由与兄弟插件一致：插件的前缀路由不受 DSH 鉴权
 * 网关保护，而这个自定义头必然触发 CORS 预检，host 又不回 CORS 头 —— 于是浏览器里
 * 任意网页都发不出这个请求；同源 fetch 带自定义头不触发预检，照常工作。
 */
const CALL_HEADER = "x-dsh-plugin-call";
const CALL_HEADER_VALUE = "app-restart";

/**
 * 时间预算（毫秒）。都做了上下限钳制：这些值来自请求体/环境变量，
 * 不能让一次手滑的 `settleMs: 0` 变成「回包还没发出去就把外壳杀了」。
 */
const TIMING_LIMITS = {
  settleMs: { fallback: 1500, min: 300, max: 15000 },
  shellTimeoutMs: { fallback: 15000, min: 1000, max: 120000 },
  forceTimeoutMs: { fallback: 5000, min: 500, max: 60000 },
  hostTimeoutMs: { fallback: 20000, min: 1000, max: 120000 },
  quietMs: { fallback: 600, min: 100, max: 10000 }
};

const fail = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });

/** 数字钳制：非法值一律回落到默认值，不抛错（这几个参数不该成为拒绝重启的理由）。 */
const clampMs = (value, limits) => {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return limits.fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(number)));
};

const resolveTiming = (body) => {
  const picked = {};
  for (const [key, limits] of Object.entries(TIMING_LIMITS)) {
    const override = body?.[key] ?? process.env[`DSH_APP_RESTART_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`];
    picked[key] = clampMs(override, limits);
  }
  return picked;
};

/**
 * 「我现在是不是桌面 Host」——三个结构性判据，缺一条就认怂。
 *
 * 不去探测「父进程是不是 Electron」这种猜法：判据全部来自进程自身的事实，
 * 所以 `dsh web`（终端里跑的 Host，没有 IPC 通道）会被干净地拒掉，
 * 而不是把用户的终端或某个 supervisor 当成外壳杀掉。
 */
const inspectDesktopHost = () => {
  const entry = typeof process.argv[1] === "string" ? process.argv[1] : "";
  const execPath = typeof process.execPath === "string" ? process.execPath : "";
  const reasons = [];
  const ipcConnected = process.connected === true;
  const desktopEntry = /dsh-desktop-host[\\/]lib[\\/]index\.js$/i.test(entry);
  const shellPid = Number.isSafeInteger(process.ppid) && process.ppid > 1 ? process.ppid : null;
  if (!ipcConnected) reasons.push("宿主没有连着外壳的 IPC 通道，像是终端里直接跑的 dsh");
  if (!desktopEntry) reasons.push("宿主入口不是 @deepseek-ai/dsh-desktop-host");
  if (shellPid === null) reasons.push("取不到外壳进程号（process.ppid）");
  if (execPath === "" || !existsSync(execPath)) reasons.push("取不到可执行的 Electron 主程序（process.execPath）");
  return {
    supported: reasons.length === 0,
    reasons,
    shellPid,
    execPath,
    entry,
    ipcConnected
  };
};

/** 清掉历史运行目录，只留最近 KEEP_RUNS 个。 */
const pruneRuns = async () => {
  try {
    const entries = await readdir(RUN_ROOT, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - KEEP_RUNS))) {
      await rm(join(RUN_ROOT, name), { recursive: true, force: true });
    }
  } catch {
    /* 临时目录不存在/被占着都不该影响重启 */
  }
};

export function apply(ctx) {
  const info = (message) => ctx.logger?.info?.(`[app-restart] ${message}`);
  const warn = (message) => ctx.logger?.warn?.(`[app-restart] ${message}`);

  /** 一次只允许有一次重启在路上。 */
  const state = { restarting: false, startedAt: 0, logPath: undefined, helperPid: undefined };

  const send = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  };

  /**
   * 写接口的两道门：必须带约定的自定义头（跨站简单请求带不了自定义头，
   * 带了的又会先撞预检），且带 Origin 时 Origin 的 host 必须等于 Host。
   */
  const admitWrite = (req) => {
    if (req.headers?.[CALL_HEADER] !== CALL_HEADER_VALUE) return false;
    const origin = req.headers?.origin;
    if (origin === undefined || origin === "null") return true;
    try {
      return new URL(String(origin)).host === req.headers?.host;
    } catch {
      return false;
    }
  };

  /** 分离式助手：`execPath` 就是外壳那个 Electron 主程序，必须显式进 Node 模式。 */
  const spawnHelper = (plan) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    let child;
    try {
      child = spawn(plan.execPath, [HELPER_PATH, JSON.stringify(plan)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: plan.cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      });
    } catch (error) {
      finish(reject, error);
      return;
    }
    child.once("error", (error) => finish(reject, error));
    child.once("spawn", () => {
      child.unref();
      finish(resolve, child.pid);
    });
    // 极少数情况下 spawn 事件不来；别让一次点击永久吊在这儿。
    setTimeout(() => finish(resolve, child.pid), 2000).unref?.();
  });

  /** 请求体上限：这里只需要几个可选的时间参数。 */
  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 16 * 1024) throw fail("请求体过大", "bad-request");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const tailLog = async (logPath) => {
    try {
      const text = await readFile(logPath, "utf8");
      return text.length > LOG_TAIL_BYTES ? text.slice(text.length - LOG_TAIL_BYTES) : text;
    } catch {
      return undefined;
    }
  };

  const startRestart = async (body) => {
    const topology = inspectDesktopHost();
    if (!topology.supported) {
      throw fail(`当前进程不是 DSH 桌面端的 Host，不能重启桌面应用：${topology.reasons.join("；")}`, "unsupported");
    }
    if (state.restarting) throw fail("已经有一次重启在路上了", "busy");
    if (!existsSync(HELPER_PATH)) {
      throw fail(`插件包不完整：缺少 ${HELPER_PATH}`, "broken-package");
    }

    const timing = resolveTiming(body);
    const runDir = join(RUN_ROOT, `${Date.now()}-${process.pid}`);
    const logPath = join(runDir, "restart.log");
    /** 助手的全部输入；环境不走这里（助手用自己的 process.env，见 helper）。 */
    const plan = {
      hostPid: process.pid,
      shellPid: topology.shellPid,
      execPath: topology.execPath,
      cwd: dirname(topology.execPath),
      // 外壳只认 `--updated`（更新器交接用），用户级重启一律不带参数。
      relaunchArgs: [],
      logPath,
      runDir,
      requestedAt: new Date().toISOString(),
      ...timing
    };

    await mkdir(runDir, { recursive: true });
    await writeFile(logPath, [
      `[${plan.requestedAt}] app-restart requested`,
      `  host=${plan.hostPid} shell=${plan.shellPid}`,
      `  exec=${plan.execPath}`,
      `  timing=${JSON.stringify(timing)}`
    ].join("\n") + "\n", "utf8");

    const helperPid = await spawnHelper(plan);
    state.restarting = true;
    state.startedAt = Date.now();
    state.logPath = logPath;
    state.helperPid = helperPid;
    info(`重启已触发：helper=${helperPid} shell=${plan.shellPid} host=${plan.hostPid} log=${logPath}`);
    void pruneRuns();

    return {
      shellPid: plan.shellPid,
      hostPid: plan.hostPid,
      helperPid,
      execPath: plan.execPath,
      logPath,
      settleMs: timing.settleMs,
      /** 回包后多久可以判断「重启没生效」：过了这个点页面还活着，就说明外壳没被关掉。 */
      probeAfterMs: timing.settleMs + 6000
    };
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX)
          ? url.pathname.slice(API_PREFIX.length) || "/"
          : "/";

        if (req.method === "GET" && path === "/status") {
          const topology = inspectDesktopHost();
          const log = state.logPath === undefined ? undefined : await stat(state.logPath).catch(() => undefined);
          return send(res, 200, {
            ok: true,
            result: {
              mode: topology.supported ? "desktop" : "unsupported",
              supported: topology.supported,
              reasons: topology.reasons,
              shellPid: topology.shellPid,
              hostPid: process.pid,
              execPath: topology.execPath,
              restarting: state.restarting,
              startedAt: state.startedAt === 0 ? null : new Date(state.startedAt).toISOString(),
              logPath: state.logPath ?? null,
              logBytes: log === undefined ? 0 : log.size
            }
          });
        }

        if (req.method === "GET" && path === "/log") {
          if (state.logPath === undefined) return send(res, 404, { ok: false, error: "还没有重启记录" });
          const text = await tailLog(state.logPath);
          if (text === undefined) return send(res, 404, { ok: false, error: "日志文件读不到了" });
          return send(res, 200, { ok: true, result: { logPath: state.logPath, text } });
        }

        if (req.method !== "POST") {
          return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` });
        }
        if (!admitWrite(req)) return send(res, 403, { ok: false, error: "拒绝跨站写请求" });
        if (path !== "/restart") {
          return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` });
        }

        let body = {};
        const raw = await readBody(req);
        if (raw.trim() !== "") {
          try {
            body = JSON.parse(raw);
          } catch {
            return send(res, 400, { ok: false, error: "请求体不是合法 JSON" });
          }
        }
        return send(res, 200, { ok: true, result: await startRestart(body) });
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : undefined;
        const status = code === "unsupported" ? 409
          : code === "busy" ? 409
            : code === "broken-package" ? 500
              : code === "bad-request" ? 400
                : 500;
        warn(`api error: ${error?.message ?? error}`);
        return send(res, status, {
          ok: false,
          ...(code === undefined ? {} : { code }),
          error: error?.message ?? String(error)
        });
      }
    }
  }), "app-restart: http api");

  /* ------------------------------------------------------------------ *
   * 斜杠命令 `/restart` **不在这一半注册**。
   *
   * 踩过的坑，记在这儿免得以后又搬回来：`/` 菜单里的行长相是
   * `dsh-client-ui-commands` 的 `candidates()` 决定的 ——
   *
   *   for (const c of list) rows.push({ name: c.name, ...builtinRowFace(c, t) ?? { description: c.description } })
   *
   * 也就是说**宿主命令**那一行只能从内置表 `HOST_FACES`（写死的
   * compact / permission / plan / export / goal / feedback…）里拿到
   * `label + description + icon`；第三方宿主命令取不到 face，只能退回
   * 「命令名 + description」的素颜。而**客户端贡献**（`commandUi.register`）
   * 可以自己给 `label` / `description` / `icon` —— 内置的 `/file`、`/model`
   * 就是这么长的。
   *
   * 两条路还不能同时占 `restart` 这个名字：`candidates()` 先跑宿主目录，
   * 再遇到同名贡献会直接 throw（"contribution /restart collides with a host command"）。
   *
   * 所以命令统一由 client 半的贡献提供，走同一个 HTTP 接口（`POST /restart`）。
   * ------------------------------------------------------------------ */

  info(`已挂载 ${API_PREFIX}（重启助手：${HELPER_PATH}）`);
}
