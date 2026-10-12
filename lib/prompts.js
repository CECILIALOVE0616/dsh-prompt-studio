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
export const RUN_KINDS = ['optimize', 'iterate', 'test', 'analyze', 'compare']

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

/**
 * The system prompt for the analysis mode.
 *
 * The judge gets the two prompts and their two outputs and must answer in a fixed
 * JSON shape, so the UI can render verdict / gains / regressions without parsing
 * prose. The shape is spelled out literally and the model is told to answer with
 * JSON only, which is the cheapest reliable way to get one.
 *
 * @returns the system prompt.
 */
export function analyzeSystem() {
  return `你是一名严格的提示词评审。用户会给你两版提示词，以及它们在同一任务上的实际输出。

你要判断新版是否真的比旧版好，并且只输出一个 JSON 对象，不要输出任何其它文字，不要用代码围栏包起来。

JSON 结构：
{
  "verdict": "improved" | "mixed" | "worse",
  "gains": ["新版更好的具体点，逐条写"],
  "regressions": ["新版变差或丢失的具体点，逐条写"],
  "recommendation": "是否建议采用新版，一两句话说明理由"
}

评判要求：
- 基于两版输出在任务上的实际表现来判断，不要只看提示词写得更长更漂亮。
- 新版更长不等于更好；如果只是变啰嗦、加了没用的约束，要写进 regressions。
- gains 和 regressions 都要落到具体差异上，不要写"整体更好"这类空话。
- 如果两版差别不大，如实说，verdict 用 "mixed"。`
}

/**
 * Assemble the user message for a comparison run.
 *
 * @param prompt - the prompt under test.
 * @param task - the task text to run it against.
 * @returns the user message.
 */
export function testUserMessage(prompt, task) {
  return `下面是一段提示词，以及要用它完成的任务。

【提示词】
${prompt}

【任务】
${task}

请按提示词的要求完成这个任务，只输出任务结果本身。`
}

/**
 * Assemble the judge's user message.
 *
 * Both the prompts and both outputs are labelled explicitly: an unlabelled dump of
 * four text blocks invites the judge to guess which is which, and a swapped pair
 * silently inverts the verdict.
 *
 * @returns the user message.
 */
export function analyzeUserMessage(before, after, beforeOutput, afterOutput) {
  return `【旧版提示词】
${before}

【新版提示词】
${after}

【旧版提示词在同一任务上的输出】
${beforeOutput}

【新版提示词在同一任务上的输出】
${afterOutput}

请按要求输出 JSON。`
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

/**
 * Read the analysis answer, tolerating the packaging models add around JSON.
 *
 * The fenced form is handled first (a ```json block is the most common shape), then
 * the first balanced-looking `{...}` span, so a model that says "以下是评估结果："
 * before its JSON still parses.
 *
 * A malformed answer is NOT an error here: the caller shows the raw text next to
 * the parse failure, which is more useful than a generic "the model replied
 * badly".
 *
 * @param text - the model's raw answer.
 * @returns `{ verdict, gains, regressions, recommendation, raw, parsed }`, where
 *   `parsed` says whether the JSON was understood.
 */
export function parseAnalysis(text) {
  const raw = typeof text === 'string' ? text : ''
  const candidate = extractJson(raw)
  const empty = { verdict: null, gains: [], regressions: [], recommendation: '', raw, parsed: false }
  if (candidate === null) return empty

  let value
  try {
    value = JSON.parse(candidate)
  } catch {
    return empty
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return empty

  const verdict = value.verdict === 'improved' || value.verdict === 'mixed' || value.verdict === 'worse'
    ? value.verdict
    : null
  return {
    verdict,
    gains: stringList(value.gains),
    regressions: stringList(value.regressions),
    recommendation: typeof value.recommendation === 'string' ? value.recommendation : '',
    raw,
    parsed: true,
  }
}

/** A list of non-empty strings from whatever the model put in a field. */
function stringList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '')
}

/**
 * The first JSON object in a string.
 *
 * Scans for the first `{` and then tracks brace depth, ignoring braces inside
 * strings, so a nested object or a `}` inside a quoted string does not end the
 * span early. Returns null when nothing balances.
 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i)
  const source = fenced !== null && fenced[1] !== undefined ? fenced[1] : text

  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}
