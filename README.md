# dsh-app-restart

一条斜杠命令 `/restart`，把整个 DSH 桌面应用（Electron 外壳 + Host 进程）重启一遍，
几秒后自己回来 —— 也就是官方 README 里那句「改完必须重启 DSH」所做的事，
只是不用手动退出再打开。

```
输入框：  /restart
```

界面零足迹：不占任何插槽、不加按钮、不插样式表 —— 想重启就在输入框打这条命令。

| | |
|---|---|
| 入口 | `/restart`，在输入框打 `/` 出现在命令菜单里，长相与内置命令一致（图标 + 中文名 + 说明） |
| 动作 | 命令是明确打出来的，直接执行 → 关掉外壳 → 重新拉起 `DeepSeek Harness.exe` |
| 失败 | 弹窗说清楚为什么没成（非桌面端、已经有一次在路上、host 半没加载…） |
| 适用 | **只**适用于 DSH 桌面端；`dsh web` 那种终端里跑的 Host 会被明确拒绝 |

## 装

```powershell
dsh plugin --profile desktop add "file:C:/Users/prince/Desktop/dsh-plugin/dsh-app-restart"
```

装完**必须重启一次 DSH** 才会加载（插件两半都只在启动时加载一次，没有热重载）。
第一次装只能手动退出再打开 —— 命令自己还没被加载进来；从第二次起，改完源码就能用
`/restart` 自己完成这一次重启了。

改完源码重新生效（pnpm 的 `file:` 依赖是拷贝不是软链，且只看 lockfile，直接再 `add`
只会说 `Already up to date`）：

```powershell
dsh plugin --profile desktop remove dsh-app-restart
dsh plugin --profile desktop add "file:C:/Users/prince/Desktop/dsh-plugin/dsh-app-restart"
```

## 它是怎么重启的（以及为什么只能这么做）

先把取证结论放这儿（DSH 0.2.0-rc.2，全部来自 `app.asar` 与实测）：

**1. 桌面端是两个进程。**

| 角色 | 是什么 |
|---|---|
| 外壳 | `DeepSeek Harness.exe`：Electron 主进程，持窗口、托盘、单实例锁 |
| Host | **同一个 exe** + `ELECTRON_RUN_AS_NODE=1`，跑 `@deepseek-ai/dsh-desktop-host/lib/index.js`，固定 `--port 19387` |

证据：`resources/runtime/cli/bin/dsh.cmd` 逐字如此。

**2. 官方没有给插件或前端留任何重启接口。**

- 全 asar 只有 **两处 `app.relaunch()`**，都在 Electron 主进程里，而且都要人手点：
  崩溃恢复对话框（默认按钮就是「重启」）、以及**仅开发构建**才出现的菜单项
  「重启应用与 Host」。
- 渲染进程的 IPC 通道表（`DESKTOP_IPC`）里没有 restart/quit；`window.dshDesktop`
  只暴露 `browser / deviceInfo / keyboard / shortcuts / updates`；`webServer` 的路由里
  也没有 restart。
- 宿主服务清单里没有 `lifecycle` / `supervisor` 之类的东西，宿主只接受
  `shutdown / quit-inspection / update-tasks` 三种来信 —— 没有「请外壳重启」这种消息。

**3. 于是只剩一条路：自己把外壳关掉，再把应用拉起来。**

```
/restart（或直接 POST /app-restart/api/restart）→ 回包
     → host 半拉起分离式助手（同一个 exe + ELECTRON_RUN_AS_NODE=1，跑 lib/relaunch-helper.cjs）
     → 助手静默 settleMs 让回包落地
     → 终止外壳 PID
     → 宿主随之消失（见下）
     → 助手确认两个进程都没了 → 静默一下 → 用干净环境重新拉起 DeepSeek Harness.exe
```

**宿主是怎么没的**（这一条实测过，两个平台不一样）：

| 平台 | 机制 |
|---|---|
| Windows | 外壳是用**非 detached** 方式拉起宿主的，Node 会把这种子进程和父进程放进同一个 Job；父进程一死，宿主**立刻被系统清掉**，连 `SIGTERM` 处理函数和 `disconnect` 事件都来不及跑 |
| macOS / Linux | 父进程死不会带走子进程，宿主收到 IPC 断开事件，走它自己的 `process.once("disconnect") → application.shutdown.shutdown(0)` 优雅停机 |

两条路都通向「宿主没了」，助手只是确认一下；万一某个平台上它既没被带走也没自己退，
助手会补一刀（日志里会写 `host did not stop on its own`）。

