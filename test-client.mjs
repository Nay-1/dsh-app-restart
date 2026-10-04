/**
 * dsh-app-restart — Client 半自测。
 *
 * 客户端这一半现在只做一件事：贡献 `/restart` 命令。所以这里盯的是
 * 「注册契约 + 菜单行长相 + 真的打出请求 + 失败要吵」这四件事，
 * 外加几条降级路径（没有 commandUi / 没有 t / 弹不出提示）。
 *
 * 用 mock 的 Module Loader / React / fetch / window 把它真的跑起来：
 * `require` 是严格的 —— 除了 `react`（模块基座）之外的任何 require 都会让测试当场红，
 * 这条正好钉住「不要把 Client 包当模块加载」这条插件规则。
 *
 * 运行：node test-client.mjs
 */

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

/* ---- mock 环境 ----------------------------------------------------------- */
const React = {
  Fragment: Symbol.for("react.fragment"),
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false && child !== true);
    const next = { ...(props ?? {}) };
    if (flat.length > 0) next.children = flat.length === 1 ? flat[0] : flat;
    return { __el: true, type, props: next };
  }
};

/** 严格的 require：只认基座里的 react。 */
const required = [];
const requireShim = (name) => {
  required.push(name);
  if (name === "react") return React;
  throw new Error(`unexpected require: ${name}`);
};

const alerts = [];
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { loaderSpec = spec; } },
  alert: (message) => { alerts.push(String(message)); }
};

/** 每次 fetch 的应答由这里决定，测试中途可以换。 */
let responder = async () => ({ status: 200, json: async () => ({ ok: true, result: { probeAfterMs: 7500 } }) });
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return responder(url, init);
};

/* ---- 加载 client 半 ------------------------------------------------------- */
let loaderSpec;
await import(new URL("./lib/client.js", import.meta.url).href);
check("Module Loader 收到注册调用", loaderSpec !== undefined);
check("loader id 与包名一致", loaderSpec?.id === "dsh-app-restart");

const mod = loaderSpec.factory(requireShim);
check("只从模块基座取 React", required.length === 1 && required[0] === "react", required.join(", "));
check("导出 apply", typeof mod.apply === "function");
check("inject 只硬依赖 locale", Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === "locale");

/* ---- 装起来 --------------------------------------------------------------- */
const localeRegistrations = [];
const locale = {
  register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }); },
  bind: (ns) => (key, params) => {
    const template = localeRegistrations.at(-1)?.dicts?.zh?.[key] ?? key;
    if (params === undefined) return template;
    return Object.keys(params).reduce((text, name) => text.split(`{${name}}`).join(String(params[name])), template);
  }
};

const injections = [];
const commandContributions = [];
const commandEffects = [];
let commandUiService = {
  register: (contribution) => {
    commandContributions.push(contribution);
    return () => {};
  }
};

const makeCtx = (overrides = {}) => ({
  effect: (fn) => fn(),
  locale,
  inject: (deps, callback) => {
    injections.push(deps);
    callback({
      get: (name) => (name === "commandUi" ? commandUiService : undefined),
      effect: (fn, label) => { const disposer = fn(); commandEffects.push(label); return disposer; }
    });
  },
  ...overrides
});

mod.apply(makeCtx());

check("注册了 zh/en 字典", localeRegistrations.length === 1
  && localeRegistrations[0].ns === "app-restart"
  && localeRegistrations[0].dicts.zh["menu.label"] === "重启"
  && typeof localeRegistrations[0].dicts.en["menu.label"] === "string");
check("字典里只有命令用得到的几条",
  Object.keys(localeRegistrations[0].dicts.zh).every((key) => key.startsWith("menu.") || key.startsWith("error.")));
check("没有注册任何 slot（界面零足迹）", !("slots" in mod.inject) && !/slots/.test(required.join(",")));
check("要了 commandUi 服务（scoped inject）", injections.length === 1 && injections[0][0] === "commandUi");
check("注册了一条命令贡献", commandContributions.length === 1);
check("在 scope.effect 里注册（可卸载）",
  commandEffects.length === 1 && commandEffects[0] === "app-restart: /restart command");

