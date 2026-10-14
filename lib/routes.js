// The browser-facing half of the workbench: a small JSON API on the host web server.
//
// Every route lives under `/dsh-prompt-studio`, the prefix the panel's `fetch` calls
// use. The routes are thin: they validate, resolve the workspace, call the same
// `llm.js` / `prompts.js` / `store.js` helpers the model-facing tool uses, and answer
// with JSON. No route holds state of its own.
//
// Three things are deliberate here and easy to get wrong:
//
//   1. The web server has no origin policy and no authentication — it is a plain
//      local HTTP server. So a WRITE route accepts only `content-type:
//      application/json`, which a cross-site HTML form cannot send (forms are
//      limited to urlencoded / multipart / text-plain). That is the whole CSRF
//      defence, and it is why every mutating route goes through `readJsonBody`.
//   2. Nothing from the client is trusted. A model name, a provider name and a
//      workspace path all come from the browser, so the route is validated against
//      the live catalog (`assertRoute`) and the workspace is resolved from the
//      session id on the HOST side, never taken from the request body.
//   3. The workspace is per-session, because that is what the user sees: the panel
//      is opened inside a conversation, and that conversation's `cwd` is where its
//      prompts belong.

import {
  assertRoute,
  listRoutes,
  lowestEffort,
  streamText,
} from './llm.js'
import {
  iterateSystem,
  MODES,
  optimizeSystem,
  stripFences,
} from './prompts.js'
import {
  deletePrompt,
  deleteRun,
  deleteTemplate,
  getPrompt,
  insertPrompt,
  insertRun,
  listPrompts,
  listRuns,
  listTemplates,
  openDatabase,
  promptChain,
  saveTemplate,
} from './store.js'

/** Requests larger than this are refused before they are parsed. */
const MAX_BODY_BYTES = 1 << 20

/** Longest accepted task text / prompt text, independent of the settings guard. */
const MAX_TEXT_CHARS = 200_000

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON request body.
 *
 * The `content-type` gate is the CSRF defence described at the top of this file, so
 * it runs before the body is touched: a request that fails it is refused without
 * reading anything.
 *
 * @throws a `HttpError` the handler turns into a response.
 */
async function readJsonBody(request) {
  const contentType = String(request.headers?.['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, '请求必须使用 content-type: application/json。')
  }

  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大。')
    chunks.push(buffer)
  }
  if (size === 0) return {}

  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON。')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是一个 JSON 对象。')
  }
  return parsed
}

