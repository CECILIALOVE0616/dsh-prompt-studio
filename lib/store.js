// Persistence for the workbench: prompts, runs and templates.
//
// One SQLite file per workspace, under `<cwd>/.dsh-prompt-studio/`, so two
// conversations in different projects keep separate histories — the same
// per-workspace isolation `meow-memory` uses with `.dsh-meow`.
//
// `node:sqlite` is a Node built-in (>= 22.5), so this needs no dependency and no
// native build step. The database is opened LAZILY and cached per workspace: a
// conversation that never touches the workbench never creates a file, and a mount
// in a read-only directory still lets the rest of the plugin run.
//
// Every statement is prepared with placeholders. Values coming from the browser or
// from a model never reach SQL as text.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory (and file) the workbench owns, relative to the workspace root. */
export const DATA_DIR = '.dsh-prompt-studio'
export const DATA_FILE = 'prompt-studio.db'

/**
 * The schema, applied on every open.
 *
 * `IF NOT EXISTS` throughout, so this is the migration path as well as the
 * creation path: opening an older database adds whatever it is missing and leaves
 * the existing rows alone.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS prompts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace  TEXT NOT NULL,
  mode       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  parent_id  INTEGER,
  origin     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prompts_workspace ON prompts (workspace, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  prompt_id   INTEGER,
  input       TEXT NOT NULL DEFAULT '',
  output      TEXT NOT NULL DEFAULT '',
  elapsed_ms  INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_workspace ON runs (workspace, created_at DESC);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace  TEXT NOT NULL,
  name       TEXT NOT NULL,
  mode       TEXT NOT NULL,
  body       TEXT NOT NULL,
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS templates_name ON templates (workspace, name);
`

/** Open handles, keyed by database path. */
const handles = new Map()

/** The plugin's own manifest, read once. */
let manifestCache

/**
 * The plugin's `package.json`, for the version the panel shows.
 *
 * Read from this module's own location rather than from a literal, so a release
 * bumps the version in exactly one file. A missing or unreadable manifest is not
 * an error — the panel simply shows no version.
 *
 * @returns `{ name, version }` with nulls for whatever could not be read.
 */
export function readManifest() {
  if (manifestCache !== undefined) return manifestCache
  const fallback = { name: 'dsh-prompt-studio', version: null }
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const parsed = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    manifestCache = {
      name: typeof parsed.name === 'string' ? parsed.name : fallback.name,
      version: typeof parsed.version === 'string' ? parsed.version : null,
    }
  } catch {
    manifestCache = fallback
  }
  return manifestCache
}

/**
 * The absolute path of a workspace's database file.
 *
 * @param workspace - the workspace root (a session's `header.cwd`).
 * @returns the file path.
 */
export function databasePath(workspace) {
  return join(workspace, DATA_DIR, DATA_FILE)
}

/**
 * The open database for a workspace, creating the directory and schema on first use.
 *
 * @param workspace - the workspace root.
 * @returns the handle.
 * @throws when the file cannot be created (a read-only workspace), which the
 *   caller reports as a failed operation rather than a failed mount.
 */
export function openDatabase(workspace) {
  const path = databasePath(workspace)
  const existing = handles.get(path)
  if (existing !== undefined) return existing

  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // WAL keeps a slow read (a history page) from blocking the write of a running
  // comparison, and `busy_timeout` makes the rare contended write wait instead of
  // failing outright.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  seedBuiltinTemplates(db, workspace)
  handles.set(path, db)
  return db
}

/**
 * Close every open handle.
 *
 * Called when the plugin unloads: `node:sqlite` handles are not garbage-collected
 * into closure, and on Windows an open file cannot be replaced.
 */
export function closeAll() {
  for (const db of handles.values()) {
    try {
      db.close()
    } catch {
      // A handle already closed by the host is not worth reporting.
    }
  }
  handles.clear()
}

/** Run a statement and return nothing. */
function run(db, sql, ...params) {
  db.prepare(sql).run(...params)
}

/** Run a query and return every row. */
function all(db, sql, ...params) {
  return db.prepare(sql).all(...params)
}

/** Run a query and return the first row, or undefined. */
function one(db, sql, ...params) {
  return db.prepare(sql).get(...params)
}

