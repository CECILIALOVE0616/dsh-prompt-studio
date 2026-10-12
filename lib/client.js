// dsh-prompt-studio, browser half.
//
// This file is a PLAIN hand-written bundle, exactly like the ones DSH ships: no
// build step, no `import`/`export` keywords, no JSX, no TypeScript. The page
// loads it as a script, the module loader below hands it a `require`, and the
// only two modules it may ask for are React and the client UI primitives.
//
// What it contributes:
//   - one rail entry in the left sidebar (`sidebar.panellist`, a list seat), and
//   - the workbench behind that entry (`main`, a keyed seat under the same id).
//
// The workbench talks to its Host half over the routes `lib/routes.js` publishes
// under `/dsh-prompt-studio`. It holds no model credentials and calls no provider
// directly: every model call is a POST that the Host turns into an `llm.stream`
// call. The browser side only ever sees prompts and results.
//
// Layout facts this file depends on (all verified against the shipped client):
//   - `sidebar.panellist` entries carry `id`, `order` and `label`, and render
//     their own icon (there is no icon field).
//   - `main` is keyed by that same id. It is a ROOT-scoped seat, so its `inject`
//     callback is called with `(actions)`, NOT with a session id, and its
//     catalog states that only the reserved `conversation` key receives a
//     Session binding. The session id therefore comes from the standard
//     `useSessions` selector hook the slot renderer hands every root occupant.
//   - Both seats are registered from the innermost `slots.inject` callback, so
//     the rail entry and the panel appear together or not at all.
//
// The session's workspace is resolved on the HOST side from the session id; this
// file only passes the id along and displays the workspace it gets back.

