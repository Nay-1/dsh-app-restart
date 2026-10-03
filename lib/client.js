/**
 * dsh-app-restart — Client half.
 *
 * 往 `sidebar.footer.action` 注册一个「重启」按钮 —— 官方对这个 seat 的说明就是
 * 「Optional actions beside Settings at the sidebar foot」，DSH 自己的 Cordis 面板
 * （`@deepseek-ai/dsh-client-ui-cordis`，id `cordis-panel`）用的也是它。
 * 外壳渲染这个 seat 时传的 props 是 `{ wide }`：
 *   - `wide === true`：侧栏是展开的，画成「图标 + 文字」的整行按钮，和底部的
 *     「设置」同一副身板；
 *   - `wide === false`：侧栏收成了 56px 竖栏，只画一个圆形图标按钮（带 Tooltip）。
 *     （Windows 上外壳的样式表在收起态整个隐藏 footArea，这时按钮跟着设置一起
 *     不显示 —— 那是外壳的决定，我们只是照它的规矩画。）
 *
 * 动作链路：点按钮 → 二次确认（会中断正在跑的任务，这一步不能省）→
 * `POST /app-restart/api/restart` → 模态框变成「正在重启…」。
 *
 * 之后正常情况下整个页面会被新起来的应用换掉，什么都不用做；**但这个按钮必须
 * 对「重启没生效」负责**，所以有一个看门狗：host 半在响应里给出 `probeAfterMs`，
 * 到点页面居然还活着，就再问一次 `/status` —— 还答得上来，说明外壳没被关掉、
 * 重启没发生，于是把这次重启的日志尾巴摆出来（日志路径也一并给出）。
 *
 * 打包形态：DSH 的 Module Loader 包（factory(require)），无构建步骤；
 * 样式随组件注入一个 <style> 标签，沿用内置页面的 --dsw-* 设计变量。
 */