/**
 * Insert a prompt version.
 *
 * @param db - the handle.
 * @param version - the row.
 * @returns the new row id.
 */
export function insertPrompt(db, version) {
  const statement = db.prepare(
    `INSERT INTO prompts (workspace, mode, title, content, parent_id, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const result = statement.run(
    version.workspace,
    version.mode,
    version.title ?? '',
    version.content,
    version.parentId ?? null,
    version.origin,
    version.createdAt ?? Date.now(),
  )
  return Number(result.lastInsertRowid)
}

/**
 * One prompt version.
 *
 * @returns the row, or undefined.
 */
export function getPrompt(db, workspace, id) {
  return one(db, 'SELECT * FROM prompts WHERE workspace = ? AND id = ?', workspace, id)
}

/**
 * The version chain a prompt belongs to, oldest first.
 *
 * Walks `parent_id` up to the root and then reads the whole chain down, so a
 * version opened from history shows the same lineage the workbench does. The walk
 * is bounded by the row count, so a corrupted cycle cannot spin forever.
 *
 * @returns the chain, oldest first.
 */
export function promptChain(db, workspace, id) {
  const seen = new Set()
  let root = id
  for (;;) {
    if (seen.has(root)) break
    seen.add(root)
    const row = getPrompt(db, workspace, root)
    if (row === undefined || row.parent_id === null) break
    root = row.parent_id
  }

  const chain = []
  const visited = new Set()
  let current = root
  while (current !== null && current !== undefined && !visited.has(current)) {
    visited.add(current)
    const row = getPrompt(db, workspace, current)
    if (row === undefined) break
    chain.push(row)
    const child = one(
      db,
      'SELECT id FROM prompts WHERE workspace = ? AND parent_id = ? ORDER BY id LIMIT 1',
      workspace,
      current,
    )
    current = child === undefined ? null : child.id
  }
  return chain
}

/**
 * List prompt versions, newest first.
 *
 * @param filter - `{ mode, limit }`, both optional.
 */
export function listPrompts(db, workspace, filter = {}) {
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 200
  if (filter.mode === 'system' || filter.mode === 'user') {
    return all(
      db,
      'SELECT * FROM prompts WHERE workspace = ? AND mode = ? ORDER BY id DESC LIMIT ?',
      workspace,
      filter.mode,
      limit,
    )
  }
  return all(db, 'SELECT * FROM prompts WHERE workspace = ? ORDER BY id DESC LIMIT ?', workspace, limit)
}

/** Delete one prompt version. @returns whether a row was removed. */
export function deletePrompt(db, workspace, id) {
  return db.prepare('DELETE FROM prompts WHERE workspace = ? AND id = ?').run(workspace, id).changes > 0
}

/**
 * Record one model run.
 *
 * A failed run is stored too, with its `error`: a comparison where one column
 * failed should still be in the history, or the failure looks like it never
 * happened.
 *
 * @returns the new row id.
 */
export function insertRun(db, run) {
  const statement = db.prepare(
    `INSERT INTO runs (workspace, kind, provider, model, prompt_id, input, output, elapsed_ms, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const result = statement.run(
    run.workspace,
    run.kind,
    run.provider,
    run.model,
    run.promptId ?? null,
    run.input ?? '',
    run.output ?? '',
    run.elapsedMs ?? 0,
    run.error ?? null,
    run.createdAt ?? Date.now(),
  )
  return Number(result.lastInsertRowid)
}

/**
 * List runs, newest first.
 *
 * @param filter - `{ mode, provider, model, limit }`; `mode` filters through the
 *   run's prompt when it has one.
 */
export function listRuns(db, workspace, filter = {}) {
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 200
  const clauses = ['runs.workspace = ?']
  const params = [workspace]
  if (typeof filter.provider === 'string' && filter.provider !== '') {
    clauses.push('runs.provider = ?')
    params.push(filter.provider)
  }
  if (typeof filter.model === 'string' && filter.model !== '') {
    clauses.push('runs.model = ?')
    params.push(filter.model)
  }
  const where = clauses.join(' AND ')
  if (filter.mode === 'system' || filter.mode === 'user') {
    return all(
      db,
      `SELECT runs.* FROM runs
       JOIN prompts ON prompts.id = runs.prompt_id AND prompts.workspace = runs.workspace
       WHERE ${where} AND prompts.mode = ?
       ORDER BY runs.id DESC LIMIT ?`,
      ...params,
      filter.mode,
      limit,
    )
  }
  return all(db, `SELECT runs.* FROM runs WHERE ${where} ORDER BY runs.id DESC LIMIT ?`, ...params, limit)
}

/** Delete one run. @returns whether a row was removed. */
export function deleteRun(db, workspace, id) {
  return db.prepare('DELETE FROM runs WHERE workspace = ? AND id = ?').run(workspace, id).changes > 0
}

/** Every template for a workspace: built-ins first, then the user's own. */
export function listTemplates(db, workspace) {
  return all(db, 'SELECT * FROM templates WHERE workspace = ? ORDER BY builtin DESC, id ASC', workspace)
}

/**
 * Insert or update a template by name.
 *
 * Name is the key: saving over an existing name replaces it, which is what "save
 * as template" means when the user reuses a name. A built-in name cannot be
 * overwritten — the shipped set stays intact and the save is refused.
 *
 * @returns `{ id, replaced }`, or null when the name is a built-in.
 */
export function saveTemplate(db, workspace, template) {
  const clash = one(db, 'SELECT id, builtin FROM templates WHERE workspace = ? AND name = ?', workspace, template.name)
  if (clash !== undefined && clash.builtin === 1) return null
  if (clash !== undefined) {
    run(db, 'UPDATE templates SET mode = ?, body = ? WHERE id = ?', template.mode, template.body, clash.id)
    return { id: clash.id, replaced: true }
  }
  const statement = db.prepare(
    'INSERT INTO templates (workspace, name, mode, body, builtin, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  )
  const result = statement.run(workspace, template.name, template.mode, template.body, Date.now())
  return { id: Number(result.lastInsertRowid), replaced: false }
}

/** Delete a user template. Built-ins are never deleted. @returns whether a row went. */
export function deleteTemplate(db, workspace, id) {
  return db.prepare('DELETE FROM templates WHERE workspace = ? AND id = ? AND builtin = 0')
    .run(workspace, id).changes > 0
}

/**
 * The templates every fresh workspace starts with.
 *
 * These are the SYSTEM prompts handed to the optimiser, so each one is an
 * instruction to the model about how to rewrite — not a prompt for the user's own
 * task. They are seeded once and never re-seeded, so a user who deletes one is not
 * fighting the plugin to keep it deleted.
 */
const BUILTIN_TEMPLATES = [
  {
    name: '通用优化',
    mode: 'user',
    body: '你是一名提示词工程师。把用户给的原始提示词改写成一个更有效的提示词，只输出改写后的提示词本身。',
  },
  {
    name: '结构化扩写',
    mode: 'user',
    body: '你是一名提示词工程师。把用户给的原始提示词扩写成结构完整的提示词，补齐：角色设定、任务目标、输入说明、约束条件、输出格式、质量标准。只输出改写后的提示词本身。',
  },
  {
    name: '精简压缩',
    mode: 'user',
    body: '你是一名提示词工程师。把用户给的原始提示词压缩得更短更硬：删掉重复、空话和自相矛盾的部分，保留全部实质约束。只输出改写后的提示词本身。',
  },
  {
    name: '加输出格式约束',
    mode: 'user',
    body: '你是一名提示词工程师。为原始提示词补上明确的输出格式约束（结构、字段、长度上限、示例）。不要改变任务本身。只输出改写后的提示词本身。',
  },
  {
    name: '角色设定补全',
    mode: 'system',
    body: '你是一名提示词工程师。为原始的系统提示词补全角色设定、能力边界与行为准则，使模型的行为可预测、可判定。只输出改写后的系统提示词本身。',
  },
]

/** Seed the built-ins, once per workspace. */
function seedBuiltinTemplates(db, workspace) {
  const count = one(db, 'SELECT COUNT(*) AS n FROM templates WHERE workspace = ?', workspace)
  if (Number(count?.n ?? 0) > 0) return
  const statement = db.prepare(
    'INSERT INTO templates (workspace, name, mode, body, builtin, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  )
  const now = Date.now()
  for (const template of BUILTIN_TEMPLATES) {
    statement.run(workspace, template.name, template.mode, template.body, now)
  }
}