**助手必须是 detached + unref 的**，这一条是整个插件成立的前提，所以按生产拓扑
（外壳 → 宿主 → 助手，三级）实测过：

| 助手怎么拉起来的 | 杀掉外壳之后 |
|---|---|
| 普通 `spawn`（`detached: false`） | 助手**跟着一起被系统清掉**，「重新拉起应用」永远跑不到 |
| `detached: true` + `unref()` | 助手**活下来了**，宿主没了之后照常把应用拉起来 |

原因还是上面的 Job 继承：普通子进程和父进程同属一个 Job，`detached` 才会脱离。
`test-host.mjs` 把这条链路单独钉了一个用例（3e），以后改坏了会立刻红。

**失败是安全的**：万一外壳杀不掉（权限、被保护、系统卡住），助手**什么都不拉起**就退出。
此时宿主还活着、界面照旧，绝不会出现「界面已经死了、新实例又被单实例锁挡回去」那种
两头不靠的状态。回包里带一个 `probeAfterMs`：过了这个点页面居然还活着，就说明这次重启
没成 —— 想知道为什么，`GET /app-restart/api/log` 拿日志尾巴（见「HTTP 接口」）。

**代价说清楚**：重启会**打断正在跑的任务**（这是重启的定义，不是副作用），Windows 上
宿主是被系统连带清掉的，拿不到「优雅停机」那一步 —— 会话日志是逐个事件追加落盘的，
丢数据的窗口和一次崩溃相当。要「先停干净再退出」的话，用托盘/菜单里的正常退出。

## 斜杠命令 `/restart`

界面零足迹：输入框打 `/` 就会在命令菜单里看到它，而且和内置命令长得一样 ——
**刷新图标 + 中文名 + 英文命令名 + 右侧说明**（和「模型 model」「下载日志 export」同一排面）。

```
⟳  重启   restart                        重启 DSH 桌面应用（关掉外壳并重新拉起）
```

- 它是 `commandUi.register({ name, label, description, icon, available, ui })` ——
  **客户端贡献**，不是宿主命令。`label` / `description` 是函数（每次投影重读，跟着语言走），
  `icon` 传组件本身，`ui.kind: "action"` 的 `run()` 在「菜单选中」和「打命令回车」两条路上
  都会跑，里面打的是 `POST /app-restart/api/restart`。
- 命令**没有二次确认**：它是你明确打出来的，再来一次点击确认没有意义。
- 失败会弹窗（客户端没有 toast 服务）：非桌面端、已经有一次重启在路上、host 半没加载，
  都会把宿主给的原话摆出来 —— 绝不让「其实没重启」被当成重启成功了。
- 图标是**照抄** primitives 的 `IconRefreshOutlineRegular`（16px、1px 描边的刷新箭头），
  不是 `require('@deepseek-ai/dsh-client-ui-primitives')`：DSH 的插件规则
  （`cordis-plugin-development/references/practices.md`）明说不要把 Client 包当模块加载
  —— 它们随版本变、纯 JS 插件没有类型检查，而一个抛错的组件会把整个位置打空。
  抄进来的只有两段 SVG 路径，连主题变量都不需要。`test-client.mjs` 里那条
  「只从模块基座取 React」就是钉这件事的。
- 只能打英文名 `/restart`（宿主命令能靠本地化 claim token 支持 `/计划` 那种写法，
  客户端贡献是按名字直接匹配的）。菜单里搜「重启」也能把它筛出来（`rankByName` 会看 label）。

### 为什么不是宿主命令（踩过两次的坑）

| 做法 | 结果 |
|---|---|
| 宿主 `ctx.commands.register({ name: "restart", ... })` | 能用，但菜单里是**素颜**：只有 `restart` + 一句 description，既没图标也没中文名 |
| 宿主命令 **+** 同名客户端贡献 | **直接报错**：`candidates()` 先跑宿主目录，再遇到同名贡献就 throw（`contribution /restart collides with a host command`） |
| 只留客户端贡献（现在的做法） | 菜单长相与内置命令一致 ✅ |

原因在 `dsh-client-ui-commands` 的这段：

```js
for (const c of list) rows.push({ name: c.name, ...builtinRowFace(c, t) ?? { description: c.description } });
```

`builtinRowFace()` 只查内置表 `HOST_FACES`（写死的 compact / permission / plan / export /
goal / feedback…），**第三方宿主命令永远查不到**，只能退回 `{ description }`；而客户端贡献
那一支可以自己给 `label` / `description` / `icon`。