window.__ModuleLoader__.load({
  id: "dsh-app-restart",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives") ?? {};

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
      "action.restart": "重启",
      "action.restarting": "正在重启…",
      "action.label": "重启 DSH 桌面应用",
      "action.unsupported": "当前不是 DSH 桌面端，不能重启桌面应用",
      "dialog.title": "重启 DSH 桌面应用？",
      "dialog.body": "应用会先退出、再自动打开，正在运行的任务会被中断。新装的插件和改过的配置，重启后才会生效。",
      "dialog.confirm": "立即重启",
      "dialog.cancel": "取消",
      "restarting.title": "正在重启…",
      "restarting.body": "应用马上会关掉并自己打开，等几秒就好。",
      "stale.title": "重启没有生效",
      "stale.body": "外壳进程没能关掉，应用还在运行。可以手动退出 DSH 再打开；下面是这次重启的日志：",
      "stale.nolog": "（日志没读到）",
      "error.title": "重启失败",
      "error.noapi": "重启接口没有响应，host 半可能未加载",
      "menu.label": "重启",
      "menu.description": "重启 DSH 桌面应用（关掉外壳并重新拉起）"
    };
    const en = {
      "action.restart": "Restart",
      "action.restarting": "Restarting…",
      "action.label": "Restart the DSH desktop app",
      "action.unsupported": "Not the DSH desktop app; cannot restart it",
      "dialog.title": "Restart the DSH desktop app?",
      "dialog.body": "The app quits and reopens by itself; running tasks are interrupted. Newly installed plugins and changed configuration apply after the restart.",
      "dialog.confirm": "Restart now",
      "dialog.cancel": "Cancel",
      "restarting.title": "Restarting…",
      "restarting.body": "The app is about to close and reopen on its own. A few seconds.",
      "stale.title": "The restart did not happen",
      "stale.body": "The shell process could not be closed, so the app is still running. Quit DSH manually and open it again; the log of this attempt follows:",
      "stale.nolog": "(no log could be read)",
      "error.title": "Restart failed",
      "error.noapi": "The restart endpoint did not respond; the host half may not be loaded",
      "menu.label": "Restart",
      "menu.description": "Restart the DSH desktop app (quit the shell and start it again)"
    };

    /** 字典插值：`{name}` 替换。 */
    const format = (template, params) => {
      if (params === undefined) return template;
      return Object.keys(params).reduce(
        (text, name) => text.split(`{${name}}`).join(String(params[name])),
        template
      );
    };

    /** slot 注入的 t 优先，取不到就用本文件的字典。 */
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
     * 样式：沿用内置页面的 --dsw-* 设计变量。
     *
     * 每个变量都带 fallback 链：公开主题契约里只列了 label-primary /
     * bg-layer-* / border-l1-l2 / state-* 这些，内置页面用的是更细的别名
     * （label-secondary、label-tertiary、radius-md）。别名在当前版本都存在，
     * 换版本被改名时最坏是「颜色退成中性色」，不会变成看不见的字。
     * ------------------------------------------------------------------ */
    const css = `
.dsr-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md,8px);background:0 0;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary,#3a3f47));font:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left}
.dsr-row:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary,#000) 8%, transparent);color:var(--dsw-alias-label-primary,#111)}
.dsr-row:disabled{cursor:default;opacity:.5}
.dsr-rail{display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:0 0;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary,#3a3f47));cursor:pointer}
.dsr-rail:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary,#000) 8%, transparent);color:var(--dsw-alias-label-primary,#111)}
.dsr-rail:disabled{cursor:default;opacity:.5}
.dsr-row:focus-visible,.dsr-rail:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:1px}
.dsr-icon{display:inline-flex;flex:0 0 auto}
.dsr-spin{animation:dsr-spin 1s linear infinite}
@keyframes dsr-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dsr-spin{animation:none}}
.dsr-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsr-body{display:flex;flex-direction:column;gap:10px}
.dsr-text{margin:0;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary,#3a3f47));font-size:13px;line-height:20px}
.dsr-logPath{margin:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;word-break:break-all}
.dsr-log{box-sizing:border-box;margin:0;max-height:220px;overflow:auto;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word}
.dsr-error{margin:0;padding:8px 12px;border:.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary,#c0392b) 40%, transparent);border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-state-error-primary,#c0392b);font-size:12px;line-height:18px;word-break:break-word}
.dsr-foot{display:flex;justify-content:flex-end;gap:8px;width:100%}
.dsr-fallbackBtn{font:inherit;padding:5px 12px;border:.5px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:var(--dsw-radius-md,8px);background:0 0;color:var(--dsw-alias-label-primary,#111);font-size:12.5px;cursor:pointer}
.dsr-fallbackBtn:disabled{cursor:default;opacity:.45}
/* 强调态刻意不做实心填充：实心必须和前景色配对，而 --dsw-alias-brand-primary
   在浅色主题近黑、深色主题近白，硬编码任何一种前景色都会在另一个主题里变成
   「白底白字」。改成描边 + 加粗，文字继续用 label-primary。 */
.dsr-fallbackBtnPrimary{border-color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
.dsr-modalRoot{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center}
.dsr-modalMask{position:absolute;inset:0;background:#00000059}
.dsr-modalCard{position:relative;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(560px,92vw);max-height:86vh;overflow:auto;padding:18px 20px;border:.5px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));box-shadow:0 12px 40px #00000040}
.dsr-modalHead{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsr-modalTitle{margin:0;font-size:15px;font-weight:600}
.dsr-modalClose{padding:4px 6px;border:0;background:0 0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));font:inherit;font-size:16px;line-height:1;cursor:pointer}
`;

    const CSS_TAG_ID = "dsh-app-restart/FooterAction.module.css";
    /** 注入一次样式；返回的 disposer 在插件卸载时把标签摘掉。 */
    const insertStyles = () => {
      if (typeof document === "undefined" || document.head === undefined) return () => {};
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return () => {};
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-app-restart";
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => {
        try {
          if (typeof tag.remove === "function") tag.remove();
          else if (typeof document.head.removeChild === "function") document.head.removeChild(tag);
        } catch { /* ignore */ }
      };
    };

    /* ------------------------------------------------------------------ *
     * primitives 取用：任何一个组件缺失都要能降级，绝不把 undefined 交给
     * createElement —— 那会让整个侧栏渲染崩掉，而不是少一个按钮。
     * ------------------------------------------------------------------ */
    const el = React.createElement;

    /**
     * React 组件的三种形状都要认，只判 `typeof === "function"` 不够：
     * 函数组件 → function；宿主组件 → string；forwardRef/memo/lazy → 对象
     * （`{ $$typeof: Symbol(react.forward_ref) }`）。primitives 的 Button 与 Tooltip
     * 都是 forwardRef 的产物，用 typeof 探测会把它们判成「不存在」而静默走兜底。
     */
    const reactComponent = (value) => {
      if (typeof value === "function" || typeof value === "string") return value;
      if (value !== null && typeof value === "object"
        && (typeof value.$$typeof === "symbol" || typeof value.$$typeof === "number")) return value;
      return undefined;
    };

    /** 兜底图标：primitives 里没有 IconRefreshOutlineRegular 时画一个自己的。 */
    const FallbackRefreshIcon = function FallbackRefreshIcon(props) {
      const size = typeof props?.size === "number" ? props.size : 16;
      return el("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.2,
        strokeLinecap: "round",
        "aria-hidden": "true",
        focusable: "false"
      },
        el("path", { key: "arc", d: "M13.2 8a5.2 5.2 0 1 1-1.6-3.75" }),
        el("path", { key: "head", d: "M13.4 1.8v3.1h-3.1" })
      );
    };
    const RefreshIcon = reactComponent(primitives.IconRefreshOutlineRegular) ?? FallbackRefreshIcon;

    const FallbackTooltip = function FallbackTooltip(props) { return props?.children ?? null; };
    const Tooltip = reactComponent(primitives.Tooltip) ?? FallbackTooltip;

    const FallbackButton = function FallbackButton({ variant, className, children, ...rest }) {
      const classes = ["dsr-fallbackBtn"];
      if (variant === "primary") classes.push("dsr-fallbackBtnPrimary");
      if (typeof className === "string" && className !== "") classes.push(className);
      return el("button", { type: "button", className: classes.join(" "), ...rest }, children);
    };
    const Button = reactComponent(primitives.Button) ?? FallbackButton;

    /** 模态外壳：primitives 的 Modal 缺失时自绘一个（遮罩点击 / Escape 都留着）。 */
    const FallbackModal = function FallbackModal({ open, onClose, title, closeLabel, description, children, footer }) {
      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => { if (event.key === "Escape") onClose?.(); };
        if (typeof document !== "undefined") document.addEventListener("keydown", onKeyDown);
        return () => { if (typeof document !== "undefined") document.removeEventListener("keydown", onKeyDown); };
      }, [open, onClose]);
      if (!open) return null;
      return el("div", { className: "dsr-modalRoot", role: "presentation" },
        el("div", { className: "dsr-modalMask", onClick: () => onClose?.() }),
        el("div", { className: "dsr-modalCard", role: "dialog", "aria-modal": "true", "aria-label": title },
          el("div", { className: "dsr-modalHead" },
            el("h2", { className: "dsr-modalTitle" }, title),
            el("button", {
              type: "button",
              className: "dsr-modalClose",
              "aria-label": closeLabel,
              onClick: () => onClose?.()
            }, "✕")),
          description === undefined || description === "" ? null : el("p", { className: "dsr-text" }, description),
          children,
          footer));
    };
    const Modal = reactComponent(primitives.Modal) ?? FallbackModal;

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

    /** 注入给组件的宿主接口：模块级常量，引用稳定（组件的 effect 依赖它）。 */
    const defaultApi = {
      readStatus: () => call("/status"),
      readLog: () => call("/log"),
      restart: (body) => call("/restart", { method: "POST", body: JSON.stringify(body ?? {}) })
    };

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */
    function RestartFooterAction(props) {
      const wide = props?.wide !== false;
      const t = props?.t;
      const api = props?.api ?? defaultApi;

      /** undefined=还不知道；{supported:false} → 按钮禁用并说明原因。 */
      const [support, setSupport] = React.useState(undefined);
      /** idle → confirm → restarting →（看门狗抓到）stale */
      const [phase, setPhase] = React.useState("idle");
      const [error, setError] = React.useState(undefined);
      const [logText, setLogText] = React.useState(undefined);
      const [logPath, setLogPath] = React.useState(undefined);
      const [probeAfterMs, setProbeAfterMs] = React.useState(0);
      const mounted = React.useRef(true);

      React.useEffect(() => () => { mounted.current = false; }, []);

      // 挂载时问一次宿主：这儿到底能不能重启。
      React.useEffect(() => {
        let cancelled = false;
        api.readStatus()
          .then((status) => { if (!cancelled) setSupport(status ?? { supported: true }); })
          .catch(() => { if (!cancelled) setSupport({ supported: true, unknown: true }); });
        return () => { cancelled = true; };
      }, [api]);

      // 看门狗：过了 probeAfterMs 页面还活着，就说明外壳没被关掉。
      React.useEffect(() => {
        if (phase !== "restarting" || probeAfterMs <= 0) return undefined;
        const timer = setTimeout(() => {
          if (!mounted.current) return;
          api.readStatus()
            .then(() => api.readLog().catch(() => undefined))
            .then((log) => {
              if (!mounted.current) return;
              setLogText(typeof log?.text === "string" ? log.text : undefined);
              setLogPath(typeof log?.logPath === "string" ? log.logPath : undefined);
              setPhase("stale");
            })
            .catch(() => { /* 连不上了：那多半是重启真的发生了，什么都不用做 */ });
        }, probeAfterMs);
        return () => clearTimeout(timer);
      }, [phase, probeAfterMs, api]);

      const unsupported = support !== undefined && support.supported === false;
      const busy = phase === "restarting";
      const unsupportedReason = Array.isArray(support?.reasons) && support.reasons.length > 0
        ? String(support.reasons[0])
        : undefined;

      const label = busy ? translate(t, "action.restarting") : translate(t, "action.restart");
      const icon = el("span", { className: busy ? "dsr-icon dsr-spin" : "dsr-icon" }, el(RefreshIcon, { size: 16 }));
      const explain = unsupported
        ? `${translate(t, "action.unsupported")}${unsupportedReason === undefined ? "" : `：${unsupportedReason}`}`
        : undefined;

      const trigger = el("button", {
        type: "button",
        className: wide ? "dsr-row" : "dsr-rail",
        disabled: busy || unsupported,
        // 收起态只有图标，用它兜底；不支持时两种形态都还要说明原因。
        "aria-label": wide ? undefined : translate(t, "action.label"),
        title: explain,
        onClick: () => {
          setError(undefined);
          setLogText(undefined);
          setPhase("confirm");
        }
      }, wide ? [icon, el("span", { key: "label", className: "dsr-label" }, label)] : [icon]);

      // 竖栏形态没有文字，用浮层把名字和「为什么不能用」补上。
      // （禁用按钮在部分浏览器不发指针事件，所以 title 也一直留着。）
      const button = wide
        ? trigger
        : el(Tooltip, { label: explain ?? translate(t, "action.label"), delayMs: 400 }, trigger);

      const confirm = async () => {
        setError(undefined);
        setPhase("restarting");
        try {
          const result = await api.restart({});
          if (!mounted.current) return;
          setProbeAfterMs(typeof result?.probeAfterMs === "number" && result.probeAfterMs > 0
            ? result.probeAfterMs
            : 8000);
          setLogPath(typeof result?.logPath === "string" ? result.logPath : undefined);
        } catch (failure) {
          if (!mounted.current) return;
          setError(failure?.message ?? String(failure));
          setPhase("confirm");
        }
      };

      const open = phase === "confirm" || phase === "restarting" || phase === "stale";
      const title = phase === "stale" ? translate(t, "stale.title")
        : busy ? translate(t, "restarting.title")
          : translate(t, "dialog.title");
      const bodyText = phase === "stale" ? translate(t, "stale.body")
        : busy ? translate(t, "restarting.body")
          : translate(t, "dialog.body");

      const dialogBody = [
        el("p", { key: "text", className: "dsr-text" }, bodyText),
        phase === "stale"
          ? el("pre", { key: "log", className: "dsr-log" }, logText ?? translate(t, "stale.nolog"))
          : null,
        phase === "stale" && logPath !== undefined
          ? el("p", { key: "logPath", className: "dsr-logPath" }, logPath)
          : null,
        error === undefined ? null : el("p", { key: "error", className: "dsr-error" }, `${translate(t, "error.title")}：${error}`)
      ].filter((node) => node !== null);

      const dialogFooter = el("div", { className: "dsr-foot" }, busy
        ? null
        : [
          el(Button, {
            key: "cancel",
            variant: "ghost",
            onClick: () => { setPhase("idle"); setError(undefined); }
          }, translate(t, "dialog.cancel")),
          el(Button, {
            key: "confirm",
            variant: phase === "stale" ? "outline" : "primary",
            onClick: () => {
              if (phase === "stale") { setPhase("idle"); return; }
              void confirm();
            }
          }, phase === "stale" ? translate(t, "dialog.cancel") : translate(t, "dialog.confirm"))
        ]);

      const surface = el(Modal, {
        open,
        onClose: () => { if (!busy) { setPhase("idle"); setError(undefined); } },
        title,
        closeLabel: translate(t, "dialog.cancel"),
        children: el("div", { className: "dsr-body" }, dialogBody),
        footer: dialogFooter
      });

      return el(React.Fragment, null, button, surface);
    }

    /* ------------------------------------------------------------------ *
     * 注册
     * ------------------------------------------------------------------ */
    function apply(ctx) {
      ctx.effect(insertStyles, "app-restart: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "app-restart: dictionaries");

      /** 绑好本插件命名空间的翻译器；取不到就用内置字典。 */
      const t = (() => {
        try {
          const bound = ctx.locale?.bind?.(NS);
          if (typeof bound === "function") return bound;
        } catch { /* 回落到内置字典 */ }
        return undefined;
      })();

      /* ---------------------------------------------------------------- *
       * 斜杠命令 `/restart`
       *
       * 为什么是**客户端贡献**（`commandUi.register`）而不是宿主命令：
       * `/` 菜单里的行长相由 `dsh-client-ui-commands` 决定 —— 宿主命令那一行是
       * `builtinRowFace()` 从内置表 `HOST_FACES`（写死的 compact/permission/plan/
       * export/goal/feedback…）里取 `label + description + icon`，**第三方宿主命令
       * 永远取不到**，只会退回「命令名 + description」的素颜（实测就是这样）。
       * 客户端贡献则可以自己给 `label`（中文名）、`description`、`icon`。
       *
       * 两条路不能同时占 `restart` 这个名字：`candidates()` 里宿主目录先跑，遇到
       * 同名贡献会直接 throw（"contribution /restart collides with a host command"），
       * 所以宿主那半的命令注册已经撤掉，改由这里统一提供。
       *
       * 契约（照着内置的 `/file` 贡献抄的）：
       *   - `label` / `description` 是**函数**，每次投影都会重读，所以跟着语言走；
       *   - `icon` 传**组件本身**（不是 element）；
       *   - `ui.kind: "action"` 的 `run(session)` 在「菜单选中」和「打命令回车」
       *     两条路都会被调用（`dispatch` 与 `matchEnter` 都优先看贡献）。
       * ---------------------------------------------------------------- */
      if (typeof ctx.inject === "function") {
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
            // 同步判定，问不了宿主（能力查询是异步的）：真不能重启时由 run 报错。
            available: () => true,
            ui: {
              kind: "action",
              run: () => {
                defaultApi.restart({}).catch((error) => {
                  const message = error?.message ?? String(error);
                  try {
                    if (typeof window !== "undefined" && typeof window.alert === "function") {
                      window.alert(`${translate(t, "error.title")}：${message}`);
                    }
                  } catch { /* ignore */ }
                });
              }
            }
          }), "app-restart: /restart command");
        });
      }

      const slots = ctx.slots;
      if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") return;

      slots.inject("sidebar.footer.action", () => slots.register({
        name: "sidebar.footer.action",
        id: "app-restart",
        // 60：排在 Cordis 面板（默认 order）之后、紧挨底部的「设置」。
        order: 60,
        locale: NS,
        inject: () => ({ api: defaultApi })
      }, RestartFooterAction));
    }

    const inject = ["slots", "locale"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
