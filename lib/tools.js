// The model-facing half of the workbench: `prompt_optimize`.
//
// This exists so an agent can hand a prompt to the same optimiser the panel uses,
// without the user opening the panel. It is deliberately a thin wrapper: the
// prompt text comes from `prompts.js`, the model call from `llm.js`, and the
// result is also written to the workspace database so an optimisation done from a
// conversation shows up in the panel's history like any other.
//
// Routing is the one place with no silent fallback. A route the host does not know
// is refused rather than replaced with a default: answering from a different model
// than the one asked for produces a result that LOOKS like it came from the
// requested model, which is worse than an error.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertRoute, streamText } from './llm.js'
import { optimizeSystem, iterateSystem, stripFences, MODES } from './prompts.js'
import { insertPrompt, insertRun, openDatabase } from './store.js'

/**
 * The workspace a call belongs to.
 *
 * A tool call always has a session, so `header.cwd` is the normal answer. The
 * process working directory is the fallback for a host that does not report one,
 * so a call in that situation still lands somewhere instead of throwing.
 */
function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return cwd
  return process.cwd()
}

/** The session id, for provenance in the run row. Null when unavailable. */
function sessionIdOf(exec) {
  const header = exec?.agent?.session?.header
  if (typeof header?.id === 'string') return header.id
  if (typeof exec?.agent?.session?.id === 'string') return exec.agent.session.id
  return null
}

/**
 * The route this call should use.
 *
 * Precedence: what the caller passed, then the plugin's configured default, then
 * the conversation's own route. The conversation is last on purpose — an explicit
 * default in settings is a decision the user made, while the conversation's route
 * is incidental.
 *
 * @returns `{ provider, model }` or null when nothing can be determined.
 */
async function resolveToolRoute(ctx, config, args, exec) {
  if (typeof args.provider === 'string' && args.provider !== '') {
    return { provider: args.provider, model: typeof args.model === 'string' ? args.model : '' }
  }
  if (config.defaultProvider !== '' && config.defaultModel !== '') {
    return { provider: config.defaultProvider, model: config.defaultModel }
  }

  // The live agent's own options are authoritative for a running conversation.
  const sessionId = sessionIdOf(exec)
  const agents = ctx.get?.('agents')
  const options = sessionId !== null ? agents?.get?.(sessionId)?.options : undefined
  if (typeof options?.provider === 'string' && typeof options?.model === 'string') {
    return { provider: options.provider, model: options.model }
  }

  // A conversation that has not run yet still carries its newest request header.
  const events = ctx.get?.('sessions')?.get?.(sessionId)?.snapshotEvents?.()
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const header = events[index]?.data?.header
      const route = header?.config
      if (typeof route?.provider === 'string' && typeof route?.model === 'string') {
        return { provider: route.provider, model: route.model }
      }
    }
  }
  return null
}

/**
 * Build the `prompt_optimize` tool.
 *
 * @param options.ctx - the plugin context.
 * @param options.config - the resolved configuration (read at call time, so a live
 *   settings change is picked up).
 * @returns a registry-ready tool definition.
 */
export function createPromptOptimizeTool({ ctx, config }) {
  return defineTool({
    name: 'prompt_optimize',
    description: [
      'Optimise a prompt with one of the models configured in this harness, and return the rewritten prompt.',
      '',
      'Use it when the user asks to improve, rewrite, tighten or structure a prompt they are writing.',
      'Pass `direction` to iterate on an existing version instead of doing a first-pass rewrite.',
      'The model is chosen from the harness configuration; this tool never asks for an API key.',
      '',
      'Do NOT use it to run the prompt under test — this tool only rewrites the prompt itself.',
    ].join('\n'),
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The original prompt to optimise. Pass the text itself, not a file path.',
      },
      mode: {
        type: 'string',
        description: 'Which kind of prompt this is: "system" (constrains model behaviour) or "user" (describes a task). Defaults to "user".',
        enum: MODES,
      },
      direction: {
        type: 'string',
        description: 'An iteration direction such as "使提示词更加简洁". When present the call iterates on `prompt` instead of doing a first-pass optimisation.',
      },
      provider: {
        type: 'string',
        description: 'Provider id to call. Omit to use the configured default or the current conversation route. An unknown value is an error.',
      },
      model: {
        type: 'string',
        description: 'Model id to call. Required when `provider` is given.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          optimized: { type: 'string', required: true, description: 'The rewritten prompt.' },
          provider: { type: 'string', required: true, description: 'The provider that answered.' },
          model: { type: 'string', required: true, description: 'The model that answered.' },
          elapsedMs: { type: 'number', required: true, description: 'Wall-clock time of the model call.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.optimized }],
    },
    execute: async (args, exec) => {
      // Cancellation is checked before anything expensive and again by the signal
      // handed to the model call.
      exec?.signal?.throwIfAborted?.()

      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new Error('prompt_optimize: `prompt` must be a non-empty string.')
      if (prompt.length > config.maxPromptChars) {
        throw new Error(
          `prompt_optimize: the prompt is ${prompt.length} characters, over the ${config.maxPromptChars} limit ` +
          '(raise it in the prompt-studio settings if this is intended).',
        )
      }

      const mode = args.mode === 'system' ? 'system' : 'user'
      const direction = typeof args.direction === 'string' ? args.direction.trim() : ''
      const iterating = direction !== ''

      const route = await resolveToolRoute(ctx, config, args, exec)
      if (route === null || route.model === '') {
        throw new Error(
          'prompt_optimize: no model route. Pass `provider` and `model`, ' +
          'or configure a default route in the prompt-studio settings.',
        )
      }
      // Validated against the live catalog, never trusted: an unknown route is an
      // error rather than a fallback.
      await assertRoute(ctx, route.provider, route.model, exec?.signal)

      const system = iterating
        ? iterateSystem(mode, direction)
        : optimizeSystem(mode, undefined)
      const user = iterating
        ? `【上一版提示词】\n${prompt}\n\n【迭代方向】\n${direction}\n\n请输出迭代后的完整提示词。`
        : prompt

      const startedAt = Date.now()
      const { text } = await streamText(ctx, {
        provider: route.provider,
        model: route.model,
        system,
        user,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        signal: exec?.signal,
      })
      const optimized = stripFences(text)
      const elapsedMs = Date.now() - startedAt

      // The run is recorded so a tool-driven optimisation appears in the panel's
      // history. A storage failure is logged and swallowed: the caller asked for an
      // optimisation, and it succeeded — losing the history row is not a reason to
      // fail the call.
      try {
        const workspace = workspaceOf(exec)
        const db = openDatabase(workspace)
        const now = Date.now()
        const promptId = insertPrompt(db, {
          workspace,
          mode,
          title: optimized.slice(0, 60),
          content: optimized,
          parentId: null,
          origin: iterating ? 'iterate' : 'optimize',
          createdAt: now,
        })
        insertRun(db, {
          workspace,
          kind: iterating ? 'iterate' : 'optimize',
          provider: route.provider,
          model: route.model,
          promptId,
          input: iterating ? direction : '',
          output: optimized,
          elapsedMs,
          createdAt: now,
        })
      } catch (error) {
        console.warn('dsh-prompt-studio: recording the tool run failed', error)
      }

      // Exactly the four declared fields: the registry validates the returned value
      // against `output.schema`, which is `additionalProperties: false`, so an extra
      // convenience field here would fail the whole call.
      return {
        optimized,
        provider: route.provider,
        model: route.model,
        elapsedMs,
      }
    },
  })
}
