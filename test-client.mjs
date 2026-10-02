/**
 * dsh-app-restart — Client 半自测。
 *
 * 用 mock 的 Module Loader / React 运行时 / primitives / fetch / document 把客户端
 * 插件真的跑起来：注册契约、宽窄两种形态、二次确认、重启请求、看门狗、失败与
 * 「不支持」的降级路径，以及 primitives 缺件时的兜底，都过一遍。
 *
 * 迷你 React 运行时支持这个组件真正用到的 hook（useState / useEffect / useRef），
 * 并按依赖数组判断要不要重跑 effect —— 所以「点按钮 → 确认 → 发请求 → 变成正在重启」
 * 这条链路是真的被跑到的，不是手工塞 state 装出来的。
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

/* ---- 迷你 React 运行时 --------------------------------------------------- */
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((value, index) => value === b[index]);

let hooks = [];
let cursor = 0;
let pendingEffects = [];
let dirty = false;

const React = {
  Fragment: Symbol.for("react.fragment"),
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false && child !== true);
    const next = { ...(props ?? {}) };
    if (flat.length > 0) next.children = flat.length === 1 ? flat[0] : flat;
    return { __el: true, type, props: next };
  },
  useState(initial) {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
    const set = (value) => {
      const next = typeof value === "function" ? value(hooks[index]) : value;
      if (next === hooks[index]) return;
      hooks[index] = next;
      dirty = true;
    };
    return [hooks[index], set];
  },
  useEffect(fn, deps) {
    const index = cursor++;
    const previous = hooks[index];
    if (previous === undefined || !sameDeps(previous.deps, deps)) pendingEffects.push(fn);
    hooks[index] = { deps };
  },
  useRef(value) {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = { current: value };
    return hooks[index];
  }
};

/** 挂一个组件实例：render() 渲染 + 冲 effects + 必要时重渲染。 */
const mount = (Component, props) => {
  const self = {
    hooks: [],
    tree: null,
    render() {
      for (let round = 0; round < 40; round += 1) {
        hooks = self.hooks;
        cursor = 0;
        pendingEffects = [];
        dirty = false;
        self.tree = Component(props);
        const effects = pendingEffects;
        pendingEffects = [];
        for (const effect of effects) effect();
        if (!dirty) return self.tree;
      }
      throw new Error("渲染没有收敛：effect 一直在改状态");
    },
    /** 等异步链路（fetch/定时器）落定，并在状态变化后重渲染。 */
    async settle(rounds = 12) {
      for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (dirty || pendingEffects.length > 0) self.render();
      }
      return self.tree;
    }
  };
  return self;
};

/* ---- 元素树工具 ---------------------------------------------------------- */
const childrenOf = (node) => {
  if (node === null || node === undefined || node.__el !== true) return [];
  const kids = node.props?.children;
  if (kids === undefined || kids === null || kids === false) return [];
  return Array.isArray(kids) ? kids.filter((kid) => kid !== null && kid !== undefined) : [kids];
};

const findAll = (node, predicate, found = []) => {
  if (node === null || node === undefined || node.__el !== true) return found;
  if (predicate(node)) found.push(node);
  for (const kid of childrenOf(node)) findAll(kid, predicate, found);
  return found;
};

const texts = (node) => findAll(node, () => false).length === 0 && typeof node === "string"
  ? [node]
  : (() => {
    const out = [];
    const visit = (value) => {
      if (typeof value === "string") out.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value !== null && typeof value === "object" && value.__el === true) childrenOf(value).forEach(visit);
    };
    visit(node);
    return out;
  })();

const byText = (node, needle) => texts(node).some((text) => text.includes(needle));

/* ---- mock 环境 ----------------------------------------------------------- */
let loaderSpec;
const registered = [];
const injectedSlots = [];
const localeRegistrations = [];
const styleTags = [];
const fetchCalls = [];

globalThis.window = { __ModuleLoader__: { load: (spec) => { loaderSpec = spec; } } };
globalThis.document = {
  head: {
    appendChild: (tag) => { styleTags.push(tag); },
    removeChild: () => {}
  },
  createElement: () => ({ dataset: {}, remove: () => {} }),
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {}
};

/** 每次 fetch 的应答由这里决定，测试中途可以换。 */
let responder = async () => ({ status: 200, json: async () => ({ ok: true, result: { supported: true, mode: "desktop" } }) });
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return responder(url, init);
};