window.__ModuleLoader__.load({
  id: 'dsh-prompt-studio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    /**
     * Panel identity. The layout pairs one `sidebar.panellist` entry with the
     * `main` entry registered under the same key, so these two must agree; the
     * rail entry's `label` is the visible text, the accessible name and the
     * collapsed tooltip.
     */
    const PANEL_ID = 'dsh-prompt-studio'

    /** Route prefix, kept in step with `ROUTE_PREFIX` in the Host half. */
    const API = '/dsh-prompt-studio'

    /**
     * Selectors for the standard `useSessions` hook the slot renderer binds for
     * every root occupant.
     *
     * `main` is a ROOT-scoped seat: its `inject` callback is called with
     * `(actions)`, never with a session id, and its catalog says that only the
     * reserved `conversation` key receives a Session binding. The active session
     * is therefore read through the standard hook, which the renderer hands the
     * occupant as `props.useSessions`. Both selectors tolerate a host that
     * installs no session catalog at all.
     */
    // The sessions catalog snapshot is `{ ids, byId, phase, projectionsBySession }`.
    // There is no `current` field: the live session is the one the main view
    // retains, and `retainedBy.mainView` is the count that says so. Newest
    // `updatedAt` is the fallback for a host that publishes no retain counts.
    const activeRow = (state) => {
      const byId = state?.byId
      if (byId === undefined || byId === null) return null
      let newest = null
      let newestAt = -1
      for (const id of Object.keys(byId)) {
        const row = byId[id]
        if (row === undefined || row === null) continue
        if ((row.retainedBy?.mainView ?? 0) > 0) return row
        const at = typeof row.updatedAt === 'number' ? row.updatedAt : 0
        if (at > newestAt) {
          newestAt = at
          newest = row
        }
      }
      return newest
    }

    const selectSessionId = (state) => {
      const row = activeRow(state)
      return row !== null && typeof row.id === 'string' && row.id !== '' ? row.id : null
    }

    const selectWorkspace = (state) => {
      const row = activeRow(state)
      return row !== null && typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null
    }

    /**
     * Stand-in for `props.useSessions` on a stripped host.
     *
     * It is a plain function with no hooks of its own, so the panel may always
     * call its selector unconditionally: React never sees a conditional hook.
     */
    function useNoSessions() {
      return undefined
    }

    // Theme tokens, read as CSS custom properties so the panel follows the
    // active light/dark theme without importing any stylesheet. Each carries a
    // neutral fallback: an unknown token must not make text invisible.
    const LABEL_PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
    const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
    const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, inherit)'
    const LABEL_CAPTION = 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, inherit))'
    const BORDER_L1 = 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18))'
    const BORDER_L2 = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25))'
    // `--dsw-alias-bg-base` is literally `transparent` in this theme: painting a
    // panel with it makes the content float on whatever the shell shows through
    // (a wallpaper, when the wallpaper plugin is installed). Surfaces therefore
    // use the module fill, and controls use the opaque layer fill.
    const BG_PANEL = 'var(--dsw-alias-bg-module-platform, rgba(14, 31, 32, 0.59))'
    const BG_FIELD = 'var(--dsw-alias-bg-layer-1, #232324)'
    const BG_MODULE = 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))'
    const BG_HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1))'
    const ACCENT = 'var(--dsw-alias-state-business-primary, #4f6ef7)'
    const DANGER = 'var(--dsw-alias-state-error-primary, #d14343)'
    const WARN = 'var(--dsw-alias-state-warn-primary, #b45309)'
    const SUCCESS = 'var(--dsw-alias-state-success-primary, #2f9e44)'
    const MONO = 'var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)'
    const RADIUS = 'var(--dsw-radius-xs, 4px)'

    const MODES = [
      { value: 'user', label: '用户提示词' },
      { value: 'system', label: '系统提示词' },
    ]

    // -----------------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------------

    /** The `provider/model` key a route is addressed by in the UI. */
    function routeKey(route) {
      return route === null || route === undefined ? '' : route.provider + '/' + route.model
    }

    // A model id that names a task other than "write text for me". The catalog
    // carries no capability field, so this is the only signal available. It is a
    // *ranking* signal, never a filter: a host whose only model matches one of
    // these words must still be able to pick it. The Host half sorts the same way,
    // but the panel must not depend on that — an older Host may not have sorted,
    // and the selector has to be sensible either way.
    const NON_CHAT_HINT = /embed|rerank|whisper|tts|speech|dall|stable-diffusion|sdxl|flux|midjourney|image-gen|ocr|moderation|audio|vision-encoder/i

    /** Whether a route looks like it is not a chat model. */
    function looksNonChat(route) {
      return NON_CHAT_HINT.test(route.model) || NON_CHAT_HINT.test(route.name)
    }

    /** The first route worth preselecting: a chat-like one if the catalog has any. */
    function preferredRoute(routes) {
      if (routes.length === 0) return ''
      const chat = routes.find((route) => !looksNonChat(route))
      return routeKey(chat === undefined ? routes[0] : chat)
    }

    /** Split a route key back into `{ provider, model }`. */
    function parseRouteKey(key) {
      if (typeof key !== 'string') return null
      const slash = key.indexOf('/')
      if (slash <= 0) return null
      return { provider: key.slice(0, slash), model: key.slice(slash + 1) }
    }

    /** A human duration. */
    function formatMs(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return ms + ' ms'
      return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'
    }

    /** A human timestamp. */
    function formatTime(value) {
      const date = new Date(typeof value === 'number' ? value : Number(value))
      if (isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** The one-line label a version is listed under. */
    function versionTitle(row) {
      const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : ''
      if (title !== '') return title.length > 40 ? title.slice(0, 40) + '…' : title
      const content = typeof row.content === 'string' ? row.content.replace(/\s+/g, ' ').trim() : ''
      return content === '' ? '（空）' : content.slice(0, 40) + (content.length > 40 ? '…' : '')
    }

    /** The origin of a version, in Chinese. */
    const ORIGIN_LABELS = {
      manual: '手写',
      optimize: '优化',
      iterate: '迭代',
      template: '模板',
    }

    /** What each run kind means, in Chinese. */
    const KIND_LABELS = {
      optimize: '优化',
      iterate: '迭代',
      test: '测试',
      analyze: '分析',
      compare: '对比',
    }

    /**
     * One JSON request to the Host half.
     *
     * A failed request is turned into an Error carrying the Host's own message:
     * the panel shows that text verbatim rather than a generic failure, because
     * "provider "x" 下没有模型 "y"" is actionable and "请求失败" is not.
     */
    async function callApi(path, options) {
      const opts = options === undefined ? {} : options
      const method = opts.method === undefined ? 'GET' : opts.method
      const init = { method }
      if (method !== 'GET') {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(opts.body === undefined ? {} : opts.body)
      }
      const response = await fetch(API + path, init)
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (response.ok !== true) {
        const message = payload !== null && typeof payload.error === 'string'
          ? payload.error
          : '请求失败（HTTP ' + response.status + '）'
        throw new Error(message)
      }
      return payload
    }

    // -----------------------------------------------------------------------
    // Icons (drawn here: a panellist seat has no icon field)
    // -----------------------------------------------------------------------

    /** The rail icon: a wand over a line of text — "rewrite this prompt". */
    function StudioIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M9.5 2.5l1.2 2.6 2.6 1.2-2.6 1.2-1.2 2.6-1.2-2.6L5.7 6.3l2.6-1.2z' }),
        h('path', { d: 'M2.5 12.5h6' }),
        h('path', { d: 'M2.5 10h4' }),
      )
    }

    /** A tiny spinner. */
    function Spinner(props) {
      const size = props.size === undefined ? 13 : props.size
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        style: { animation: 'dsh-prompt-studio-spin 0.9s linear infinite' },
      },
        h('circle', {
          cx: 8, cy: 8, r: 6,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeDasharray: '24 14',
          strokeLinecap: 'round',
          opacity: 0.9,
        }),
      )
    }

    // -----------------------------------------------------------------------
    // Shared styles
    // -----------------------------------------------------------------------

    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      color: LABEL_PRIMARY,
      background: BG_PANEL,
      fontSize: 13,
      lineHeight: 1.6,
    }

    const HEADER_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 14px',
      borderBottom: '1px solid ' + BORDER_L1,
      flex: '0 0 auto',
    }

    const TITLE_STYLE = { fontSize: 13, fontWeight: 600, margin: 0 }
    const CAPTION_STYLE = { fontSize: 11, color: LABEL_TERTIARY }

    const BODY_STYLE = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      padding: '12px 14px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }

    const CARD_STYLE = {
      border: '1px solid ' + BORDER_L1,
      borderRadius: 6,
      padding: '10px 12px',
      background: BG_MODULE,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }

    const LABEL_STYLE = {
      fontSize: 11,
      fontWeight: 600,
      color: LABEL_SECONDARY,
      letterSpacing: '0.02em',
    }

    const TEXTAREA_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      minHeight: 120,
      resize: 'vertical',
      padding: '8px 10px',
      borderRadius: RADIUS,
      border: '1px solid ' + BORDER_L2,
      background: BG_FIELD,
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: 12.5,
      lineHeight: 1.6,
      outline: 'none',
    }

    const SELECT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: RADIUS,
      border: '1px solid ' + BORDER_L2,
      background: BG_FIELD,
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: 12.5,
    }

    const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const SPACER_STYLE = { flex: '1 1 auto' }

    const NOTE_STYLE = { fontSize: 11.5, color: LABEL_TERTIARY, margin: 0 }

    const ERROR_STYLE = {
      fontSize: 12,
      color: DANGER,
      margin: 0,
      padding: '8px 10px',
      border: '1px solid ' + DANGER,
      borderRadius: RADIUS,
      background: 'transparent',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }

    const NOTICE_STYLE = {
      fontSize: 12,
      color: LABEL_SECONDARY,
      margin: 0,
      padding: '6px 10px',
      border: '1px solid ' + BORDER_L1,
      borderRadius: RADIUS,
      whiteSpace: 'pre-wrap',
    }

    const CODE_STYLE = {
      fontFamily: MONO,
      fontSize: 11.5,
      color: LABEL_TERTIARY,
      wordBreak: 'break-all',
    }

    const LIST_ITEM_STYLE = {
      border: '1px solid ' + BORDER_L1,
      borderRadius: RADIUS,
      padding: '7px 9px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      cursor: 'pointer',
      background: BG_FIELD,
    }

    const CHIP_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 11,
      color: LABEL_TERTIARY,
      border: '1px solid ' + BORDER_L1,
      borderRadius: 999,
      padding: '0 7px',
      lineHeight: '18px',
    }

    /** A labelled block: the label above its control. */
    function Field(props) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('span', { style: LABEL_STYLE }, props.label),
        props.children,
      )
    }

    /** The empty state, so a blank area always says what it is waiting for. */
    function Empty(props) {
      return h('p', { style: { ...NOTE_STYLE, padding: '10px 0', textAlign: 'center' } }, props.text)
    }

    /** The error state: the Host's own message, never swallowed. */
    function ErrorBox(props) {
      if (props.error === null || props.error === undefined || props.error === '') return null
      return h('p', { style: ERROR_STYLE, role: 'alert' }, String(props.error))
    }

    // -----------------------------------------------------------------------
    // The model picker
    // -----------------------------------------------------------------------

    /**
     * The route selector.
     *
     * One flat `<select>` over every `provider/model` the Host reported, because
     * that is what the Host can actually call: the panel never offers a
     * combination the catalog does not contain. A catalog that failed to load
     * entirely is reported instead of showing an empty picker.
     */
    function RoutePicker(props) {
      const routes = props.routes
      const options = routes.map((route) => h('option', {
        key: routeKey(route),
        value: routeKey(route),
      }, route.provider + ' / ' + route.name))

      return h(Field, { label: props.label === undefined ? '模型' : props.label },
        h('select', {
          style: SELECT_STYLE,
          value: props.value,
          disabled: props.disabled === true || routes.length === 0,
          onChange: (event) => props.onChange(event.target.value),
        },
          routes.length === 0
            ? h('option', { value: '' }, '没有可用的模型')
            : [h('option', { key: '__none', value: '' }, '（选择模型）')].concat(options),
        ),
        props.failures !== undefined && props.failures.length > 0
          ? h('p', { style: NOTE_STYLE }, '以下 provider 的模型列表读取失败：' +
            props.failures.map((f) => f.provider + '（' + f.message + '）').join('；'))
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // The optimisation pane
    // -----------------------------------------------------------------------

    /**
     * Input, result and version chain — the workbench's main column.
     *
     * The result is an editable textarea rather than a read-only block: the point
     * of the tool is that the user finishes the prompt themselves, and a version
     * they hand-edited must be storable and iterable like one the model wrote.
     */
    function OptimizePane(props) {
      const s = props.state
      const set = props.set

      const canRun = s.busy === null && s.input.trim() !== '' && s.route !== ''
      const busyHere = s.busy === 'optimize' || s.busy === 'iterate'

      return h(React.Fragment, null,
        h('div', { style: CARD_STYLE },
          h(Field, { label: '原始提示词' },
            h('textarea', {
              style: TEXTAREA_STYLE,
              value: s.input,
              placeholder: '把要优化的提示词粘贴到这里…',
              spellCheck: false,
              onChange: (event) => set({ input: event.target.value }),
            }),
          ),
          h('div', { style: ROW_STYLE },
            h(primitives.SegmentedControl, {
              id: 'dsh-prompt-studio-mode',
              value: s.mode,
              options: MODES,
              label: '提示词类型',
              disabled: busyHere,
              onChange: (value) => set({ mode: value }),
            }),
            h('span', { style: SPACER_STYLE }),
            h('span', { style: CAPTION_STYLE }, s.input.length + ' 字符'),
          ),
          h(RoutePicker, {
            routes: s.routes,
            failures: s.failures,
            value: s.route,
            disabled: busyHere,
            onChange: (value) => props.chooseRoute(value),
          }),
          h('div', { style: ROW_STYLE },
            h(primitives.Button, {
              variant: 'primary',
              disabled: !canRun,
              icon: busyHere ? h(Spinner, null) : h(primitives.IconSparkleMedium, null),
              onClick: () => props.onOptimize(),
            }, busyHere ? '正在优化…' : '优化'),
            h(primitives.Button, {
              variant: 'outline',
              disabled: s.busy !== null || s.input.trim() === '',
              onClick: () => props.onIterate(),
            }, '迭代'),
            h('span', { style: SPACER_STYLE }),
            s.mode === 'system'
              ? h('span', { style: CHIP_STYLE }, '系统提示词')
              : null,
          ),
          s.busy !== null
            ? h('p', { style: NOTE_STYLE }, s.busy === 'optimize' ? '模型正在改写…' :
              s.busy === 'iterate' ? '模型正在迭代…' : '正在处理…')
            : null,
        ),

        h(ErrorBox, { error: s.error }),

        s.result !== ''
          ? h('div', { style: CARD_STYLE },
            h('div', { style: ROW_STYLE },
              h('span', { style: LABEL_STYLE }, '优化结果'),
              h('span', { style: SPACER_STYLE }),
              h('span', { style: CAPTION_STYLE },
                s.resultMeta === null
                  ? ''
                  : s.resultMeta.provider + '/' + s.resultMeta.model + ' · ' +
                    formatMs(s.resultMeta.elapsedMs) +
                    (s.resultMeta.stored === false ? ' · 未落库' : '')),
            ),
            h('textarea', {
              style: { ...TEXTAREA_STYLE, minHeight: 160 },
              value: s.result,
              spellCheck: false,
              onChange: (event) => set({ result: event.target.value }),
            }),
            h('div', { style: ROW_STYLE },
              h(primitives.Button, {
                variant: 'ghost',
                icon: h(primitives.IconCopyOutlineMedium, null),
                onClick: () => props.onCopy(s.result),
              }, '复制'),
              h(primitives.Button, {
                variant: 'ghost',
                icon: h(primitives.IconSparkleMedium, null),
                onClick: () => props.onUseAsInput(),
              }, '作为输入'),
              h(primitives.Button, {
                variant: 'ghost',
                icon: h(primitives.IconPlusOutlineMedium, null),
                onClick: () => props.onSaveTemplate(s.result),
              }, '存为模板'),
              h(primitives.Button, {
                variant: 'ghost',
                icon: h(primitives.IconDatabaseOutlineMedium, null),
                onClick: () => props.onPersist(s.result),
              }, '存入历史'),
            ),
          )
          : h(Empty, { text: '还没有结果。输入一段提示词，选好模型，点「优化」。' }),

        h(ChainPane, {
          chain: s.chain,
          activeId: s.baseId,
          busy: s.busy !== null,
          onPick: (row) => props.onPickVersion(row),
          onDelete: (row) => props.onDeleteVersion(row),
        }),
      )
    }

    /** The version chain: v1 original, v2 optimised, v3 tighter, … */
    function ChainPane(props) {
      if (props.chain.length === 0) {
        return h('div', { style: CARD_STYLE },
          h('span', { style: LABEL_STYLE }, '版本链'),
          h(Empty, { text: '还没有版本。优化一次就会产生第一版。' }),
        )
      }
      return h('div', { style: CARD_STYLE },
        h('div', { style: ROW_STYLE },
          h('span', { style: LABEL_STYLE }, '版本链'),
          h('span', { style: SPACER_STYLE }),
          h('span', { style: CAPTION_STYLE }, '共 ' + props.chain.length + ' 版'),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          props.chain.map((row, index) => {
            const active = row.id === props.activeId
            return h('div', {
              key: row.id,
              style: {
                ...LIST_ITEM_STYLE,
                borderColor: active ? ACCENT : BORDER_L1,
                opacity: props.busy ? 0.6 : 1,
              },
              onClick: () => props.onPick(row),
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { fontSize: 11, fontWeight: 600, color: active ? ACCENT : LABEL_SECONDARY } },
                  'v' + (index + 1)),
                h('span', { style: { ...CAPTION_STYLE, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  versionTitle(row)),
                h('span', { style: CHIP_STYLE }, ORIGIN_LABELS[row.origin] === undefined ? row.origin : ORIGIN_LABELS[row.origin]),
                h('span', { style: CAPTION_STYLE }, formatTime(row.created_at)),
              ),
              active
                ? h('pre', {
                  style: {
                    margin: 0,
                    fontFamily: MONO,
                    fontSize: 11.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: LABEL_SECONDARY,
                    maxHeight: 200,
                    overflow: 'auto',
                  },
                }, row.content)
                : null,
              h('div', { style: ROW_STYLE },
                h('span', { style: SPACER_STYLE }),
                h(primitives.Button, {
                  variant: 'ghost',
                  size: 'sm',
                  onClick: (event) => {
                    event.stopPropagation()
                    props.onPick(row)
                  },
                }, active ? '已载入' : '回退到这一版'),
                h(primitives.Button, {
                  variant: 'ghost',
                  size: 'sm',
                  icon: h(primitives.IconTrashOutlineMedium, null),
                  onClick: (event) => {
                    event.stopPropagation()
                    props.onDelete(row)
                  },
                }, '删除'),
              ),
            )
          }),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // The test / comparison pane
    // -----------------------------------------------------------------------

    /**
     * Run a prompt against a task, three ways.
     *
     *   - single: one model, one output;
     *   - compare: two to `compareMax` models side by side, each column
     *     independently expandable, one column failing never hides the others;
     *   - analyze: a judge model reads both prompts and both outputs and answers
     *     in a fixed shape.
     */
    function TestPane(props) {
      const s = props.state
      const set = props.set
      const [testMode, setTestMode] = useState('single')
      const [task, setTask] = useState('')
      const [picked, setPicked] = useState([])
      const [running, setRunning] = useState(false)
      const [single, setSingle] = useState(null)
      const [columns, setColumns] = useState([])
      const [analysis, setAnalysis] = useState(null)
      const [judge, setJudge] = useState('')

      const prompt = s.result.trim() !== '' ? s.result : s.input
      const canRun = !running && prompt.trim() !== '' && task.trim() !== '' && s.route !== ''

      const togglePick = (key) => {
        setPicked((current) => current.indexOf(key) >= 0
          ? current.filter((entry) => entry !== key)
          : current.length >= s.compareMax ? current : current.concat([key]))
      }

      const run = async () => {
        setRunning(true)
        setSingle(null)
        setColumns([])
        setAnalysis(null)
        try {
          const body = {
            prompt,
            task,
            mode: s.mode,
            sessionId: props.sessionId,
            promptId: s.baseId === null ? undefined : s.baseId,
          }
          if (testMode === 'single') {
            const route = parseRouteKey(s.route)
            const result = await callApi('/test', { method: 'POST', body: { ...body, ...route } })
            setSingle(result)
          } else if (testMode === 'compare') {
            const routes = picked.map(parseRouteKey).filter(Boolean)
            const result = await callApi('/compare', { method: 'POST', body: { ...body, routes } })
            setColumns(result.columns === undefined ? [] : result.columns)
          } else {
            const route = parseRouteKey(judge === '' ? s.route : judge)
            const before = s.chain.length > 0 ? s.chain[0].content : prompt
            const result = await callApi('/analyze', {
              method: 'POST',
              body: {
                ...body,
                ...route,
                before,
                after: prompt,
                beforeOutput: single === null ? '' : single.output,
                afterOutput: single === null ? '' : single.output,
              },
            })
            setAnalysis(result)
          }
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        } finally {
          setRunning(false)
        }
      }

      return h(React.Fragment, null,
        h('div', { style: CARD_STYLE },
          h(Field, { label: '测试内容（要交给提示词去完成的任务）' },
            h('textarea', {
              style: { ...TEXTAREA_STYLE, minHeight: 90 },
              value: task,
              placeholder: '例如：把下面这段会议记录整理成 5 条待办…',
              spellCheck: false,
              onChange: (event) => setTask(event.target.value),
            }),
          ),
          h('div', { style: ROW_STYLE },
            h('span', { style: LABEL_STYLE }, '被测提示词'),
            h('span', { style: CAPTION_STYLE },
              s.result.trim() !== '' ? '使用「优化结果」当前内容' : s.input.trim() !== '' ? '使用「原始提示词」当前内容' : '（还没有提示词）'),
          ),
          h(primitives.SegmentedControl, {
            id: 'dsh-prompt-studio-testmode',
            value: testMode,
            options: [
              { value: 'single', label: '单模型测试' },
              { value: 'compare', label: '多模型对比' },
              { value: 'analyze', label: '分析' },
            ],
            label: '测试方式',
            disabled: running,
            onChange: setTestMode,
          }),

          testMode === 'single'
            ? h(RoutePicker, {
              label: '测试模型',
              routes: s.routes,
              value: s.route,
              disabled: running,
              onChange: (value) => props.chooseRoute(value),
            })
            : null,

          testMode === 'compare'
            ? h(Field, { label: '对比模型（最多 ' + s.compareMax + ' 个）' },
              s.routes.length === 0
                ? h(Empty, { text: '没有可用的模型。' })
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  s.routes.map((route) => {
                    const key = routeKey(route)
                    const checked = picked.indexOf(key) >= 0
                    return h('label', {
                      key,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        cursor: 'pointer',
                        color: LABEL_SECONDARY,
                      },
                    },
                      h('input', {
                        type: 'checkbox',
                        checked,
                        disabled: running || (!checked && picked.length >= s.compareMax),
                        onChange: () => togglePick(key),
                      }),
                      h('span', null, route.provider + ' / ' + route.name),
                    )
                  }),
                ),
            )
            : null,

          testMode === 'analyze'
            ? h(React.Fragment, null,
              h(RoutePicker, {
                label: '裁判模型',
                routes: s.routes,
                value: judge === '' ? s.route : judge,
                disabled: running,
                onChange: setJudge,
              }),
              h('p', { style: NOTE_STYLE },
                '裁判模型会读「原始提示词 / 优化后提示词」以及它们在同一任务上的输出，输出结构化的改进点与退步点。' +
                '建议先在上面跑一次单模型测试，把输出带进分析。'),
            )
            : null,

          h('div', { style: ROW_STYLE },
            h(primitives.Button, {
              variant: 'primary',
              disabled: !canRun && !(testMode === 'compare' && !running && prompt.trim() !== '' && task.trim() !== '' && picked.length >= 2),
              icon: running ? h(Spinner, null) : h(primitives.IconSendOutlineMedium, null),
              onClick: run,
            }, running ? '正在运行…' : '运行'),
            h('span', { style: SPACER_STYLE }),
            h('span', { style: CAPTION_STYLE },
              testMode === 'compare' ? '已选 ' + picked.length + ' 个模型' : ''),
          ),
        ),

        single !== null
          ? h('div', { style: CARD_STYLE },
            h('div', { style: ROW_STYLE },
              h('span', { style: LABEL_STYLE }, '测试输出'),
              h('span', { style: SPACER_STYLE }),
              h('span', { style: CAPTION_STYLE },
                single.provider + '/' + single.model + ' · ' + formatMs(single.elapsedMs) +
                (single.stored === false ? ' · 未落库' : '')),
            ),
            h('pre', {
              style: {
                margin: 0,
                fontFamily: MONO,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 360,
                overflow: 'auto',
                color: LABEL_PRIMARY,
              },
            }, single.output),
          )
          : null,

        columns.length > 0
          ? h(CompareColumns, { columns, compareMax: s.compareMax })
          : null,

        analysis !== null
          ? h(AnalysisCard, { analysis })
          : null,
      )
    }

    /**
     * The side-by-side comparison.
     *
     * Horizontal scroll with a column per model, so a narrow panel does not force
     * the columns into an unreadable stack; each column expands and collapses
     * independently. A column whose model failed renders its error in place — the
     * comparison is still a comparison.
     */
    function CompareColumns(props) {
      const [open, setOpen] = useState({})
      return h('div', { style: CARD_STYLE },
        h('span', { style: LABEL_STYLE }, '多模型对比'),
        h('div', {
          style: {
            display: 'grid',
            gridAutoFlow: 'column',
            gridAutoColumns: 'minmax(240px, 1fr)',
            gap: 10,
            overflowX: 'auto',
            paddingBottom: 4,
          },
        },
          props.columns.map((column, index) => {
            const key = column.provider + '/' + column.model
            const expanded = open[index] === true
            return h('div', {
              key,
              style: {
                border: '1px solid ' + (column.error === null ? BORDER_L1 : DANGER),
                borderRadius: RADIUS,
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                minWidth: 240,
                background: BG_FIELD,
              },
            },
              h('div', { style: ROW_STYLE },
                h('span', { style: { fontSize: 11.5, fontWeight: 600, color: LABEL_SECONDARY } },
                  column.provider),
                h('span', { style: CAPTION_STYLE }, column.model),
                h('span', { style: SPACER_STYLE }),
                h('span', { style: CAPTION_STYLE }, formatMs(column.elapsedMs)),
              ),
              column.error === null
                ? h(React.Fragment, null,
                  h('pre', {
                    style: {
                      margin: 0,
                      fontFamily: MONO,
                      fontSize: 11.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: LABEL_PRIMARY,
                      maxHeight: expanded ? 520 : 180,
                      overflow: 'auto',
                    },
                  }, expanded ? column.output : column.output.slice(0, 600) + (column.output.length > 600 ? '…' : '')),
                  column.output.length > 600
                    ? h(primitives.Button, {
                      variant: 'ghost',
                      size: 'sm',
                      onClick: () => setOpen((current) => ({ ...current, [index]: !expanded })),
                    }, expanded ? '收起' : '展开全文')
                    : null,
                )
                : h('p', { style: ERROR_STYLE }, column.error),
            )
          }),
        ),
        h('p', { style: NOTE_STYLE }, '每一列独立运行；某个模型失败不影响其它列。'),
      )
    }

    /** The judge's structured verdict. */
    function AnalysisCard(props) {
      const a = props.analysis
      const VERDICT = {
        improved: { text: '新版更好', color: SUCCESS },
        mixed: { text: '各有得失', color: WARN },
        worse: { text: '新版更差', color: DANGER },
      }
      const verdict = VERDICT[a.verdict] === undefined
        ? { text: '未能解析结论', color: LABEL_TERTIARY }
        : VERDICT[a.verdict]

      const list = (title, items, color) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('span', { style: { ...LABEL_STYLE, color } }, title),
        items.length === 0
          ? h('p', { style: NOTE_STYLE }, '（无）')
          : h('ul', { style: { margin: 0, paddingLeft: 18, fontSize: 12, color: LABEL_SECONDARY } },
            items.map((item, index) => h('li', { key: index }, item))),
      )

      return h('div', { style: CARD_STYLE },
        h('div', { style: ROW_STYLE },
          h('span', { style: LABEL_STYLE }, '分析'),
          h('span', { style: SPACER_STYLE }),
          h('span', { style: { fontSize: 12, fontWeight: 600, color: verdict.color } }, verdict.text),
          h('span', { style: CAPTION_STYLE }, a.provider + '/' + a.model + ' · ' + formatMs(a.elapsedMs)),
        ),
        list('改进点', a.gains, SUCCESS),
        list('退步点', a.regressions, DANGER),
        a.recommendation !== ''
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: LABEL_STYLE }, '建议'),
            h('p', { style: { ...NOTE_STYLE, color: LABEL_SECONDARY } }, a.recommendation))
          : null,
        a.parsed !== true
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: { ...LABEL_STYLE, color: WARN } }, '模型没有按要求输出 JSON，下面是原文'),
            h('pre', {
              style: {
                margin: 0,
                fontFamily: MONO,
                fontSize: 11.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 260,
                overflow: 'auto',
                color: LABEL_SECONDARY,
              },
            }, a.raw))
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // The templates and history pane
    // -----------------------------------------------------------------------

    /**
     * Templates and history.
     *
     * Templates are the SYSTEM prompts handed to the optimiser, not prompts for
     * the user's own task, so picking one only changes how the next optimisation
     * is instructed. History is the stored record of every run, filterable by
     * mode and model, and deletable.
     */
    function LibraryPane(props) {
      const s = props.state
      const set = props.set
      const [modeFilter, setModeFilter] = useState('')
      const [providerFilter, setProviderFilter] = useState('')
      const [busy, setBusy] = useState(false)

      const providers = useMemo(() => {
        const seen = []
        for (const run of s.history.runs) {
          if (seen.indexOf(run.provider) < 0) seen.push(run.provider)
        }
        return seen
      }, [s.history.runs])

      const reload = async (nextMode, nextProvider) => {
        setBusy(true)
        try {
          const query = []
          if (props.sessionId) query.push('sessionId=' + encodeURIComponent(props.sessionId))
          const mode = nextMode === undefined ? modeFilter : nextMode
          const provider = nextProvider === undefined ? providerFilter : nextProvider
          if (mode !== '') query.push('mode=' + encodeURIComponent(mode))
          if (provider !== '') query.push('provider=' + encodeURIComponent(provider))
          const suffix = query.length === 0 ? '' : '?' + query.join('&')
          const history = await callApi('/history' + suffix, {})
          const templates = await callApi('/templates' + (props.sessionId ? '?sessionId=' + encodeURIComponent(props.sessionId) : ''), {})
          set({ history: { prompts: history.prompts, runs: history.runs }, templates: templates.templates })
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      const removePrompt = async (row) => {
        try {
          await callApi('/history/delete', { method: 'POST', body: { id: row.id, kind: 'prompt', sessionId: props.sessionId } })
          await reload()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }

      const removeRun = async (row) => {
        try {
          await callApi('/history/delete', { method: 'POST', body: { id: row.id, kind: 'run', sessionId: props.sessionId } })
          await reload()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }

      const removeTemplate = async (row) => {
        try {
          await callApi('/templates/delete', { method: 'POST', body: { id: row.id, sessionId: props.sessionId } })
          await reload()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }

      return h(React.Fragment, null,
        h('div', { style: CARD_STYLE },
          h('div', { style: ROW_STYLE },
            h('span', { style: LABEL_STYLE }, '模板'),
            h('span', { style: SPACER_STYLE }),
            h(primitives.Button, {
              variant: 'ghost',
              size: 'sm',
              icon: busy ? h(Spinner, null) : h(primitives.IconRefreshOutlineMedium, null),
              onClick: () => reload(),
            }, '刷新'),
          ),
          h('p', { style: NOTE_STYLE }, '模板是交给优化器的系统提示词，决定「怎么改」；内置模板不能覆盖。'),
          s.templates.length === 0
            ? h(Empty, { text: '还没有模板。' })
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              s.templates.map((template) => h('div', {
                key: template.id,
                style: LIST_ITEM_STYLE,
              },
                h('div', { style: ROW_STYLE },
                  h('span', { style: { fontSize: 12, fontWeight: 600, color: LABEL_PRIMARY } }, template.name),
                  h('span', { style: CHIP_STYLE }, template.mode === 'system' ? '系统' : '用户'),
                  template.builtin === 1 ? h('span', { style: CHIP_STYLE }, '内置') : null,
                  h('span', { style: SPACER_STYLE }),
                  h(primitives.Button, {
                    variant: 'ghost',
                    size: 'sm',
                    onClick: () => set({ template: template.body }),
                  }, s.template === template.body ? '已选用' : '选用'),
                  template.builtin === 1
                    ? null
                    : h(primitives.Button, {
                      variant: 'ghost',
                      size: 'sm',
                      icon: h(primitives.IconTrashOutlineMedium, null),
                      onClick: () => removeTemplate(template),
                    }, '删除'),
                ),
                h('p', { style: { ...NOTE_STYLE, color: LABEL_SECONDARY } }, template.body),
              )),
            ),
          s.template !== ''
            ? h('div', { style: ROW_STYLE },
              h('span', { style: CAPTION_STYLE }, '当前选用模板：'),
              h('span', { style: { ...CODE_STYLE, flex: '1 1 auto' } }, s.template.slice(0, 80)),
              h(primitives.Button, {
                variant: 'ghost',
                size: 'sm',
                onClick: () => set({ template: '' }),
              }, '取消选用'),
            )
            : null,
        ),

        h('div', { style: CARD_STYLE },
          h('div', { style: ROW_STYLE },
            h('span', { style: LABEL_STYLE }, '历史记录'),
            h('span', { style: SPACER_STYLE }),
            h('span', { style: CAPTION_STYLE }, s.history.prompts.length + ' 个版本 / ' + s.history.runs.length + ' 次运行'),
          ),
          h('div', { style: ROW_STYLE },
            h('select', {
              style: { ...SELECT_STYLE, width: 130 },
              value: modeFilter,
              onChange: (event) => {
                setModeFilter(event.target.value)
                reload(event.target.value, providerFilter)
              },
            },
              h('option', { value: '' }, '全部类型'),
              h('option', { value: 'user' }, '用户提示词'),
              h('option', { value: 'system' }, '系统提示词'),
            ),
            h('select', {
              style: { ...SELECT_STYLE, width: 160 },
              value: providerFilter,
              onChange: (event) => {
                setProviderFilter(event.target.value)
                reload(modeFilter, event.target.value)
              },
            },
              [h('option', { key: '__all', value: '' }, '全部 provider')].concat(
                providers.map((provider) => h('option', { key: provider, value: provider }, provider)),
              ),
            ),
          ),
          s.history.prompts.length === 0 && s.history.runs.length === 0
            ? h(Empty, { text: '还没有历史记录。' })
            : h(React.Fragment, null,
              h('span', { style: LABEL_STYLE }, '版本'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                s.history.prompts.slice(0, 50).map((row) => h('div', {
                  key: row.id,
                  style: { ...LIST_ITEM_STYLE, cursor: 'default' },
                },
                  h('div', { style: ROW_STYLE },
                    h('span', { style: { fontSize: 11, color: LABEL_TERTIARY } }, '#' + row.id),
                    h('span', { style: { ...CAPTION_STYLE, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      versionTitle(row)),
                    h('span', { style: CHIP_STYLE }, row.mode === 'system' ? '系统' : '用户'),
                    h('span', { style: CHIP_STYLE }, ORIGIN_LABELS[row.origin] === undefined ? row.origin : ORIGIN_LABELS[row.origin]),
                    h('span', { style: CAPTION_STYLE }, formatTime(row.created_at)),
                    h(primitives.Button, {
                      variant: 'ghost',
                      size: 'sm',
                      onClick: () => props.onLoadVersion(row),
                    }, '载入'),
                    h(primitives.Button, {
                      variant: 'ghost',
                      size: 'sm',
                      icon: h(primitives.IconTrashOutlineMedium, null),
                      onClick: () => removePrompt(row),
                    }, '删除'),
                  ),
                )),
              ),
              h('span', { style: LABEL_STYLE }, '运行记录'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                s.history.runs.slice(0, 50).map((row) => h('div', {
                  key: row.id,
                  style: { ...LIST_ITEM_STYLE, cursor: 'default' },
                },
                  h('div', { style: ROW_STYLE },
                    h('span', { style: CHIP_STYLE }, KIND_LABELS[row.kind] === undefined ? row.kind : KIND_LABELS[row.kind]),
                    h('span', { style: CAPTION_STYLE }, row.provider + '/' + row.model),
                    h('span', { style: CAPTION_STYLE }, formatMs(row.elapsed_ms)),
                    h('span', { style: SPACER_STYLE }),
                    h('span', { style: CAPTION_STYLE }, formatTime(row.created_at)),
                    row.error !== null && row.error !== undefined
                      ? h('span', { style: { fontSize: 11, color: DANGER } }, '失败')
                      : null,
                    h(primitives.Button, {
                      variant: 'ghost',
                      size: 'sm',
                      icon: h(primitives.IconTrashOutlineMedium, null),
                      onClick: () => removeRun(row),
                    }, '删除'),
                  ),
                  row.error !== null && row.error !== undefined
                    ? h('p', { style: { ...NOTE_STYLE, color: DANGER } }, row.error)
                    : null,
                )),
              ),
            ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // The panel
    // -----------------------------------------------------------------------

    /**
     * The workbench.
     *
     * All state lives here and the panes are pure: the panel owns the single
     * source of truth (input, result, version chain, catalog, history), and a
     * failed request surfaces in one place instead of in each pane.
     */
    function StudioPanel(props) {
      const ctx = props.ctx

      // `main` is a ROOT-scoped seat: its `inject` receives the slot's actions,
      // never a session id, and the catalog binds a Session only to the reserved
      // `conversation` key. The renderer instead materialises every standard hook
      // into a `use<Name>` prop (materializeStandardBinding + standardHookPropName),
      // so the active session arrives through `props.useSessions`. A host without a
      // session catalog passes nothing, hence the hookless stand-in: the hook call
      // stays unconditional while the panel simply runs session-less.
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : useNoSessions
      const sessionId = useSessions(selectSessionId)

      const [tab, setTab] = useState('optimize')
      const [state, setState] = useState({
        routes: [],
        failures: [],
        route: '',
        routePinned: false,
        mode: 'user',
        input: '',
        result: '',
        resultMeta: null,
        template: '',
        chain: [],
        baseId: null,
        templates: [],
        history: { prompts: [], runs: [] },
        busy: null,
        error: null,
        notice: null,
        compareMax: 4,
        version: null,
      })

      const set = useCallback((patch) => {
        setState((current) => ({ ...current, ...patch }))
      }, [])

      // An explicit pick outranks every automatic guess: once the user has
      // chosen a route, a later refresh that learns which model this
      // conversation runs on must not quietly move the selector out from under
      // them. Only a route the catalog no longer offers is replaced.
      const chooseRoute = useCallback((value) => {
        setState((current) => ({ ...current, route: value, routePinned: true }))
      }, [])

      // The workspace, for the footer. The Host resolves it authoritatively from
      // the session id; this is display only, and a session-less host shows none.
      const workspace = useSessions(selectWorkspace)

      const refresh = useCallback(async () => {
        try {
          const suffix = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
          const models = await callApi('/models' + suffix, {})
          const templates = await callApi('/templates' + suffix, {})
          const history = await callApi('/history' + suffix, {})
          const routes = models.routes === undefined ? [] : models.routes
          setState((current) => {
            // A pinned pick survives refresh while the catalog still offers it.
            // Everything else is recomputed from scratch on every refresh, in
            // this order: the route this conversation already talks on, then the
            // configured default, then the first catalog entry. Recomputing
            // matters because the session id arrives a beat after the first
            // render — a route guessed before then must yield to the real one.
            let route = current.route
            const stillOffered = routes.some((entry) => routeKey(entry) === route)
            if (!(current.routePinned && stillOffered)) {
              const candidates = [
                models.sessionProvider !== '' && models.sessionModel !== ''
                  ? models.sessionProvider + '/' + models.sessionModel
                  : '',
                models.defaultProvider !== '' && models.defaultModel !== ''
                  ? models.defaultProvider + '/' + models.defaultModel
                  : '',
              ]
              route = ''
              for (const candidate of candidates) {
                if (candidate !== '' && routes.some((entry) => routeKey(entry) === candidate)) {
                  route = candidate
                  break
                }
              }
              if (route === '' && routes.length > 0) route = preferredRoute(routes)
            }
            return {
              ...current,
              routes,
              failures: models.failures === undefined ? [] : models.failures,
              compareMax: typeof models.compareMax === 'number' ? models.compareMax : current.compareMax,
              route,
              routePinned: current.routePinned && stillOffered,
              templates: templates.templates === undefined ? [] : templates.templates,
              history: {
                prompts: history.prompts === undefined ? [] : history.prompts,
                runs: history.runs === undefined ? [] : history.runs,
              },
              error: null,
            }
          })
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [sessionId, set])

      const health = useCallback(async () => {
        try {
          const suffix = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
          const info = await callApi('/health' + suffix, {})
          set({ version: info.version, notice: info.llm === 'missing' ? '当前 DSH 没有可用的 llm 服务，模型调用不可用。' : null })
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [sessionId, set])

      useEffect(() => {
        refresh()
        health()
      }, [refresh, health])

      const route = parseRouteKey(state.route)

      const runOptimize = useCallback(async () => {
        if (route === null) {
          set({ error: '请先选择一个模型。' })
          return
        }
        set({ busy: 'optimize', error: null, notice: null })
        try {
          const result = await callApi('/optimize', {
            method: 'POST',
            body: {
              prompt: state.input,
              mode: state.mode,
              provider: route.provider,
              model: route.model,
              template: state.template,
              sessionId,
            },
          })
          setState((current) => ({
            ...current,
            busy: null,
            result: result.optimized,
            resultMeta: { provider: result.provider, model: result.model, elapsedMs: result.elapsedMs, stored: result.stored },
            baseId: result.promptId === null ? null : result.promptId,
            chain: result.promptId === null ? [] : [{ id: result.promptId, content: result.optimized, origin: 'optimize', mode: current.mode, title: result.optimized.slice(0, 60), created_at: Date.now() }],
            notice: result.stored === false ? '结果已返回，但当前工作区无法写入数据库，历史没有记录。' : null,
          }))
          refresh()
        } catch (error) {
          set({ busy: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [route, state.input, state.mode, state.template, sessionId, set, refresh])

      const runIterate = useCallback(async (direction) => {
        if (route === null) {
          set({ error: '请先选择一个模型。' })
          return
        }
        set({ busy: 'iterate', error: null, notice: null })
        try {
          const result = await callApi('/iterate', {
            method: 'POST',
            body: {
              prompt: state.result.trim() !== '' ? state.result : state.input,
              mode: state.mode,
              direction,
              provider: route.provider,
              model: route.model,
              parentId: state.baseId === undefined ? null : state.baseId,
              sessionId,
            },
          })
          setState((current) => {
            // An iteration is a new link in the chain: append it so the user can
            // walk back to any earlier version. `baseId` moves to the new head,
            // which is what the next iteration will use as its parent.
            const appended = result.promptId === null
              ? current.chain
              : current.chain.concat([{
                id: result.promptId,
                content: result.optimized,
                origin: 'iterate',
                mode: current.mode,
                title: result.optimized.slice(0, 60),
                created_at: Date.now(),
              }])
            return {
              ...current,
              busy: null,
              result: result.optimized,
              resultMeta: { provider: result.provider, model: result.model, elapsedMs: result.elapsedMs, stored: result.stored },
              baseId: result.promptId === null ? current.baseId : result.promptId,
              chain: appended,
              notice: result.stored === false ? '结果已返回，但当前工作区无法写入数据库，历史没有记录。' : null,
            }
          })
          refresh()
        } catch (error) {
          set({ busy: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [route, state.result, state.input, state.mode, state.baseId, sessionId, set, refresh])

      // The iteration direction. `window.prompt` is deliberate: it is a
      // one-question interaction that must not cost the user a second dialog
      // component, and it is dismissible (an empty answer is a general iteration).
      const onIterate = useCallback(() => {
        const direction = window.prompt('迭代方向（例如「使提示词更加简洁」「补上输出格式约束」）；留空则做通用迭代', '')
        if (direction === null) return
        runIterate(direction.trim())
      }, [runIterate])

      const onCopy = useCallback(async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          set({ notice: '已复制到剪贴板。' })
        } catch (error) {
          set({ error: '复制失败：' + (error instanceof Error ? error.message : String(error)) })
        }
      }, [set])

      const onSaveTemplate = useCallback(async (text) => {
        const name = window.prompt('模板名称', '')
        if (name === null || name.trim() === '') return
        try {
          const result = await callApi('/templates/save', {
            method: 'POST',
            body: { name: name.trim(), mode: state.mode, body: text, sessionId },
          })
          set({ notice: result.replaced ? '已覆盖模板「' + name.trim() + '」。' : '已保存模板「' + name.trim() + '」。' })
          refresh()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [state.mode, sessionId, set, refresh])

      const onPersist = useCallback(async (text) => {
        try {
          const result = await callApi('/templates/save', {
            method: 'POST',
            body: { name: '手写版本 ' + formatTime(Date.now()), mode: state.mode, body: text, sessionId },
          })
          set({ notice: result.replaced ? '同名记录已更新。' : '已存入历史。' })
          refresh()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [state.mode, sessionId, set, refresh])

      const onLoadVersion = useCallback(async (row) => {
        try {
          const result = await callApi('/prompt?id=' + row.id + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : ''), {})
          setState((current) => ({
            ...current,
            input: result.prompt.content,
            result: result.prompt.content,
            mode: result.prompt.mode,
            baseId: result.prompt.id,
            chain: result.chain === undefined ? [] : result.chain,
            tab: 'optimize',
          }))
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [sessionId, set])

      const onPickVersion = useCallback((row) => {
        set({ result: row.content, baseId: row.id, mode: row.mode === 'system' ? 'system' : 'user' })
      }, [set])

      const onDeleteVersion = useCallback(async (row) => {
        try {
          await callApi('/history/delete', { method: 'POST', body: { id: row.id, kind: 'prompt', sessionId } })
          refresh()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [sessionId, set, refresh])

      const paneProps = {
        state,
        set,
        chooseRoute,
        sessionId,
        onOptimize: runOptimize,
        onIterate,
        onCopy,
        onSaveTemplate,
        onPersist,
        onPickVersion,
        onDeleteVersion,
        onLoadVersion,
        onUseAsInput: () => set({ input: state.result }),
      }

      return h('div', { style: PANEL_STYLE },
        h('div', { style: HEADER_STYLE },
          h('span', { style: { display: 'inline-flex', color: ACCENT } }, h(StudioIcon, null)),
          h('h2', { style: TITLE_STYLE }, '提示词工作台'),
          state.version !== null
            ? h('span', { style: CAPTION_STYLE }, 'v' + state.version)
            : null,
          h('span', { style: SPACER_STYLE }),
          h(primitives.Button, {
            variant: 'ghost',
            size: 'sm',
            icon: state.busy === 'refresh' ? h(Spinner, null) : h(primitives.IconRefreshOutlineMedium, null),
            onClick: () => {
              set({ busy: 'refresh' })
              Promise.resolve(refresh()).finally(() => set({ busy: null }))
            },
          }, '刷新'),
        ),

        h('div', { style: { padding: '8px 14px 0', flex: '0 0 auto' } },
          h(primitives.SegmentedControl, {
            id: 'dsh-prompt-studio-tab',
            value: tab,
            options: [
              { value: 'optimize', label: '优化' },
              { value: 'test', label: '测试对比' },
              { value: 'library', label: '模板与历史' },
            ],
            label: '工作台区域',
            onChange: setTab,
          }),
        ),

        h('div', { style: BODY_STYLE },
          state.notice !== null
            ? h('p', { style: NOTICE_STYLE }, state.notice)
            : null,
          tab === 'optimize' ? h(OptimizePane, paneProps) : null,
          tab === 'test' ? h(TestPane, paneProps) : null,
          tab === 'library' ? h(LibraryPane, paneProps) : null,
        ),

        h('div', {
          style: {
            flex: '0 0 auto',
            padding: '6px 14px',
            borderTop: '1px solid ' + BORDER_L1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          },
        },
          h('span', { style: CAPTION_STYLE },
            '模型 ' + state.routes.length + ' 个'),
          h('span', { style: CAPTION_STYLE },
            workspace === null ? '工作区（未知）' : workspace),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /**
     * Register the rail entry and the panel.
     *
     * Both seats are registered from the innermost `slots.inject` callback so they
     * appear together or not at all; the returned function releases both. The
     * callbacks only run once the host shell has DECLARED those seats, so a shell
     * that does not declare them leaves the panel unmounted instead of failing the
     * boot.
     */
    function apply(ctx) {
      try {
        if (ctx.slots === undefined || ctx.slots === null) {
          console.error('dsh-prompt-studio: this DSH has no slots service; the workbench stays unmounted')
          return
        }
        ctx.slots.inject('main', () =>
          ctx.slots.inject('sidebar.panellist', () => {
            const stopMain = ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                // A ROOT-scoped `inject` is called with the slot's `actions`, not
                // with a session id, so only `ctx` is handed over here; the panel
                // reads the active session through its `useSessions` standard prop.
                inject: () => ({ ctx }),
              },
              StudioPanel,
            )
            const stopIcon = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 46, label: () => '提示词' },
              StudioIcon,
            )
            return () => {
              if (typeof stopIcon === 'function') stopIcon()
              if (typeof stopMain === 'function') stopMain()
            }
          }),
        )
      } catch (error) {
        console.error('dsh-prompt-studio: registering the workbench panel failed', error)
      }
    }

    /** `slots` is the one service this module needs before it can do anything. */
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
