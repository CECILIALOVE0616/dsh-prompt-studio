// Resolved settings for one mounted plugin instance.
//
// Three layers, most specific first:
//
//   1. the plugin's own configuration — the fields in the settings page (a host
//      `Config` schema; see index.js), stored in the profile patch;
//   2. the environment, for a deployment that tunes a headless install with no
//      UI at all;
//   3. the built-in defaults below.
//
// A layer only speaks when it actually says something: an empty provider, an
// unset switch or a zero timeout falls THROUGH to the layer beneath instead of
// pinning the default over it. An unparsable value falls back rather than failing
// the mount, because one bad environment variable must not take the whole
// workbench down.

export const DEFAULTS = {
  /** Which optimisation workspace a fresh session starts in. */
  defaultMode: 'user',
  /** Route a call uses when neither the caller nor the session names one. */
  defaultProvider: '',
  defaultModel: '',
  /** Token ceiling for ONE model call. */
  maxTokens: 4096,
  /** Deadline for one model call. */
  timeoutMs: 120_000,
  /**
   * Whether the `prompt_optimize` tool is registered at all.
   *
   * Read ONCE per mount, unlike every other field: it decides which tools exist,
   * so it needs the next start rather than a live update. The settings page says
   * so on that row.
   */
  toolEnabled: true,
  /** Refuse a prompt longer than this; it is a guard rail, not a model limit. */
  maxPromptChars: 20_000,
  /** Rows a history query returns before it is paged. */
  historyLimit: 200,
}

/** Ceiling for `timeoutMs`, mirroring the platform shell tools' `maxTimeoutMs`. */
export const MAX_TIMEOUT_MS = 30 * 60 * 1000

const ENV_INT_RE = /^\d+$/

function envInt(env, name, fallback, min, max) {
  const raw = env[name]
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  if (!ENV_INT_RE.test(trimmed)) return fallback
  const value = Number(trimmed)
  return value >= min && value <= max ? value : fallback
}

function envString(env, name) {
  const raw = env[name]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

function envBool(env, name) {
  const raw = env[name]
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  if (value === '1' || value === 'true' || value === 'on') return true
  if (value === '0' || value === 'false' || value === 'off') return false
  return undefined
}

/**
 * Read one configuration value, unwrapping a volatile cell.
 *
 * A `.volatile()` schema field does NOT resolve to its value: schemastery wraps it
 * with cosmokit's `createVolatile(default)`, so the settings object carries a CELL
 * with `.get()` / `.set()` rather than a plain boolean or number. Reading it
 * directly would hand a Number field an object, and the first arithmetic on it
 * would silently produce NaN — a wrong answer with no error. The cell is written
 * in place when the user edits the field, and that in-place write is exactly what
 * makes an edit apply without remounting the plugin, so reading through `.get()`
 * is both required for correctness and how live updates arrive.
 *
 * A plain value (an older host, or a hand-built settings object) passes through
 * untouched.
 */
function unbox(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/** A configured boolean, or the fallback when the layer did not set one. */
function setting(value, fallback) {
  const raw = unbox(value)
  return typeof raw === 'boolean' ? raw : fallback
}

/** A configured non-empty string, or the fallback when the layer did not set one. */
function text(value, fallback) {
  const raw = unbox(value)
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback
}

/** A configured positive integer, or the fallback when the layer did not set one. */
function positiveInt(value, fallback, max) {
  const raw = unbox(value)
  if (!Number.isInteger(raw) || raw <= 0) return fallback
  return max === undefined ? raw : Math.min(raw, max)
}

/**
 * Resolve the effective configuration for one mount.
 *
 * @param env - environment to read (injectable for tests).
 * @param settings - the plugin's own configuration, as the composition resolved it
 *   against the Config schema (injectable for tests; may be undefined).
 */
export function resolveConfig(env = process.env, settings = {}) {
  const mode = text(settings.defaultMode, envString(env, 'DSH_PROMPT_STUDIO_MODE') ?? DEFAULTS.defaultMode)
  return {
    ...DEFAULTS,
    // An unknown mode is not fatal — the workbench falls back to `user` rather
    // than refusing to mount — but it is normalised here so nothing downstream
    // has to re-check it.
    defaultMode: mode === 'system' ? 'system' : 'user',
    defaultProvider: text(settings.defaultProvider, envString(env, 'DSH_PROMPT_STUDIO_PROVIDER') ?? DEFAULTS.defaultProvider),
    defaultModel: text(settings.defaultModel, envString(env, 'DSH_PROMPT_STUDIO_MODEL') ?? DEFAULTS.defaultModel),
    maxTokens: positiveInt(settings.maxTokens, envInt(env, 'DSH_PROMPT_STUDIO_MAX_TOKENS', DEFAULTS.maxTokens, 1, 1_000_000)),
    timeoutMs: positiveInt(settings.timeoutMs, envInt(env, 'DSH_PROMPT_STUDIO_TIMEOUT_MS', DEFAULTS.timeoutMs, 1000, MAX_TIMEOUT_MS), MAX_TIMEOUT_MS),
    toolEnabled: setting(settings.toolEnabled, envBool(env, 'DSH_PROMPT_STUDIO_TOOL') ?? DEFAULTS.toolEnabled),
    maxPromptChars: positiveInt(settings.maxPromptChars, DEFAULTS.maxPromptChars, 1_000_000),
    historyLimit: positiveInt(settings.historyLimit, DEFAULTS.historyLimit, 5000),
  }
}

/**
 * Split a `provider/model` route on its FIRST slash.
 *
 * A model id may itself contain slashes (`qwen/qwen3-32b` is one id on some
 * gateways), while a provider id may not, so splitting on every slash would
 * truncate the model. Returns null for anything that is not a two-part route, so
 * callers can report "no route" instead of calling a model named `""`.
 *
 * @param route - the route string, or anything else.
 * @returns `{ provider, model }`, or null.
 */
export function parseRoute(route) {
  if (typeof route !== 'string') return null
  const slash = route.indexOf('/')
  if (slash <= 0 || slash === route.length - 1) return null
  const provider = route.slice(0, slash).trim()
  const model = route.slice(slash + 1).trim()
  if (provider === '' || model === '') return null
  return { provider, model }
}