const IconRefreshOutlineRegular = function IconRefreshOutlineRegular() {};
const Tooltip = function Tooltip() {};
const Modal = function Modal() {};
const Button = function Button() {};

let primitivesOverride;
const requireShim = (name) => {
  if (name === "react") return React;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") {
    if (primitivesOverride !== undefined) return primitivesOverride;
    return { IconRefreshOutlineRegular, Tooltip, Modal, Button };
  }
  throw new Error(`unexpected require: ${name}`);
};

/* ---- 加载 client 半 ------------------------------------------------------- */
await import(new URL("./lib/client.js", import.meta.url).href);
check("Module Loader 收到注册调用", loaderSpec !== undefined);
check("loader id 与包名一致", loaderSpec?.id === "dsh-app-restart");

const mod = loaderSpec.factory(requireShim);
check("导出 apply", typeof mod.apply === "function");
check("导出 inject（slots / locale）",
  Array.isArray(mod.inject) && ["slots", "locale"].every((key) => mod.inject.includes(key)));

/* ---- 应用 ---------------------------------------------------------------- */
const ctx = {
  effect: (fn) => { const disposer = fn(); return disposer; },
  locale: {
    register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }); },
    bind: (ns) => (key, params) => {
      const template = localeRegistrations.at(-1)?.dicts?.zh?.[key] ?? key;
      if (params === undefined) return template;
      return Object.keys(params).reduce((text, name) => text.split(`{${name}}`).join(String(params[name])), template);
    }
  },
  slots: {
    inject: (name, install) => { injectedSlots.push(name); install(); },
    register: (spec, Component) => { registered.push({ spec, Component }); }
  }
};

mod.apply(ctx);

check("注册了 zh/en 字典", localeRegistrations.length === 1
  && localeRegistrations[0].ns === "app-restart"
  && localeRegistrations[0].dicts.zh["action.restart"] === "重启"
  && typeof localeRegistrations[0].dicts.en["action.restart"] === "string");
check("注入了样式标签", styleTags.length === 1 && String(styleTags[0].textContent).includes(".dsr-row"));
check("向 sidebar.footer.action 注入了插槽", injectedSlots.includes("sidebar.footer.action"));
check("只注册了一个入口", registered.length === 1);

const entry = registered[0];
check("slot 名正确", entry.spec.name === "sidebar.footer.action");
check("id 稳定", entry.spec.id === "app-restart");
check("order=60（排在 Cordis 面板之后、设置之前）", entry.spec.order === 60);
check("locale 命名空间正确", entry.spec.locale === "app-restart");
const face = entry.spec.inject();
check("inject face 暴露 host 接口", typeof face.api?.restart === "function"
  && typeof face.api?.readStatus === "function" && typeof face.api?.readLog === "function");

/** 复用的翻译函数，模拟 slot 注入的 t。 */
const t = (key) => localeRegistrations[0].dicts.zh[key] ?? key;

/* ---- 1. 宽态渲染 --------------------------------------------------------- */
console.log("\n[1] 宽态（侧栏展开）");

const wide = mount(entry.Component, { wide: true, t, api: face.api });
let tree = wide.render();
tree = await wide.settle(4);

const buttonOf = (node) => findAll(node, (element) => element.type === "button" && String(element.props.className ?? "").startsWith("dsr-"))[0];
let button = buttonOf(tree);
check("渲染出一个底部行按钮", button !== undefined);
check("用整行样式 dsr-row", button?.props.className === "dsr-row");
check("文案是「重启」", byText(button, "重启"));
check("里面是刷新图标（不是文字图标）", findAll(button, (element) => element.type === IconRefreshOutlineRegular).length === 1);
// 组件总是渲染一个 Modal 元素，关着的时候由 Modal 自己返回 null（primitives 的真实行为）。
check("未点开时对话框是关着的", findAll(tree, (element) => element.type === Modal)[0]?.props.open === false);
check("挂载时问过一次宿主能力", fetchCalls.length === 1 && fetchCalls[0].url === "/app-restart/api/status");
check("状态查询带上调用头", fetchCalls[0].init.headers["x-dsh-plugin-call"] === "app-restart");
check("能力可用时按钮可用", button?.props.disabled === false);

/* ---- 2. 二次确认 --------------------------------------------------------- */
console.log("\n[2] 二次确认与重启请求");

