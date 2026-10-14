// dsh-prompt-studio — 提示词工作台 (prompt workbench).
//
// Host half. Optimises a prompt with a model the HOST already has configured and
// keeps a version chain across iterations, and stores prompts / runs / templates in
// a per-workspace SQLite file. The browser half (`lib/client.js`) is the workbench UI.
//
// This plugin holds no API key and opens no connection to a provider: every model
// call goes through the host `llm` service (`lib/llm.js`). It also declares no
// `dependencies` — the `@deepseek-ai/*` packages it imports are provided by the
// host, and `@deepseek-ai/schemastery` (needed only for the settings page) is an
// optional peer that is soft-imported below.
//
// Its own `cordis.patch.yml` inserts the plugin row process-wide, which is why the
// `prompt_optimize` tool reaches every agent preset with no preset entry of its own
// (and why adding one there would fail with `tool "prompt_optimize" is already
// registered in this scope`).
//
// The implementation lives in `lib/`: `config` (defaults, environment overrides and
// the feature switches), `schema` (the schemastery interop hop), `store` (SQLite),
// `llm` (the model calls), `prompts` (the optimisation / iteration prompt
// text), `routes` (the browser-facing HTTP API), `tools` (the model-facing tool) and
// `client.js` (the workbench, a separate web-platform bundle).

import { resolveConfig } from './config.js'
import { mountRoutes } from './routes.js'
import { createPromptOptimizeTool } from './tools.js'
import { pickSchemaBuilder } from './schema.js'
import { readManifest } from './store.js'

export const name = 'dsh-prompt-studio'

/**
 * `tools` is the only service this plugin cannot work without: it registers the
 * model-facing `prompt_optimize` tool. Everything else — `webServer` (the browser
 * API), `jobs` (background comparisons), `settings` — is asked for with
 * `ctx.get(...)` at the point of use, so a composition that lacks one still mounts
 * the workbench and degrades one feature instead of failing to boot.
 */
export const inject = ['tools']

// The schema is what gives this plugin a settings page at all: the platform projects
// the config of every entry that declares one. It needs `@deepseek-ai/schemastery`,
// which a real DSH profile supplies (declared as an optional peer) but which is
// absent when this module is imported standalone. A soft import keeps the workbench
// runnable there — without a schema every field keeps its default and only the
// settings page is missing. The fragile part is the PICKING, not the import; see
// `lib/schema.js`.
let Schema = null
try {
  Schema = pickSchemaBuilder(await import('@deepseek-ai/schemastery'))
} catch {
  Schema = null
}
if (Schema === null) {
  console.warn(
    'dsh-prompt-studio: no schema builder (@deepseek-ai/schemastery) — ' +
    'the workbench runs on its defaults and the settings page stays hidden',
  )
}

/**
 * The plugin's own configuration.
 *
 * EVERY field is `.volatile()`, and that is not decoration: DSH's settings service
 * projects a plugin's config into a form only through `volatileForm()`, which keeps
 * a field only when its nearest ancestor is marked volatile — a schema without one
 * contributes no form at all, so the entry never reaches `ctx.settings.describe()`,
 * its namespace is never served to the browser, and the settings page waits for a
 * section that will never arrive.
 *
 * A volatile field must not sit inside another volatile one, so nested groups stay
 * plain objects whose LEAF fields are volatile.
 *
 * Note for readers of the values: a `.volatile()` field resolves to a CELL with
 * `.get()`, not to a plain value. `lib/config.js` unboxes it in one place.
 */
export const Config = Schema?.object({
  defaultMode: Schema.string().default('user').description('默认优化模式：user=用户提示词，system=系统提示词。').volatile(),
  defaultProvider: Schema.string().default('').description('默认 provider；留空表示跟随工作台里当前选中的模型。').volatile(),
  defaultModel: Schema.string().default('').description('默认 model；留空表示跟随工作台里当前选中的模型。').volatile(),
  maxTokens: Schema.number().default(4096).description('单次模型调用的 token 上限。').volatile(),
  timeoutMs: Schema.number().default(120000).description('单次模型调用的超时（毫秒）。').volatile(),
  maxPromptChars: Schema.number().default(20000).description('单条提示词的长度上限（字符）。').volatile(),
  historyLimit: Schema.number().default(200).description('历史记录一次最多返回多少条。').volatile(),
  toolEnabled: Schema.boolean().default(true).description('是否注册 `prompt_optimize` 工具；改动需重启 DSH 才生效。').volatile(),
}).description('提示词工作台的功能开关与默认值。')

/** The browser-facing route prefix. Namespaced by package name so it cannot collide. */
export const ROUTE_PREFIX = '/dsh-prompt-studio'

export function apply(ctx, settings = {}) {
  // Resolved once per mount. Behaviour reads this object at call time, so the
  // volatile-update hook below can change it in place without remounting.
  const config = resolveConfig(process.env, settings)

  // The model-facing tool. `toolEnabled` is read once, here, because it decides
  // which tools exist — that is the one setting the settings page marks as needing
  // a restart.
  if (config.toolEnabled) {
    try {
      ctx.tools.register(createPromptOptimizeTool({ ctx, config }))
    } catch (error) {
      console.error('dsh-prompt-studio: registering prompt_optimize failed', error)
    }
  }

  // The browser-facing API. Registered through `ctx.inject(['webServer'], ...)` so
  // the workbench still mounts on a host without a web server (a headless profile),
  // where only the model-facing tool is reachable.
  try {
    mountRoutes(ctx, { config, manifest: readManifest() })
  } catch (error) {
    console.warn('dsh-prompt-studio: could not publish the workbench routes', error)
  }

  // A volatile edit is written into the same object the loader handed us and then
  // announced, so re-resolving in place is what makes a changed default or timeout
  // take effect without a restart. `toolEnabled` is the exception (see above).
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      try {
        Object.assign(config, resolveConfig(process.env, settings))
      } catch (error) {
        console.error('dsh-prompt-studio: applying a live settings change failed', error)
      }
    })
  }
}
