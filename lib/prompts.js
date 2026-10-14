// The prompt text this plugin sends to a model, and the parsing of what comes back.
//
// This is the business core: the difference between a useful workbench and a
// wrapper around "rewrite this" is entirely in these instructions. Each builder
// returns a SYSTEM prompt — an instruction to the model about how to rewrite —
// while the user's own text travels as the user message.
//
// Two rules run through all of them. The model must output the artefact and
// nothing else (no preamble, no before/after, no explanation), because the answer
// is stored as a prompt and shown in an editor. And the answer is never trusted
// to be clean: models wrap output in fences and open with "好的，以下是…", so
// `stripFences` is applied to every non-JSON answer before it is stored.

/** Mode names, in the order the UI offers them. */
export const MODES = ['user', 'system']

/** The modes, described for the UI and for validation messages. */
export const MODE_LABELS = {
  user: '用户提示词',
  system: '系统提示词',
}

/** Run kinds, matching the `runs.kind` column. */
export const RUN_KINDS = ['optimize', 'iterate']

/** What each mode means to the model, woven into every system prompt. */
function modeClause(mode) {
  return mode === 'system'
    ? '这是一段系统提示词（system prompt），它的作用是约束模型的行为方式。'
    : '这是一段用户提示词（user prompt），它的作用是描述一个具体任务。'
}

/** The shared preamble: the persona plus the rules that hold for every rewrite. */
function rewriteRules(mode) {
  return `你是一名提示词工程师。${modeClause(mode)}

改写原则：
1. 保留用户的原意、领域和语气，不要替换成另一个任务。
2. 补全缺失的结构：角色设定、任务目标、输入说明、约束条件、输出格式、质量标准。
3. 把模糊的形容词换成可判定的要求（"写得好" → "不超过 200 字，分 3 点，每点带一个例子"）。
4. 删除自相矛盾、重复、与任务无关的内容。
5. 不要解释你的改动，不要输出前后对比，不要加任何前言或结语，只输出改写后的提示词本身。
6. 用 Markdown 输出，但不要用代码围栏把整段结果包起来。`
}

/**
 * The system prompt for a first-pass optimisation.
 *
 * @param mode - `system` or `user`.
 * @param template - an optional template body to use as the instruction instead of
 *   the built-in rules (a template the user picked, or one saved earlier).
 * @returns the system prompt.
 */
export function optimizeSystem(mode, template) {
  if (typeof template === 'string' && template.trim() !== '') {
    return `${template.trim()}

${modeClause(mode)}

不要解释你的改动，不要输出前后对比，不要加任何前言或结语，只输出改写后的提示词本身，并且不要用代码围栏把整段结果包起来。`
  }
  return rewriteRules(mode)
}

/**
 * The system prompt for one iteration.
 *
 * The direction is stated in the SYSTEM prompt while the previous version travels
 * as the user message, so the model sees "adjust THIS along THAT line" as an
 * instruction rather than as two interchangeable blobs of text.
 *
 * @param mode - `system` or `user`.
 * @param direction - what to change; empty means a general iteration.
 * @returns the system prompt.
 */
export function iterateSystem(mode, direction) {
  const asked = typeof direction === 'string' ? direction.trim() : ''
  const goal = asked === ''
    ? '在不改变原意的前提下，把这个提示词整体打磨得更好用。'
    : `按下面这个方向调整它：${asked}`
  return `${rewriteRules(mode)}

这是一次迭代：用户已经有一个可用的版本，你要在它的基础上改进。${goal}

要求：
- 只做这个方向上的改动，其余部分保持稳定，不要顺手重写整段。
- 如果方向与原始意图冲突，以原始意图为准，并在结果里把冲突处理掉，而不是照着做一个坏提示词。
- 只输出改进后的完整提示词本身。`
}

/** A line that is nothing but a fence, with an optional language tag. */
const FENCE_LINE = /^\s*```[^\n`]*\s*$/

/**
 * Remove the model's packaging from an answer, leaving the artefact.
 *
 * Three things are stripped, in this order:
 *
 *   1. an outer code fence, when the FIRST non-blank line opens one — the closing
 *      fence is the last one, so trailing prose after it is dropped too;
 *   2. a leading conversational line ("好的，以下是优化后的提示词："), only when it
 *      is a single short line that ends in a colon or a full stop AND more text
 *      follows it — otherwise a one-line answer that happens to end in a colon
 *      would be deleted entirely;
 *   3. surrounding blank space.
 *
 * Only ONE leading line is removed, and only when it reads like a preamble. A
 * first line that is part of the prompt itself ("你是一名资深编辑。") is left
 * alone, because removing it would corrupt the result.
 *
 * @param text - the model's raw answer.
 * @returns the cleaned text.
 */
export function stripFences(text) {
  if (typeof text !== 'string') return ''
  let value = text.trim()

  const lines = value.split('\n')
  const firstNonBlank = lines.findIndex((line) => line.trim() !== '')
  if (firstNonBlank >= 0 && FENCE_LINE.test(lines[firstNonBlank])) {
    let lastFence = -1
    for (let index = lines.length - 1; index > firstNonBlank; index -= 1) {
      if (FENCE_LINE.test(lines[index])) {
        lastFence = index
        break
      }
    }
    // An unterminated fence is still packaging: drop the opening line and keep the
    // body, rather than returning the fence as part of the prompt.
    const body = lastFence > firstNonBlank
      ? lines.slice(firstNonBlank + 1, lastFence)
      : lines.slice(firstNonBlank + 1)
    value = body.join('\n').trim()
  }

  const preamble = /^(好的|好，|以下是|下面是|这是|这是优化后的|已按|已根据|根据你的要求|按照你的要求|Sure|Here('s| is)|Certainly)[^\n]{0,80}$/
  const all = value.split('\n')
  const head = all.findIndex((line) => line.trim() !== '')
  if (head >= 0 && head < all.length - 1) {
    const line = all[head].trim()
    const looksLikeLead = preamble.test(line) || (/[：:]$/.test(line) && line.length <= 40)
    if (looksLikeLead) {
      value = all.slice(head + 1).join('\n').trim()
    }
  }

  return value.trim()
}