/* ---- 命令贡献的行长相 ----------------------------------------------------- */
console.log("\n[1] 命令贡献");

const command = commandContributions[0];
check("命令名是 restart", command?.name === "restart");
check("中文名是「重启」（菜单左侧那一栏）", command?.label?.() === "重启");
check("带一句说明（菜单右侧）", String(command?.description?.() ?? "").includes("重新拉起"));
check("label / description 是 thunk（切语言时重读）",
  typeof command?.label === "function" && typeof command?.description === "function");
check("available 是同步可判定的", command?.available?.({}) === true);
check("ui 是 action 型", command?.ui?.kind === "action" && typeof command?.ui?.run === "function");
check("图标给的是组件本身（不是 element）", typeof command?.icon === "function" && command.icon.__el === undefined);

/* ---- 图标：照抄 primitives 的那枚刷新箭头 --------------------------------- */
console.log("\n[2] 图标");

const icon = command.icon({});
check("是 16px 的 svg", icon?.type === "svg" && icon.props.width === 16 && icon.props.height === 16);
check("viewBox 与内置图标一致", icon?.props?.viewBox === "0 0 16 16");
check("按 1px 描边画（Regular 那一档）", icon?.props?.strokeWidth === 1);
check("对读屏隐藏", icon?.props?.["aria-hidden"] === "true");
const paths = (Array.isArray(icon?.props?.children) ? icon.props.children : [icon?.props?.children]);
check("两条 currentColor 路径（弧 + 箭头）", paths.length === 2
  && paths.every((path) => path?.type === "path" && path.props.stroke === "currentColor"));
check("路径数据与 primitives 逐字一致",
  String(paths[0]?.props?.d).startsWith("M14.5001 8C14.5 9.28552") && paths[1]?.props?.d === "M14.4999 1.5V5.1H10.8999");
check("size 可以被调用方覆盖", command.icon({ size: 20 })?.props?.width === 20);

/* ---- 真的能触发重启 ------------------------------------------------------- */
console.log("\n[3] /restart 的行为");

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

command.ui.run({});
await settle();
let restartCall = fetchCalls.at(-1);
check("run() 打出 POST /app-restart/api/restart",
  restartCall?.url === "/app-restart/api/restart" && restartCall?.init.method === "POST");
check("带上 JSON content-type", restartCall?.init.headers["content-type"] === "application/json");
check("带上调用头（跨站防线）", restartCall?.init.headers["x-dsh-plugin-call"] === "app-restart");
check("req body 是空对象（用宿主默认时间预算）", restartCall?.init.body === "{}");
check("成功时不打扰用户", alerts.length === 0);

responder = async () => ({ status: 200, json: async () => ({ ok: true, result: { probeAfterMs: 7500 } }) });
command.ui.run({});
command.ui.run({});
await settle();
check("菜单选中与回车两条路都走 run()（每次打一次请求）",
  fetchCalls.filter((call) => call.url === "/app-restart/api/restart").length === 3);

/* ---- 失败要吵 ------------------------------------------------------------- */
console.log("\n[4] 失败路径");

responder = async () => ({
  status: 409,
  json: async () => ({ ok: false, code: "unsupported", error: "当前进程不是 DSH 桌面端的 Host，不能重启桌面应用：宿主没有连着外壳的 IPC 通道" })
});
command.ui.run({});
await settle();
check("非桌面端时明确报错（不让用户以为重启了）",
  alerts.length === 1 && alerts[0].includes("重启失败") && alerts[0].includes("不是 DSH 桌面端的 Host"));
check("把宿主给的原因也带出来", alerts.at(-1)?.includes("IPC"));

responder = async () => ({
  status: 409,
  json: async () => ({ ok: false, code: "busy", error: "已经有一次重启在路上了" })
});
command.ui.run({});
await settle();
check("busy 也说清楚", alerts.at(-1)?.includes("已经有一次重启在路上了"));