/** An error that carries the status code its response should use. */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Answer with JSON. */
function sendJson(response, status, value) {
  if (response.headersSent) return
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Turn anything thrown by a handler into a readable JSON error. */
function sendError(response, error) {
  // Nobody is listening any more: the client disconnected mid-call and that is the
  // reason the handler threw in the first place. There is no one to answer and no
  // bug to report, so logging a stack trace here would train the reader to ignore
  // the log. The flag is set by abortOnDisconnect; `destroyed` catches the case
  // where node already tore the socket down before the handler noticed.
  if (response[CLIENT_GONE] === true || response.destroyed === true) {
    response.destroy()
    return
  }
  if (response.headersSent) {
    // The status line is already out; the only honest thing left is to cut the
    // connection so the client does not read a truncated body as success.
    response.destroy()
    return
  }
  const status = error instanceof HttpError ? error.status : 500
  const message = error instanceof Error ? error.message : String(error)
  if (status >= 500) console.warn('dsh-prompt-studio: a route failed', error)
  sendJson(response, status, { error: message })
}

/**
 * Wrap a handler so a thrown error becomes a response instead of a 400 from the
 * web server (which logs a warning and answers with nothing useful).
 */
function handler(fn) {
  return async (request, response) => {
    try {
      await fn(request, response)
    } catch (error) {
      sendError(response, error)
    }
  }
}

/** Refuse anything but the given method. */
function requireMethod(request, method) {
  if (request.method !== method) {
    throw new HttpError(405, `只接受 ${method} 请求。`)
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** A required non-empty string. */
function requireText(value, field, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `缺少 ${field}。`)
  }
  if (value.length > max) {
    throw new HttpError(400, `${field} 过长（${value.length} 字符，上限 ${max}）。`)
  }
  return value
}

/** An optional string, defaulted and trimmed. */
function optionalText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/** One of the two prompt modes. */
function readMode(value) {
  return value === 'system' ? 'system' : 'user'
}

/** A route as the client sends it: two strings that must survive validation. */
function readRoute(body, config) {
  const provider = optionalText(body.provider, config.defaultProvider)
  const model = optionalText(body.model, config.defaultModel)
  if (provider === '' || model === '') {
    throw new HttpError(400, '没有指定模型路由，请在工作台里选择一个模型。')
  }
  return { provider, model }
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/**
 * The workspace a request belongs to, resolved on the HOST side.
 *
 * The client sends a session id, never a path: a route that took a directory from
 * the request body would let any page on this machine point the plugin at an
 * arbitrary folder. `sessionPersistence` is the authoritative map from a session
 * to its `cwd`, and the result is cached because the panel asks on every request
 * and listing is not cheap.
 *
 * `stat(id)` answers for one session directly; `list()` is the fallback for a
 * backend that does not implement it. Both yield SessionPersistenceSnapshot
 * objects, whose `cwd` lives on the nested immutable `header` — reading `.id` off
 * the snapshot itself silently finds nothing.
 *
 * Falls back to the process working directory so a request from a session the host
 * no longer knows still lands somewhere instead of failing.
 */
const workspaceCache = new Map()

/** Pull the header out of a snapshot, tolerating a bare header as well. */
function headerOf(snapshot) {
  if (snapshot === undefined || snapshot === null) return undefined
  return snapshot.header !== undefined && snapshot.header !== null ? snapshot.header : snapshot
}

async function workspaceFor(ctx, sessionId) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    const cached = workspaceCache.get(sessionId)
    if (typeof cached === 'string') return cached
    try {
      const persistence = ctx.get?.('sessionPersistence')
      if (typeof persistence?.stat === 'function') {
        const header = headerOf(await persistence.stat(sessionId))
        if (typeof header?.cwd === 'string' && header.cwd !== '') {
          workspaceCache.set(sessionId, header.cwd)
          return header.cwd
        }
      } else if (typeof persistence?.list === 'function') {
        const snapshots = await persistence.list()
        for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
          const header = headerOf(snapshot)
          if (header?.id === sessionId && typeof header.cwd === 'string' && header.cwd !== '') {
            workspaceCache.set(sessionId, header.cwd)
            return header.cwd
          }
        }
      }
    } catch (error) {
      console.warn('dsh-prompt-studio: resolving the session workspace failed', error)
    }
  }
  return process.cwd()
}

/**
 * The open database for a request, or null when storage is unavailable.
 *
 * A read-only workspace (or a full disk) must not turn a successful optimisation
 * into a failed request: the caller asked the model for something and got it. The
 * failure is logged, the run is simply not recorded, and the response says so.
 */