所以宿主半**故意不注册** `restart` 命令，自测里有一条专门钉住这件事（`test-host.mjs` 的
「宿主半没有注册 /restart」），免得以后有人好心搬回去、把菜单搞挂。

## HTTP 接口

前缀 `/app-restart/api`。写接口要求自定义头 `x-dsh-plugin-call: app-restart`，并且
（带 `Origin` 时）`Origin` 的 host 必须等于 `Host` —— 插件的前缀路由不受 DSH 鉴权网关
保护，这道防线让浏览器里任意网页都发不出重启请求；同源 fetch 不受影响。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 能不能重启、外壳/宿主 pid、exe 路径、是否正在重启、日志路径 |
| GET | `/log` | 最近一次重启的日志尾巴（最多 12 KB），没有则 404 |
| POST | `/restart` | 触发重启。可选 body：`settleMs` / `shellTimeoutMs` / `forceTimeoutMs` / `hostTimeoutMs` / `quietMs` |

返回统一是 `{ ok: true, result }` 或 `{ ok: false, code?, error }`；非桌面宿主是
`409 + code: "unsupported"`。

排查可以直接问它：

```powershell
Invoke-RestMethod -Headers @{ 'x-dsh-plugin-call' = 'app-restart' } `
  http://127.0.0.1:19387/app-restart/api/status | ConvertTo-Json -Depth 6
```

## 日志

每次重启一个运行目录：`%TEMP%\dsh-app-restart\<时间戳>-<宿主 pid>\restart.log`，
只保留最近 5 次（更老的会在下一次重启时清掉）。里面按时间戳记着：计划里的时间参数、
什么时候发的 SIGTERM、两个进程分别什么时候消失、有没有补刀、重新拉起的 pid、
以及失败时的原因（`ABORT: shell ... is still alive`）。

助手**不删**日志 —— 出问题时 `GET /log` 就能把尾巴取出来。

可用环境变量微调时间预算（单位毫秒，都会被钳制在合理区间内）：
`DSH_APP_RESTART_SETTLE_MS`、`DSH_APP_RESTART_SHELL_TIMEOUT_MS`、
`DSH_APP_RESTART_FORCE_TIMEOUT_MS`、`DSH_APP_RESTART_HOST_TIMEOUT_MS`、
`DSH_APP_RESTART_QUIET_MS`。

## 自测

```powershell
node test-host.mjs      # 52 项
node test-client.mjs    # 41 项
```

- `test-host.mjs`：注册契约、HTTP 行为（含跨站防线与各种拒绝），以及**把重启助手真的
  跑一遍** —— 用两个一次性替身进程模拟「外壳 + 宿主」（替身宿主和真宿主一样监听
  `disconnect`），验证「杀外壳 → 宿主随之消失 → 重新拉起」这条链路，并检查重新拉起时
  环境确实洗干净了（`ELECTRON_RUN_AS_NODE` 被剥掉）；另外覆盖「外壳早就没了」、
  「宿主不肯自己退 → 补刀」、「外壳杀不掉 → 放弃且不拉起任何东西」三条分支。
- `test-client.mjs`：mock Module Loader / React / fetch / window，把客户端半真的装起来，
  盯注册契约、菜单行的图标与中英文案、`run()` 打出去的请求（方法/头/body）、
  失败弹窗（非桌面端 / busy / host 半缺席 / 连弹窗都抛），以及降级路径
  （没有 `commandUi`、`scope.get` 抛错、没有 `ctx.inject`、绑不到 `t`）。里面的 `require`
  是严格的：除了基座里的 `react` 之外任何 require 都会让测试当场红。

两个测试都**不会**碰正在运行的 DSH：替身进程都是自己拉起来自己收掉的。

## 已知限制

- 重启**不带启动参数**（外壳只认 `--updated` 那个更新器交接参数）。桌面端本来也不吃
  别的启动参数，所以等价于用户从开始菜单再打开一次。
- 只覆盖桌面端。终端里的 `dsh web` 没有外壳可关，命令会报错并说明原因。
- **没有按钮、也没有二次确认**（这是刻意的：界面零足迹，只有明确打出来的命令才算数）。
  辅助功能上唯一的「确认」是命令菜单里那行字本身。
- 会打断正在跑的任务，且 Windows 上不是优雅停机（见上）。
- 路由在 127.0.0.1 上、没有鉴权：**本机**任何进程都能调它重启应用。桌面端本来就假定
  本机可信，这里只是把它写明。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-app-restart
```

然后重启一次 DSH（插件已经卸掉了，这次得手动退出再打开）。临时目录里的日志可以随手删掉。
