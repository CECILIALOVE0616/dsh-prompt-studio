// The one place this plugin talks to a model.
//
// Every call goes through the host's `llm` service — the plugin holds no API key,
// opens no socket to a provider and knows no endpoint. `ctx.get('llm')` rather than
// `inject` is deliberate: a composition without the llm service must still mount the
// workbench (its history and templates work offline), and the failure is reported to
// the user as a readable error when they press a button, not as a boot failure.
//
// The chunk-to-message assembly is `BlockAssembler`, the same class the agent loop
// uses, so a streamed answer is assembled exactly like a normal turn. Hand-rolling
// SSE parsing here would be a second, subtly different implementation of the
// platform's own contract.

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

/** Tag carried on every message this plugin contributes, for provenance in logs. */
export const SOURCE_KIND = 'plugin:dsh-prompt-studio'

/**
 * Read the llm service, or explain why the call cannot happen.
 *
 * @param ctx - the plugin context.
 * @returns the service.
 * @throws when the composition has no llm service.
 */
function requireLlm(ctx) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error(
      '提示词工作台：当前组合里没有 llm 服务，无法调用模型。' +
      '请确认 profile 里启用了 @deepseek-ai/dsh-llm（或同类）并已配置可用的模型。',
    )
  }
  return llm
}

/**
 * Describe the readable part of a failed finish.
 *
 * A stream can end with `finish.kind === 'error'` and still have assembled text, or
 * end cleanly with nothing in it. Both are failures from the caller's point of view,
 * but they need different sentences, so the reason is pulled out here instead of
 * being flattened into "empty response".
 */
function describeFinish(finish) {
  if (finish === undefined || finish === null) return 'unknown'
  const kind = typeof finish.kind === 'string' ? finish.kind : 'unknown'
  if (kind !== 'error' && kind !== 'aborted') return kind
  const failure = finish.failure
  const detail = typeof failure?.message === 'string' && failure.message !== ''
    ? failure.message
    : typeof failure?.code === 'string' ? failure.code : ''
  return detail === '' ? kind : `${kind}: ${detail}`
}

/** The text blocks of an assembled stream, joined. */
function textOf(assembler, interrupted) {
  // `blocks()` assembles every open partial and throws on a block type it cannot
  // finish — which is exactly what an aborted stream leaves behind (the mock and
  // real adapters alike can stop between block-start and block-end). The assembler
  // ships `interruptedBlocks()` for this case: it keeps the text that did arrive and
  // silently drops the rest. Asking for the interrupted view only when the stream was
  // cut short keeps the strict path for streams that ran to completion.
  const blocks = interrupted === true ? assembler.interruptedBlocks() : assembler.blocks()
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/**
 * Merge the caller's cancellation with this call's own deadline.
 *
 * `AbortSignal.any` needs a real signal; when the caller has none (an HTTP route
 * has no `exec.signal`) the timeout alone is the whole signal. The timeout exists so
 * one hung provider cannot hold a workbench request open forever.
 */
function callSignal(timeoutMs, external) {
  const deadline = AbortSignal.timeout(timeoutMs)
  if (external === undefined || external === null) return deadline
  return AbortSignal.any([external, deadline])
}

/**
 * Stream one model call and return its assembled text plus what it cost.
 *
 * @param ctx - the plugin context.
 * @param options - the call.
 * @param options.provider - provider id, already validated by the caller.
 * @param options.model - model id, already validated by the caller.
 * @param options.system - system prompt, or undefined for none.
 * @param options.user - the user message body.
 * @param options.maxTokens - token ceiling for this call.
 * @param options.timeoutMs - deadline for this call.
 * @param options.signal - the caller's cancellation, if any.
 * @param options.effort - reasoning effort id, when the model offers one.
 * @returns `{ text, usage, finish }`.
 */
export async function streamText(ctx, options) {
  const { provider, model, system, user, maxTokens, timeoutMs, signal, effort } = options
  const llm = requireLlm(ctx)

  const assembler = new BlockAssembler()
  const request = {
    provider,
    model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: user }],
      source: { kind: SOURCE_KIND },
    })],
    maxTokens,
    signal: callSignal(timeoutMs, signal),
    ...(typeof system === 'string' && system !== '' ? { system } : {}),
    ...(effort === undefined || effort === null ? {} : { reasoningEffort: effort }),
  }

  for await (const chunk of llm.stream(request)) {
    assembler.push(chunk)
  }

  const finish = assembler.finish
  const unfinished = finish?.kind === 'error' || finish?.kind === 'aborted'
  const text = textOf(assembler, unfinished)

  // A stream that ended in error or abort is reported as such even when some text
  // arrived: silently returning a half answer as if it were complete is how a
  // truncated prompt gets saved over a good one.
  if (unfinished) {
    throw new Error(`模型调用未完成（${describeFinish(finish)}）`)
  }
  if (text.trim() === '') {
    throw new Error(`模型返回了空内容（finish=${describeFinish(finish)}）`)
  }

  return { text, usage: assembler.usage, finish }
}