// host 半没加载：路由不存在，回的不是 JSON。
responder = async () => ({ status: 404, json: async () => { throw new Error("not json"); } });
command.ui.run({});
await settle();
check("host 半缺席时报「接口没有响应」", alerts.at(-1)?.includes("重启接口没有响应"));

// 弹窗本身被挡（有些环境会抛）：不能变成未处理的 rejection。
const before = alerts.length;
globalThis.window.alert = () => { throw new Error("alert blocked"); };
responder = async () => ({ status: 500, json: async () => ({ ok: false, error: "boom" }) });
command.ui.run({});
await settle();
check("弹不出提示也不会炸（apply 之后照常活着）", alerts.length === before);

/* ---- 降级路径 ------------------------------------------------------------- */
console.log("\n[5] 降级路径");

// commandUi 取不到（profile 里没有 ui-commands）：插件照样要装得上。
commandUiService = undefined;
const beforeContributions = commandContributions.length;
mod.apply(makeCtx());
check("没有 commandUi 时不注册、也不抛错", commandContributions.length === beforeContributions);

// scope.get 直接抛（镸得更歪的宿主实现）。
mod.apply(makeCtx({ inject: (deps, callback) => callback({ get: () => { throw new Error("nope"); }, effect: (fn) => fn() }) }));
check("scope.get 抛错也只是不注册", commandContributions.length === beforeContributions);

// 连 ctx.inject 都没有。
let threw;
try {
  mod.apply({ effect: (fn) => fn(), locale });
  threw = false;
} catch (error) {
  threw = true;
  console.log(`    ${error?.message}`);
}
check("没有 ctx.inject 时 apply 不抛错", threw === false);

// 没有绑上 t：用内置中文。
commandUiService = {
  register: (contribution) => { commandContributions.push(contribution); return () => {}; }
};
mod.apply(makeCtx({ locale: { register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }); } } }));
const bare = commandContributions.at(-1);
check("绑不到 t 时菜单名还是中文", bare?.label?.() === "重启");
check("绑不到 t 时说明还是中文", String(bare?.description?.() ?? "").includes("重新拉起"));

/* ---- 重启之后的自查（probeAfterMs） --------------------------------------- *
 * 回包成功只代表「助手已经上路」：助手的外壳杀不掉时会走安全失败，那条路没有回包可等，
 * 「过了 probeAfterMs 这个界面居然还活着」就是它唯一的信号。这一节盯的是：
 * 认出来、把原因摆出来、还在路上时别急着下结论、问不到时别乱弹窗。
 * ------------------------------------------------------------------------ */
console.log("\n[6] 探测：回包成功 ≠ 重启成功");

// 第 4 节把 alert 换成了「一弹就抛」的替身（用来钉「弹不出提示也不能炸」），这里换回来。
globalThis.window.alert = (message) => { alerts.push(String(message)); };

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// 重新装一遍（这一份拿到的是能用的 locale 与 commandUi），后面都用它的 run()。
mod.apply(makeCtx());
const probed = commandContributions.at(-1);
check("重新装上的贡献可以触发", typeof probed?.ui?.run === "function");

/** 按 URL 分派的宿主应答：/restart 一律成功，/status 与 /log 交给每个用例。 */
const respond = (statusReply, logReply) => {
  const seen = { status: 0, log: 0 };
  responder = async (url) => {
    if (url.endsWith("/restart")) return { status: 200, json: async () => ({ ok: true, result: { probeAfterMs: 20 } }) };
    if (url.endsWith("/status")) { seen.status += 1; return statusReply(); }
    if (url.endsWith("/log")) { seen.log += 1; return logReply(); }
    return { status: 404, json: async () => ({ ok: false, error: `unexpected ${url}` }) };
  };
  return seen;
};
const okStatus = (result) => () => ({ status: 200, json: async () => ({ ok: true, result }) });
const okLog = (text) => () => ({ status: 200, json: async () => ({ ok: true, result: { logPath: "x", text } }) });