function databaseFor(workspace) {
  try {
    return openDatabase(workspace)
  } catch (error) {
    console.warn(`dsh-prompt-studio: the workspace database is unavailable (${workspace})`, error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Model work
// ---------------------------------------------------------------------------

/**
 * Run one prompt against one model and return its text.
 *
 * @returns `{ text, elapsedMs }`.
 */
async function runOnce(ctx, config, route, system, user, signal) {
  const startedAt = Date.now()
  const effort = await lowestEffort(ctx, route.provider, route.model, signal)
  const { text } = await streamText(ctx, {
    provider: route.provider,
    model: route.model,
    system,
    user,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
    signal,
    effort,
  })
  return { text, elapsedMs: Date.now() - startedAt }
}

/** Record a run, tolerating an unavailable database. */
function recordRun(db, run) {
  if (db === null) return null
  try {
    return insertRun(db, run)
  } catch (error) {
    console.warn('dsh-prompt-studio: recording a run failed', error)
    return null
  }
}

/** Record a prompt version, tolerating an unavailable database. */
function recordPrompt(db, version) {
  if (db === null) return null
  try {
    return insertPrompt(db, version)
  } catch (error) {
    console.warn('dsh-prompt-studio: recording a prompt failed', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * The route the given session is already talking on, resolved on the HOST side.
 *
 * A model catalog is a flat list with no ordering guarantee, so "the first
 * route" is as likely to be an embedding model as a chat model. The session's
 * own live options are the only honest default, so the panel asks for them
 * instead of guessing. Returns null when the session is unknown or has not run
 * a turn yet — the panel then falls back to the configured default.
 */
function sessionRouteFor(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  try {
    const options = ctx.get?.('agents')?.get?.(sessionId)?.options
    if (typeof options?.provider === 'string' && typeof options?.model === 'string') {
      return { provider: options.provider, model: options.model }
    }
  } catch (error) {
    console.warn('dsh-prompt-studio: reading the session route failed', error)
  }
  return null
}

/**
 * `GET /models` — every callable route, plus the configured default.
 *
 * One provider whose catalog fails to load does not empty the selector; the
 * failures travel alongside the routes so the panel can show them.
 */
async function handleModels(ctx, config, request, response) {
  requireMethod(request, 'GET')
  const url = new URL(request.url ?? '/', 'http://localhost')
  const { routes, failures } = await listRoutes(ctx, undefined)
  const session = sessionRouteFor(ctx, url.searchParams.get('sessionId') ?? '')
  sendJson(response, 200, {
    routes,
    failures,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    sessionProvider: session === null ? '' : session.provider,
    sessionModel: session === null ? '' : session.model,
    maxPromptChars: config.maxPromptChars,
  })
}

/**
 * Reject an unknown route as a client error.
 *
 * `assertRoute` throws a plain Error because the llm layer knows nothing about
 * HTTP. Left alone that surfaces as a 500 plus a stack trace for what is a user
 * mistake (a stale model id, a provider that was removed). The panel shows the
 * message either way, but the status must say who is at fault.
 */
async function requireRoute(ctx, route, signal) {
  try {
    await assertRoute(ctx, route.provider, route.model, signal)
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error))
  }
}

/** Marker for "the client is already gone", so sendError can stay quiet. */
const CLIENT_GONE = Symbol('dsh-prompt-studio.clientGone')

/**
 * A signal that fires when the caller goes away.
 *
 * Without this a closed tab leaves the model streaming into a socket nobody reads:
 * the host keeps paying for tokens and the job keeps its slot until the timeout. The
 * request layer cannot supply the signal itself — it hands handlers a bare
 * `(request, response)` pair — so the disconnect has to be observed here.
 *
 * `response.on('close')` also fires on a normal end, hence the `writableEnded` test.
 */
function abortOnDisconnect(request, response) {
  const controller = new AbortController()
  const abort = () => {
    response[CLIENT_GONE] = true
    controller.abort(new Error('客户端已断开连接。'))
  }
  if (typeof request?.on === 'function') request.on('aborted', abort)
  if (typeof response?.on === 'function') {
    response.on('close', () => {
      if (response.writableEnded !== true) abort()
    })
  }
  return controller.signal
}

/** `POST /optimize` — one first-pass rewrite, stored as a new version. */
async function handleOptimize(ctx, config, request, response) {
  requireMethod(request, 'POST')
  const signal = abortOnDisconnect(request, response)
  const body = await readJsonBody(request)
  const prompt = requireText(body.prompt, 'prompt')
  const mode = readMode(body.mode)
  const route = readRoute(body, config)
  await requireRoute(ctx, route, signal)

  const template = optionalText(body.template)
  const { text, elapsedMs } = await runOnce(
    ctx,
    config,
    route,
    optimizeSystem(mode, template === '' ? undefined : template),
    prompt,
    signal,
  )
  const optimized = stripFences(text)

  const workspace = await workspaceFor(ctx, body.sessionId)
  const db = databaseFor(workspace)
  const now = Date.now()
  const promptId = recordPrompt(db, {
    workspace,
    mode,
    title: optionalText(body.title) || optimized.slice(0, 60),
    content: optimized,
    parentId: null,
    origin: 'optimize',
    createdAt: now,
  })
  const runId = recordRun(db, {
    workspace,
    kind: 'optimize',
    provider: route.provider,
    model: route.model,
    promptId,
    input: prompt,
    output: optimized,
    elapsedMs,
    createdAt: now,
  })

  sendJson(response, 200, {
    optimized,
    provider: route.provider,
    model: route.model,
    elapsedMs,
    promptId,
    runId,
    stored: db !== null,
  })
}

/**
 * `POST /iterate` — one version further along the chain.
 *
 * `parentId` links the new version to the one it came from, which is what makes the
 * panel's version chain and "roll back to this version" work; the client sends the
 * version it is iterating from.
 */
async function handleIterate(ctx, config, request, response) {
  requireMethod(request, 'POST')
  const signal = abortOnDisconnect(request, response)
  const body = await readJsonBody(request)
  const prompt = requireText(body.prompt, 'prompt')
  const mode = readMode(body.mode)
  const direction = optionalText(body.direction)
  const route = readRoute(body, config)
  await requireRoute(ctx, route, signal)

  const user = `【上一版提示词】\n${prompt}\n\n` +
    (direction === '' ? '' : `【迭代方向】\n${direction}\n\n`) +
    '请输出迭代后的完整提示词。'
  const { text, elapsedMs } = await runOnce(
    ctx,
    config,
    route,
    iterateSystem(mode, direction),
    user,
    signal,
  )
  const optimized = stripFences(text)

  const workspace = await workspaceFor(ctx, body.sessionId)
  const db = databaseFor(workspace)
  const now = Date.now()
  const parentId = Number.isInteger(body.parentId) ? body.parentId : null
  const promptId = recordPrompt(db, {
    workspace,
    mode,
    title: optionalText(body.title) || optimized.slice(0, 60),
    content: optimized,
    parentId,
    origin: 'iterate',
    createdAt: now,
  })
  const runId = recordRun(db, {
    workspace,
    kind: 'iterate',
    provider: route.provider,
    model: route.model,
    promptId,
    input: direction,
    output: optimized,
    elapsedMs,
    createdAt: now,
  })

  sendJson(response, 200, {
    optimized,
    provider: route.provider,
    model: route.model,
    elapsedMs,
    promptId,
    runId,
    stored: db !== null,
  })
}

/**
 * `GET /history` — prompt versions and runs for this workspace, newest first.
 *
 * `chain=<id>` additionally returns the version chain a prompt belongs to, so the
 * panel can open any history entry with its lineage already loaded.
 */
async function handleHistory(ctx, config, request, response) {
  requireMethod(request, 'GET')
  const url = new URL(request.url ?? '/', 'http://localhost')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const mode = url.searchParams.get('mode') ?? ''
  const limitRaw = Number(url.searchParams.get('limit'))
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : config.historyLimit

  const workspace = await workspaceFor(ctx, sessionId)
  const db = databaseFor(workspace)
  if (db === null) {
    sendJson(response, 200, { prompts: [], runs: [], chain: [], stored: false })
    return
  }

  const filter = { limit }
  if (mode === 'system' || mode === 'user') filter.mode = mode
  if (url.searchParams.get('provider')) filter.provider = url.searchParams.get('provider')
  if (url.searchParams.get('model')) filter.model = url.searchParams.get('model')

  const chainId = Number(url.searchParams.get('chain'))
  const chain = Number.isInteger(chainId) && chainId > 0 ? promptChain(db, workspace, chainId) : []

  sendJson(response, 200, {
    prompts: listPrompts(db, workspace, { limit, mode: filter.mode }),
    runs: listRuns(db, workspace, filter),
    chain,
    stored: true,
  })
}

/** `POST /history/delete` — remove one prompt version or one run. */
async function handleHistoryDelete(ctx, request, response) {
  requireMethod(request, 'POST')
  const body = await readJsonBody(request)
  const id = Number(body.id)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '缺少合法的 id。')
  // A whitelist, not a default: the earlier `kind === 'run' ? 'run' : 'prompt'`
  // silently turned any typo into "delete a prompt version", which is a data
  // loss bug wearing a parameter-validation costume.
  if (body.kind !== 'prompt' && body.kind !== 'run') {
    throw new HttpError(400, '缺少合法的 kind（只能是 "prompt" 或 "run"）。')
  }
  const kind = body.kind

  const workspace = await workspaceFor(ctx, body.sessionId)
  const db = databaseFor(workspace)
  if (db === null) throw new HttpError(503, '当前工作区无法写入数据库，删除未执行。')

  const removed = kind === 'run' ? deleteRun(db, workspace, id) : deletePrompt(db, workspace, id)
  sendJson(response, 200, { removed, kind, id })
}

/** `GET /templates` — the built-ins plus the user's own. */
async function handleTemplates(ctx, request, response) {
  requireMethod(request, 'GET')
  const url = new URL(request.url ?? '/', 'http://localhost')
  const workspace = await workspaceFor(ctx, url.searchParams.get('sessionId') ?? '')
  const db = databaseFor(workspace)
  if (db === null) {
    sendJson(response, 200, { templates: [], stored: false })
    return
  }
  sendJson(response, 200, { templates: listTemplates(db, workspace), stored: true })
}

/** `POST /templates` — save (or overwrite) a user template. */
async function handleTemplateSave(ctx, request, response) {
  requireMethod(request, 'POST')
  const body = await readJsonBody(request)
  const name = requireText(body.name, 'name', 200)
  const templateBody = requireText(body.body, 'body')
  const mode = readMode(body.mode)

  const workspace = await workspaceFor(ctx, body.sessionId)
  const db = databaseFor(workspace)
  if (db === null) throw new HttpError(503, '当前工作区无法写入数据库，模板未保存。')

  const saved = saveTemplate(db, workspace, { name, mode, body: templateBody })
  // A built-in name is protected: the shipped set must stay intact, so overwriting
  // one is refused rather than silently replacing a template the user did not write.
  if (saved === null) throw new HttpError(409, `"${name}" 是内置模板，不能覆盖；请换一个名字。`)
  sendJson(response, 200, { id: saved.id, replaced: saved.replaced, name, mode })
}

/** `POST /templates/delete` — remove a user template. */
async function handleTemplateDelete(ctx, request, response) {
  requireMethod(request, 'POST')
  const body = await readJsonBody(request)
  const id = Number(body.id)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '缺少合法的 id。')

  const workspace = await workspaceFor(ctx, body.sessionId)
  const db = databaseFor(workspace)
  if (db === null) throw new HttpError(503, '当前工作区无法写入数据库，删除未执行。')

  sendJson(response, 200, { removed: deleteTemplate(db, workspace, id) })
}

/**
 * `POST /prompts/save` — keep the panel's current text as a version of its own.
 *
 * This is the "存入历史" button, and it must land in `prompts` — the table the
 * history list reads. An earlier version sent it to `/templates/save`, so the
 * button reported success while the version never showed up in history at all.
 *
 * The row is a root (`parent_id` NULL) with `origin: 'manual'`: it did not come
 * from a model, and the history list already has a label for that origin.
 */
async function handlePromptSave(ctx, request, response) {
  requireMethod(request, 'POST')
  const body = await readJsonBody(request)
  const content = requireText(body.content, 'content')
  const mode = readMode(body.mode)

  const workspace = await workspaceFor(ctx, body.sessionId)
  const db = databaseFor(workspace)
  if (db === null) throw new HttpError(503, '当前工作区无法写入数据库，未存入历史。')

  const title = optionalText(body.title) || content.slice(0, 60)
  const id = recordPrompt(db, {
    workspace,
    mode,
    title,
    content,
    parentId: null,
    origin: 'manual',
    createdAt: Date.now(),
  })
  if (id === null) throw new HttpError(503, '当前工作区无法写入数据库，未存入历史。')
  sendJson(response, 200, { id, title, mode, origin: 'manual' })
}

/** `GET /prompt?id=` — one stored version, with its chain. */
async function handlePrompt(ctx, request, response) {
  requireMethod(request, 'GET')
  const url = new URL(request.url ?? '/', 'http://localhost')
  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '缺少合法的 id。')

  const workspace = await workspaceFor(ctx, url.searchParams.get('sessionId') ?? '')
  const db = databaseFor(workspace)
  if (db === null) throw new HttpError(503, '当前工作区无法读取数据库。')

  const prompt = getPrompt(db, workspace, id)
  if (prompt === undefined) throw new HttpError(404, `没有 id=${id} 的提示词。`)
  sendJson(response, 200, { prompt, chain: promptChain(db, workspace, id) })
}

/**
 * `GET /health` — what the host sees, for troubleshooting.
 *
 * Reports the plugin's version, whether the model service is reachable, how many
 * providers are registered and where the workspace database lives. This is the
 * first thing to ask for when the panel is empty: it separates "the host has no
 * models" from "the panel cannot reach the host".
 */
async function handleHealth(ctx, config, manifest, request, response) {
  requireMethod(request, 'GET')
  const url = new URL(request.url ?? '/', 'http://localhost')
  const workspace = await workspaceFor(ctx, url.searchParams.get('sessionId') ?? '')
  const llm = ctx.get?.('llm')
  const { routes, failures } = await listRoutes(ctx, undefined)
  let database = null
  try {
    const db = databaseFor(workspace)
    database = db === null ? 'unavailable' : 'ready'
  } catch {
    database = 'unavailable'
  }
  sendJson(response, 200, {
    name: manifest?.name ?? 'dsh-prompt-studio',
    version: manifest?.version ?? null,
    llm: llm === undefined || llm === null ? 'missing' : 'ready',
    providers: routes.length,
    routes: routes.length,
    failures,
    workspace,
    database,
    defaultMode: config.defaultMode,
  })
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * Publish every route on the host web server.
 *
 * Registered through `ctx.inject(['webServer'], ...)` rather than a hard
 * dependency: a headless profile has no web server at all, and there the workbench
 * should still mount (the model-facing tool keeps working) instead of failing to
 * boot. Inside the injection the service is checked before use, and each disposer is
 * handed to `inner.effect` so an unload or a reload releases the paths — a second
 * registration of the same path throws, so a leaked route would break the reload.
 *
 * @param ctx - the plugin context.
 * @param options.config - the resolved configuration.
 * @param options.manifest - `{ name, version }` for the panel's footer and `/health`.
 */
export function mountRoutes(ctx, options) {
  const { config, manifest } = options
  const prefix = '/dsh-prompt-studio'

  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (inner) => {
    const webServer = inner.webServer
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      console.warn('dsh-prompt-studio: this host has no web server; the workbench UI is unavailable')
      return
    }

    const publish = (path, fn, label) => {
      const disposer = webServer.register({ kind: 'exact', path, handler: handler(fn) })
      if (typeof inner.effect === 'function') inner.effect(() => disposer, label)
    }

    publish(`${prefix}/models`, (request, response) => handleModels(ctx, config, request, response), 'dsh-prompt-studio: models')
    publish(`${prefix}/optimize`, (request, response) => handleOptimize(ctx, config, request, response), 'dsh-prompt-studio: optimize')
    publish(`${prefix}/iterate`, (request, response) => handleIterate(ctx, config, request, response), 'dsh-prompt-studio: iterate')
    publish(`${prefix}/history`, (request, response) => handleHistory(ctx, config, request, response), 'dsh-prompt-studio: history')
    publish(`${prefix}/history/delete`, (request, response) => handleHistoryDelete(ctx, request, response), 'dsh-prompt-studio: history delete')
    publish(`${prefix}/templates`, (request, response) => handleTemplates(ctx, request, response), 'dsh-prompt-studio: templates')
    publish(`${prefix}/templates/save`, (request, response) => handleTemplateSave(ctx, request, response), 'dsh-prompt-studio: template save')
    publish(`${prefix}/templates/delete`, (request, response) => handleTemplateDelete(ctx, request, response), 'dsh-prompt-studio: template delete')
    publish(`${prefix}/prompts/save`, (request, response) => handlePromptSave(ctx, request, response), 'dsh-prompt-studio: prompt save')
    publish(`${prefix}/prompt`, (request, response) => handlePrompt(ctx, request, response), 'dsh-prompt-studio: prompt')
    publish(`${prefix}/health`, (request, response) => handleHealth(ctx, config, manifest, request, response), 'dsh-prompt-studio: health')
  })
}