/**
 * Every provider the host has registered.
 *
 * @returns provider metadata, or an empty list when the service is absent.
 */
export function listProviders(ctx) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return []
  return llm.listProviders()
}

/**
 * The models one provider advertises.
 *
 * @returns model metadata, or an empty list (an unknown provider is not an error
 *   here — the caller is listing, not routing).
 */
export async function listModels(ctx, provider, signal) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || llm === null || typeof llm.listModels !== 'function') return []
  return await llm.listModels(provider, signal)
}

/**
 * Model ids that name a task other than "write text for me".
 *
 * The catalog carries no capability field — `listModels` returns only id, name,
 * description and input modalities — so a model that cannot answer a chat request
 * is indistinguishable from one that can, except by its name. This is a *ranking*
 * signal, never a filter: a host whose only model happens to match one of these
 * words must still be able to pick it, and a user who deliberately wants one must
 * still find it in the list.
 */
const NON_CHAT_HINT = /embed|rerank|whisper|tts|speech|dall|stable-diffusion|sdxl|flux|midjourney|image-gen|ocr|moderation|audio|vision-encoder/i

/** Whether a route looks like it is not a chat model. */
function looksNonChat(route) {
  return NON_CHAT_HINT.test(route.model) || NON_CHAT_HINT.test(route.name)
}

/**
 * Every `provider/model` route this host can actually call, chat-like models first.
 *
 * One provider whose catalog fails to load must not empty the whole selector, so a
 * per-provider failure is collected and reported alongside the routes that worked
 * rather than thrown.
 *
 * Ordering matters beyond taste: the panel preselects the first route, and a host
 * that happens to list an embedding model first (lmstudio does) would otherwise open
 * the workbench pointed at a model that cannot answer. The sort is stable, so within
 * each group the adapter's own preferred order survives untouched.
 *
 * @returns `{ routes, failures }`, where a route is `{ provider, model, name }`.
 */
export async function listRoutes(ctx, signal) {
  const routes = []
  const failures = []
  for (const provider of listProviders(ctx)) {
    const id = provider?.id
    if (typeof id !== 'string' || id === '') continue
    try {
      const models = await listModels(ctx, id, signal)
      for (const model of models) {
        if (typeof model?.id !== 'string' || model.id === '') continue
        routes.push({
          provider: id,
          model: model.id,
          name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        })
      }
    } catch (error) {
      failures.push({ provider: id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  // Stable partition: chat-like routes keep their catalog order ahead of the rest.
  const chat = routes.filter((route) => !looksNonChat(route))
  const rest = routes.filter(looksNonChat)
  return { routes: [...chat, ...rest], failures }
}

/**
 * Validate a route against the live catalog.
 *
 * A route the host does not know is an error rather than a silent fallback: quietly
 * answering from a different model than the one the user picked is worse than
 * refusing, because the result looks like it came from the chosen model.
 *
 * @returns the resolved route `{ provider, model }`.
 * @throws when the provider or the model is not registered.
 */
export async function assertRoute(ctx, provider, model, signal) {
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    throw new Error('提示词工作台：没有可用的模型路由，请先在工作台里选择模型。')
  }
  const providers = listProviders(ctx)
  if (providers.length === 0) {
    throw new Error('提示词工作台：当前 DSH 没有已注册的 provider，请先在设置里配置模型。')
  }
  if (!providers.some((entry) => entry?.id === provider)) {
    throw new Error(`提示词工作台：未知的 provider "${provider}"。`)
  }
  const models = await listModels(ctx, provider, signal)
  if (!models.some((entry) => entry?.id === model)) {
    throw new Error(`提示词工作台：provider "${provider}" 下没有模型 "${model}"。`)
  }
  return { provider, model }
}

/**
 * The lowest reasoning effort a model offers, for calls that want a reasoning model
 * to answer directly rather than deliberate.
 *
 * @returns an effort id, or undefined when the model has no reasoning metadata (the
 *   common case, and not an error).
 */
export async function lowestEffort(ctx, provider, model, signal) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || llm === null || typeof llm.resolveModelInfo !== 'function') return undefined
  try {
    const info = await llm.resolveModelInfo(provider, model, signal)
    const efforts = info?.reasoning?.efforts
    if (!Array.isArray(efforts) || efforts.length === 0) return undefined
    const first = efforts[0]
    return typeof first === 'string' ? first : first?.id
  } catch {
    // Metadata is an optimisation, never a precondition: a model whose info cannot
    // be resolved is still callable without an explicit effort.
    return undefined
  }
}