button.props.onClick();
tree = wide.render();
let modal = findAll(tree, (element) => element.type === Modal)[0];
check("点击后弹出确认框", modal !== undefined && modal.props.open === true);
check("确认框标题问得清楚", String(modal.props.title).includes("重启"));
check("确认框正文说明了会中断任务", byText(modal, "任务会被中断"));
check("按钮文案变成确认项", byText(modal.props.footer, "立即重启") && byText(modal.props.footer, "取消"));
check("还没发重启请求", fetchCalls.length === 1);

const confirmButton = findAll(modal.props.footer, (element) => element.type === Button)[1];
check("确认按钮是主按钮", confirmButton?.props.variant === "primary");
confirmButton.props.onClick();
tree = wide.render();
check("确认后立刻进入「正在重启…」", byText(buttonOf(tree), "正在重启…"));
check("重启中按钮被禁用", buttonOf(tree)?.props.disabled === true);
check("重启中图标在转", findAll(tree, (element) => String(element.props.className ?? "").includes("dsr-spin")).length >= 1);

await wide.settle(6);
const restartCall = fetchCalls.find((call) => call.url === "/app-restart/api/restart");
check("发出了 POST /app-restart/api/restart", restartCall !== undefined && restartCall.init.method === "POST");
check("请求带 JSON content-type", restartCall?.init.headers["content-type"] === "application/json");
check("请求带调用头", restartCall?.init.headers["x-dsh-plugin-call"] === "app-restart");
tree = wide.render();
modal = findAll(tree, (element) => element.type === Modal)[0];
check("重启中对话框换成进度文案", String(modal?.props.title).includes("正在重启"));
check("重启中不给「取消」按钮（避免半路松手）",
  findAll(modal?.props.footer ?? {}, (element) => element.type === Button).length === 0);

/* ---- 3. 看门狗：页面还活着说明没重启成 ----------------------------------- */
console.log("\n[3] 看门狗");

responder = async (url) => {
  if (url.endsWith("/status")) {
    return { status: 200, json: async () => ({ ok: true, result: { supported: true, mode: "desktop" } }) };
  }
  return { status: 200, json: async () => ({ ok: true, result: { logPath: "C:/tmp/restart.log", text: "terminate: SIGTERM -> shell 1234\nABORT: shell is still alive" } }) };
};
fetchCalls.length = 0;
const watchdog = mount(entry.Component, { wide: true, t, api: face.api });
let watchTree = watchdog.render();
await watchdog.settle(4);
buttonOf(watchTree).props.onClick();
watchTree = watchdog.render();
// 让 host 半回一个很短的 probeAfterMs，测试不用真等 8 秒。
const quickApi = {
  readStatus: () => face.api.readStatus(),
  readLog: () => face.api.readLog(),
  restart: async () => ({ probeAfterMs: 20, logPath: "C:/tmp/restart.log" })
};
watchdog.render();
const quick = mount(entry.Component, { wide: true, t, api: quickApi });
let quickTree = quick.render();
await quick.settle(4);
buttonOf(quickTree).props.onClick();
quickTree = quick.render();
findAll(quickTree, (element) => element.type === Modal)[0].props.footer.props.children[1].props.onClick();
await quick.settle(30);
quickTree = quick.render();
const staleModal = findAll(quickTree, (element) => element.type === Modal)[0];
check("看门狗到点后改报「重启没有生效」", String(staleModal?.props.title).includes("没有生效"));
check("把日志尾巴摆了出来", byText(staleModal, "ABORT"));
check("给出了日志路径", byText(staleModal, "C:/tmp/restart.log"));
check("这种情况下的按钮回到可点状态", buttonOf(quickTree)?.props.disabled === false);

/* ---- 4. 失败路径 --------------------------------------------------------- */
console.log("\n[4] 失败与不支持");

responder = async (url) => {
  if (url.endsWith("/status")) {
    return { status: 200, json: async () => ({ ok: true, result: { supported: true, mode: "desktop" } }) };
  }
  return { status: 409, json: async () => ({ ok: false, code: "unsupported", error: "当前进程不是 DSH 桌面端的 Host" }) };
};
const failing = mount(entry.Component, { wide: true, t, api: face.api });
let failTree = failing.render();
await failing.settle(4);
buttonOf(failTree).props.onClick();
failTree = failing.render();
findAll(failTree, (element) => element.type === Modal)[0].props.footer.props.children[1].props.onClick();
await failing.settle(10);
failTree = failing.render();
const failModal = findAll(failTree, (element) => element.type === Modal)[0];
check("失败时留在对话框里报错", byText(failModal, "重启失败") && byText(failModal, "不是 DSH 桌面端的 Host"));
check("失败后按钮恢复可点（可以再试）", buttonOf(failTree)?.props.disabled === false);

