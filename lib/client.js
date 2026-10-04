/**
 * dsh-app-restart — Client half.
 *
 * 界面零足迹：这里只往 `/` 命令菜单里贡献一条 `/restart` —— 不注册 slot、不插样式表、
 * 不碰 DOM。想重启应用，就在输入框打 `/restart`。
 *
 * 为什么是**客户端贡献**（`commandUi.register`）而不是宿主命令（踩过两次的坑）：
 * `/` 菜单里的行长相由 `dsh-client-ui-commands` 决定 ——
 *
 *   for (const c of list) rows.push({ name: c.name, ...builtinRowFace(c, t) ?? { description: c.description } })
 *
 * 而 `builtinRowFace()` 只查内置表 `HOST_FACES`（写死的 goal / plan / permission /
 * model / export…），**第三方宿主命令永远查不到**，菜单里只剩「命令名 + description」
 * 的素颜；客户端贡献则可以自己给 `label`（中文名）、`description`、`icon`，和内置命令
 * 同一副长相。两条路还不能同时占 `restart` 这个名字：`candidates()` 先跑宿主目录，
 * 再遇到同名贡献会直接 throw（"contribution /restart collides with a host command"）
 * —— 所以宿主半**故意不注册**它（`test-host.mjs` 里钉着这条）。
 *
 * 契约（照着内置的 `/file` 贡献抄的）：
 *   - `label` / `description` 是**函数**，每次投影都会重读，所以跟着语言走；
 *   - `icon` 传**组件本身**（不是 element）；
 *   - `ui.kind: "action"` 的 `run(session)` 在「菜单里选中」和「打命令回车」
 *     两条路上都会被调用。
 *
 * `run()` 打的是 `POST /restart`，回包之后再按 `probeAfterMs` 自查一次：**回包成功
 * 只说明助手已经上路**，助手的外壳杀不掉时会走安全失败（应用照旧、没有回包可等），
 * 那条路只能靠「过了 probeAfterMs 这个界面居然还活着」认出来，见 watchOutcome。
 *
 * 打包形态：DSH 的 Module Loader 包（factory(require)），无构建步骤；基座之外
 * 不 require 任何东西（只取 React），理由见下面 RefreshIcon 的注释。
 */