// 6a. 外壳没杀掉（助手走了 ABORT）→ 必须报，而且要把「为什么」带出来。
let alertsBefore = alerts.length;
const seenA = respond(
  okStatus({ restarting: false, helperAlive: false, previous: { outcome: "aborted" } }),
  okLog('[t] app-restart requested\n[t] terminate: SIGTERM -> shell 1234\n[t] ABORT: shell 1234 is still alive; nothing was relaunched and the app keeps running\n[t] helper done: {"relaunched":false,"reason":"shell-alive"}\n')
);
probed.ui.run({});
await waitFor(() => alerts.length > alertsBefore, 2000, "探测到没生效时弹窗");
check("界面还活着 + 宿主说没在路上 → 报「这次重启没有生效」", alerts.at(-1)?.includes("没有生效"));
check("把日志里「为什么没成」的那句（ABORT）带出来", alerts.at(-1)?.includes("ABORT: shell 1234 is still alive"));
check("探测打的是真接口：/status 一次 + /log 一次", seenA.status === 1 && seenA.log === 1);
check("失败提示仍然顶着「重启失败」的标题", alerts.at(-1)?.startsWith("重启失败"));

// 6b. 助手还在路上（外壳还没死）→ 不能急着说失败，要按 probeAfterMs 再看。
alertsBefore = alerts.length;
let rounds = 0;
respond(() => {
  rounds += 1;
  return { status: 200, json: async () => ({ ok: true, result: { restarting: rounds < 3 } }) };
}, okLog("[t] ABORT: shell 9 is still alive\n"));
probed.ui.run({});
await waitFor(() => alerts.length > alertsBefore, 2000, "第三轮才判定");
check("还在路上时继续等（问了 3 次 /status，不是一次就下结论）", rounds === 3);
check("最终确实没生效 → 照样报出来", alerts.at(-1)?.includes("没有生效") && alerts.at(-1)?.includes("ABORT: shell 9"));

// 6c. 探测期接口整个问不到（宿主已经换了一茬）→ 一声不吭。
alertsBefore = alerts.length;
responder = async (url) => {
  if (url.endsWith("/restart")) return { status: 200, json: async () => ({ ok: true, result: { probeAfterMs: 20 } }) };
  throw new Error("ECONNREFUSED");
};
probed.ui.run({});
await new Promise((resolve) => setTimeout(resolve, 150));
check("探测时接口问不到 → 不打扰用户，也不炸", alerts.length === alertsBefore);

// 6d. 日志读不到（404 / 不是 JSON）→ 仍然要报「没生效」，只是没有尾巴。
alertsBefore = alerts.length;
respond(okStatus({ restarting: false }), () => ({ status: 404, json: async () => { throw new Error("not json"); } }));
probed.ui.run({});
await waitFor(() => alerts.length > alertsBefore, 2000, "没有日志也要报");
check("日志读不到时只说「没生效」，不编造尾巴",
  alerts.at(-1)?.includes("没有生效") && !alerts.at(-1)?.includes("宿主日志末尾"));

// 6e. 宿主没给 probeAfterMs → 用兜底间隔，绝不立刻误报。
alertsBefore = alerts.length;
let fallbackCalls = 0;
responder = async (url) => {
  if (url.endsWith("/restart")) return { status: 200, json: async () => ({ ok: true, result: {} }) };
  fallbackCalls += 1;
  return { status: 200, json: async () => ({ ok: true, result: {} }) };
};
probed.ui.run({});
await new Promise((resolve) => setTimeout(resolve, 150));
check("宿主没给 probeAfterMs 时用兜底间隔（不会立刻误报，也不会去问接口）",
  alerts.length === alertsBefore && fallbackCalls === 0);

console.log(`\n${failed === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${failed} 失败`);
process.exitCode = failed === 0 ? 0 : 1;