responder = async () => ({
  status: 200,
  json: async () => ({ ok: true, result: { supported: false, mode: "unsupported", reasons: ["宿主没有连着外壳的 IPC 通道"] } })
});
const unsupported = mount(entry.Component, { wide: true, t, api: face.api });
let unsupportedTree = unsupported.render();
unsupportedTree = await unsupported.settle(6);
button = buttonOf(unsupportedTree);
check("非桌面端时按钮禁用", button?.props.disabled === true);
check("禁用原因写在 title 上", String(button?.props.title ?? "").includes("IPC"));

/* ---- 5. 窄栏形态 --------------------------------------------------------- */
console.log("\n[5] 窄栏（侧栏收起）");

responder = async () => ({ status: 200, json: async () => ({ ok: true, result: { supported: true, mode: "desktop" } }) });
const rail = mount(entry.Component, { wide: false, t, api: face.api });
let railTree = rail.render();
railTree = await rail.settle(4);
button = buttonOf(railTree);
check("收起态画成圆形图标按钮", button?.props.className === "dsr-rail");
check("收起态按钮有无障碍名字", button?.props["aria-label"] === "重启 DSH 桌面应用");
check("收起态把按钮包进了 Tooltip", findAll(railTree, (element) => element.type === Tooltip).length === 1);
check("收起态不画文字标签", !byText(button, "重启"));

/* ---- 6. primitives 缺件时的兜底 ------------------------------------------ */
console.log("\n[6] primitives 缺件兜底");

primitivesOverride = {};
const bareMod = loaderSpec.factory(requireShim);
const bareRegistered = [];
bareMod.apply({
  effect: (fn) => fn(),
  locale: ctx.locale,
  slots: { inject: (name, install) => install(), register: (spec, Component) => bareRegistered.push({ spec, Component }) }
});
const bare = mount(bareRegistered[0].Component, { wide: true, t, api: face.api });
let bareTree = bare.render();
bareTree = await bare.settle(6);
button = buttonOf(bareTree);
check("没有 primitives 也能画出按钮", button !== undefined && button.props.className === "dsr-row");
// 组件元素只是「要画什么」，真正画出来的是它的返回值 —— 自绘图标是组件，所以要调用一次。
const iconElement = findAll(button, (element) => typeof element.type === "function")[0];
check("图标退回自绘组件", typeof iconElement?.type === "function" && iconElement.type !== IconRefreshOutlineRegular);
hooks = [];
cursor = 0;
pendingEffects = [];
const drawnIcon = iconElement.type(iconElement.props ?? {});
check("自绘图标真的画出一个 16px SVG", drawnIcon?.type === "svg" && drawnIcon.props?.viewBox === "0 0 16 16");

bareTree = bare.render();
buttonOf(bareTree).props.onClick();
bareTree = bare.render();
check("没有 primitives 也有确认框（自绘）", byText(bareTree, "任务会被中断"));
// 同理：自绘 Modal 要用调用一次才算真的渲染出关闭按钮。
const bareModal = findAll(bareTree, (element) => element.props?.open === true && typeof element.type === "function")[0];
hooks = [];
cursor = 0;
pendingEffects = [];
const bareModalTree = bareModal.type(bareModal.props);
check("自绘确认框有关闭按钮",
  findAll(bareModalTree, (element) => element.type === "button" && element.props.className === "dsr-modalClose").length === 1);
check("自绘确认框的可访问名字是「取消」", byText(bareModalTree, "任务会被中断"));

/* ---- 7. 无 t 时用内置中文 ------------------------------------------------ */
console.log("\n[7] 没有 t 的降级");

const noT = mount(bareRegistered[0].Component, { wide: true, api: face.api });
const noTTree = noT.render();
await noT.settle(4);
check("没有注入 t 也显示中文", byText(buttonOf(noTTree), "重启"));

console.log(`\n${failed === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${failed} 失败`);
process.exitCode = failed === 0 ? 0 : 1;