window.__ModuleLoader__.load({
  id: "dsh-app-restart",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const NS = "app-restart";
    const API = "/app-restart/api";
    /**
     * 与 host 半约定的调用头，理由见 host 半的同名常量：插件前缀路由不受
     * DSH 鉴权网关保护，靠这个自定义头（必然触发 CORS 预检、而 host 不回 CORS 头）
     * 挡住浏览器里任意网页发起的跨站请求。
     */
    const CALL_HEADER = "x-dsh-plugin-call";
    const CALL_HEADER_VALUE = "app-restart";

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */
    const zh = {
      "menu.label": "重启",
      "menu.description": "重启 DSH 桌面应用（关掉外壳并重新拉起）",
      "error.title": "重启失败",
      "error.noapi": "重启接口没有响应，host 半可能未加载",
      "error.stalled": "外壳没有被关掉，这个界面还活着 —— 这次重启没有生效",
      "error.detail": "宿主日志末尾：{text}"
    };
    const en = {
      "menu.label": "Restart",
      "menu.description": "Restart the DSH desktop app (quit the shell and start it again)",
      "error.title": "Restart failed",
      "error.noapi": "The restart endpoint did not respond; the host half may not be loaded",
      "error.stalled": "The shell was not stopped and this window is still alive — the restart did not take effect",
      "error.detail": "Host log tail: {text}"
    };

    /** 字典插值：`{name}` 替换。 */
    const format = (template, params) => {
      if (params === undefined) return template;
      return Object.keys(params).reduce(
        (text, name) => text.split(`{${name}}`).join(String(params[name])),
        template
      );
    };

    /** 注入的 t 优先，取不到就用本文件的字典。 */
    const translate = (t, key, params) => {
      if (typeof t === "function") {
        try {
          const value = t(key, params);
          if (typeof value === "string" && value !== "" && value !== key) return value;
        } catch { /* 回落到内置字典 */ }
      }
      return format(zh[key] ?? key, params);
    };

    /* ------------------------------------------------------------------ *
     * 菜单行图标
     *
     * 照抄 primitives 的 `IconRefreshOutlineRegular`（16px、1px 描边的刷新箭头），
     * 而不是 `require('@deepseek-ai/dsh-client-ui-primitives')` —— DSH 的插件规则
     * （`cordis-plugin-development/references/practices.md`）明说不要把 Client 包当
     * 模块加载：它们随版本变、纯 JS 插件没有类型检查，而一个抛错的组件会把整个
     * 插槽位置打空。规则给的替代方案就是「把 primitive 的 markup 抄进插件里」，
     * 这里照做：纯几何图形 + currentColor，连主题变量都不需要。
     * ------------------------------------------------------------------ */
    const RefreshIcon = function RefreshIcon(props) {
      const size = typeof props?.size === "number" ? props.size : 16;
      return React.createElement("svg", {
        width: size,
        height: size,
        className: props?.className,
        viewBox: "0 0 16 16",
        fill: "none",
        xmlns: "http://www.w3.org/2000/svg",
        "aria-hidden": "true",
        strokeWidth: typeof props?.strokeWidth === "number" ? props.strokeWidth : 1
      },
        React.createElement("path", {
          key: "arc",
          d: "M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1",
          stroke: "currentColor"
        }),
        React.createElement("path", { key: "head", d: "M14.4999 1.5V5.1H10.8999", stroke: "currentColor" }));
    };

    /* ------------------------------------------------------------------ *
     * host 半的调用封装。
     * ------------------------------------------------------------------ */
    const call = async (path, init) => {
      const headers = { [CALL_HEADER]: CALL_HEADER_VALUE, ...(init?.headers ?? {}) };
      if (init?.body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(`${API}${path}`, { ...init, headers });
      const data = await response.json().catch(() => undefined);
      if (data === undefined || typeof data !== "object") {
        throw new Error(format(zh["error.noapi"]));
      }
      if (data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data.result;
    };

    /** 命令动作打的就是这一个接口；模块级常量，引用稳定。 */
    const defaultApi = {
      restart: (body) => call("/restart", { method: "POST", body: JSON.stringify(body ?? {}) })
    };

    /**
     * 命令是同步 `run()`，只能这样把失败摆到脸上：客户端没有现成的 toast 服务
     * （`ui-commands` 内部那条 composer 提示位要额外耦合 `sessions` / `conversation`）。
     */
    const reportFailure = (t, error) => {
      const message = error?.message ?? String(error);
      try {
        if (typeof window !== "undefined" && typeof window.alert === "function") {
          window.alert(`${translate(t, "error.title")}：${message}`);
        }
      } catch { /* 弹不出提示，也不能让它变成未处理的 rejection */ }
    };

    /* ------------------------------------------------------------------ *
     * 重启之后的自查
     *
     * 回包成功只代表「助手已经上路」，不代表外壳真的会死：助手的外壳杀不掉时会走
     * **安全失败**（什么都不拉起、应用照旧），那条路没有任何回包可等 —— 回包早在
     * 杀外壳之前就发出去了。所以宿主在回包里给了 `probeAfterMs`：过了这个点，
     * 这个界面居然还活着，就说明这次重启没成。
     *
     * 判定分两种（`GET /status` 会顺手把「助手早就结束了」的陈旧标记清掉）：
     *   - `restarting: true` —— 助手还在路上（可能正等外壳退出），再等一轮，最多几轮；
     *   - `restarting: false` + 页面还活着 —— 助手已经结束而外壳没死，那就是没成：
     *     把宿主日志的收尾（`ABORT: shell … is still alive`）原样摆出来。
     * ------------------------------------------------------------------ */

    /** 宿主没给 probeAfterMs 时的兜底间隔。 */
    const DEFAULT_PROBE_MS = 8000;
    /** 还在路上时最多再看几轮（一轮 = 回包里的 `probeAfterMs`）。 */
    const MAX_PROBES = 4;

    /**
     * 日志里最值得摆给用户看的那一句：优先「为什么没成」（ABORT / FAILED / 助手崩了），
     * 找不到才退回最后一行（`helper done: {"relaunched":false,…}` 也好过什么都不说）。
     */
    const reasonLine = (text) => {
      if (typeof text !== "string") return undefined;
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
      if (lines.length === 0) return undefined;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (/ABORT:|FAILED|helper crashed/.test(lines[index])) return lines[index];
      }
      return lines[lines.length - 1];
    };

    /**
     * 盯着一次已经发出去的重启，没生效就把原因弹出来。
     * 全程不抛错：自查本身失败（接口问不到、日志读不到）绝不该变成未处理的 rejection。
     * @param t - 绑好命名空间的翻译器（可能是 undefined）。
     * @param result - `POST /restart` 的回包结果，用它的 `probeAfterMs`。
     */
    const watchOutcome = (t, result) => {
      const delay = typeof result?.probeAfterMs === "number" && Number.isFinite(result.probeAfterMs) && result.probeAfterMs > 0
        ? result.probeAfterMs
        : DEFAULT_PROBE_MS;
      /** 只做自查的定时器，不该拖着任何东西活着（浏览器里 setTimeout 返回数字，unref 是空操作）。 */
      const later = (fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer?.unref?.();
      };
      let round = 0;
      const tick = async () => {
        try {
          round += 1;
          let status;
          try {
            status = await call("/status");
          } catch {
            // 接口都问不到了：不是页面马上要没了，就是宿主已经换了一茬 —— 两种都不该弹窗。
            return;
          }
          if (status?.restarting === true) {
            if (round < MAX_PROBES) later(() => { void tick(); }, delay);
            return;
          }
          const log = await call("/log").then(undefined, () => undefined);
          const tail = reasonLine(log?.text);
          reportFailure(t, new Error([
            translate(t, "error.stalled"),
            ...tail === undefined ? [] : [translate(t, "error.detail", { text: tail })]
          ].join("\n")));
        } catch { /* 自查失败不打扰用户 */ }
      };
      later(() => { void tick(); }, delay);
    };

    /* ------------------------------------------------------------------ *
     * 注册
     * ------------------------------------------------------------------ */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "app-restart: dictionaries");

      /** 绑好本插件命名空间的翻译器；取不到就用内置字典。 */
      const t = (() => {
        try {
          const bound = ctx.locale?.bind?.(NS);
          if (typeof bound === "function") return bound;
        } catch { /* 回落到内置字典 */ }
        return undefined;
      })();

      // commandUi 是可选服务：scoped inject 等它出现才注册，缺席时插件照样装得上
      // （只是没有命令可用），不会因为少一个服务把插件整体搞挂。
      if (typeof ctx.inject !== "function") return;
      ctx.inject(["commandUi"], (scope) => {
        const commandUi = (() => {
          try {
            if (typeof scope.get === "function") return scope.get("commandUi");
          } catch { /* ignore */ }
          try {
            return scope.commandUi;
          } catch {
            return undefined;
          }
        })();
        if (commandUi === undefined || typeof commandUi.register !== "function") return;
        const effect = typeof scope.effect === "function" ? scope.effect.bind(scope) : ctx.effect;
        effect(() => commandUi.register({
          name: "restart",
          label: () => translate(t, "menu.label"),
          description: () => translate(t, "menu.description"),
          icon: RefreshIcon,
          // 同步判定，问不了宿主（能力查询是异步的）：真不能重启时由 run 报错，
          // 报的就是宿主那句「不是 DSH 桌面端的 Host」加上具体原因。
          available: () => true,
          ui: {
            kind: "action",
            // 打出去只是「触发」，回包之后再盯一眼 probeAfterMs：外壳杀不掉那条安全失败
            // 没有回包可等，界面还活着就是它唯一的信号（见 watchOutcome）。
            run: () => {
              defaultApi.restart({}).then(
                (result) => { watchOutcome(t, result); },
                (error) => { reportFailure(t, error); }
              );
            }
          }
        }), "app-restart: /restart command");
      });
    }

    /** locale 是硬依赖（要注册字典）；别的服务都按需取。 */
    const inject = ["locale"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
