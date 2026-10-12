# dsh-prompt-studio 提示词工作台

DSH 插件。在左栏提供一个「提示词」面板，用来优化提示词、多轮迭代、多模型对比测试、保存模板与查看历史。

对标 Prompt Optimizer 的核心能力，但只做提示词，不含图像工作区、提示词花园、MCP、多消息工作区、变量与函数测试。

## 它做什么

- **优化**：给一段原始提示词，选一个已配置的模型，拿回一个改写后的提示词。
- **迭代**：在上一版基础上按方向调整（"更简洁"、"补上输出格式约束"……），形成版本链，可回退到任意一版。
- **测试对比**：单模型测试、2–4 个模型并排对比、裁判模型分析「原始 vs 优化后」的得失。
- **模板与历史**：内置模板（结构化扩写 / 精简压缩 / 加输出格式约束 / 角色设定补全），可另存；历史按时间倒序，可筛选、删除、重新载入。
- **工具**：agent 可直接调用 `prompt_optimize`。

## 它不做什么

- 不管理 API Key，不直连任何第三方服务。所有模型调用都走宿主已有的 `llm` 服务（`ctx.get('llm')`），用的是你在 DSH 里已经配好的 provider / model。
- 不引入构建步骤。宿主侧是原生 ESM，浏览器侧是手写的 bundle。
- 除了 `@deepseek-ai/*` 与 Node 内置模块，没有任何依赖。

## 安装

本插件是一个 DSH **profile bundle**，不能靠 `npm install -g` 生效——它必须被装进某个 DSH profile 才会注册面板、工具与路由。

发布到 npm 后，最简单的方式是让 DSH 自己按包名安装：

```bash
dsh plugin --profile <profile> add dsh-prompt-studio
```

或者从源码构建出 `.tgz` 再装：

```bash
git clone https://github.com/CECILIALOVE0616/dsh-prompt-studio.git
cd dsh-prompt-studio
npm pack            # 产出 dsh-prompt-studio-<version>.tgz
```

无需 `npm install`：本插件没有运行时依赖（`dependencies` 为空），peer 依赖全部由 DSH 宿主提供。

然后用 DSH 自己的安装入口把这个 tgz 装进目标 profile。两种方式二选一：

- **桌面应用**：用宿主提供的插件安装接口装上该 `.tgz`（本机实测走的是这条路）。
- **CLI**：`dsh plugin --profile <profile> add ./dsh-prompt-studio-<version>.tgz`。

装完重载 DSH，左栏会出现「提示词」入口。

两点注意：

- `add` 只接受包名或 `.tgz` 路径，不接受目录。
- **`desktop` profile 由 Electron 桌面应用独占管理**，CLI 对它执行 `add` 会直接报
  `profile "desktop" is managed exclusively by the Electron application`。桌面场景请走应用的安装接口。
- 宿主侧代码（`lib/*.js` 里除 `client.js` 外的部分）只在 DSH 启动时加载，装完必须重载；
  浏览器侧 `client.js` 每次页面加载都会从磁盘重新取，刷新即可生效。

## 设置

在 DSH 设置页的插件分区里可以改：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultMode` | `user` | 打开面板时的默认模式（用户提示词 / 系统提示词） |
| `defaultProvider` / `defaultModel` | 空 | 默认模型；留空则用会话当前路由 |
| `maxTokens` | `4096` | 单次调用的输出上限 |
| `timeoutMs` | `120000` | 单次调用超时（上限 30 分钟） |
| `compareMax` | `4` | 对比模式最多勾选几个模型 |
| `maxPromptChars` | `20000` | 单条提示词长度上限 |
| `historyLimit` | `200` | 历史列表一次取多少条 |
| `toolEnabled` | `true` | 是否注册 `prompt_optimize` 工具 |

除 `toolEnabled` 外都支持热更新：改完立刻生效，不用重启。**`toolEnabled` 需要重启 DSH**——它决定工具在启动时注不注册，这类开关不享受热更新。

也可以走环境变量：`DSH_PROMPT_STUDIO_MODE` / `_PROVIDER` / `_MODEL` / `_MAX_TOKENS` / `_TIMEOUT_MS` / `_COMPARE_MAX` / `_TOOL`。优先级是「插件设置 > 环境变量 > 内置默认」。

## 数据放在哪

每个工作区各自一个 SQLite 库：`<工作区>/.dsh-prompt-studio/prompt-studio.db`。三张表：

- `prompts`：提示词版本（含 `parent_id` 版本链）
- `runs`：每次模型调用（优化 / 迭代 / 测试 / 分析 / 对比）
- `templates`：模板（内置 + 自建）

用的是 Node 内置的 `node:sqlite`，不需要额外装数据库。库是按工作区隔离的，换个项目就是另一套历史。

## 工具：`prompt_optimize`

```
prompt_optimize(prompt, mode?, direction?, provider?, model?)
  → { optimized, provider, model, elapsedMs }
```

- `prompt`：必填，原始提示词。
- `mode`：`system` 或 `user`，默认 `user`。
- `direction`：给了就按迭代模式走（在上一版基础上按方向调整），不给就是通用优化。
- `provider` / `model`：不传则用会话当前路由。传了非法值会直接报错，不会静默回退到别的模型。

调用过程中可以用 `exec.signal` 中断。

## 结构

```
lib/
  index.js    入口：Config、注册工具、挂路由、热更新钩子
  schema.js   schemastery 软导入（解构 {Schema} 会静默拿到 undefined）
  config.js   配置解析（设置 > 环境变量 > 默认），含 volatile cell 解包
  llm.js      对宿主 llm 服务的封装（streamText / listRoutes / assertRoute）
  prompts.js  提示词工程：优化 / 迭代 / 分析的系统提示词，以及容错解析
  store.js    node:sqlite 存储层
  routes.js   浏览器侧 HTTP API（/dsh-prompt-studio/*）
  tools.js    prompt_optimize 工具定义
  client.js   浏览器 bundle（手写，无构建步骤）
```

## 排查

| 症状 | 原因 |
| --- | --- |
| 插件完全没出现 | `cordis.patch.yml` 的 `insert` 没并入 profile，或者没重载 DSH |
| 左栏有入口但面板打不开 | 客户端 id 与左栏项的 `id`、主区的 `key` 不一致；或 `exports.inject` 少了 `slots` |
| 设置页没有本插件的分区 | `Config` 没导出，或 schemastery 软导入拿到的不是 builder |
| `tool "prompt_optimize" is already registered` | agent preset 里重复声明了这个工具 |
| LLM 调用报 503 / undefined | `ctx.get('llm')` 是空的 |

## 许可

MIT © CECILIALOVE0616
