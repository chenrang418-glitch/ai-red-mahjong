// D1 兼容层。底层用 Node 24 自带的 node:sqlite，不引原生模块——
// Windows 本地和 Ubuntu 服务器行为一致，部署时也不用编译。
//
// worker.ts 里有三十多处 `env.DB.prepare(...).bind(...).run()/.all()/.first()`，
// 与其把它们逐个改写成 better-sqlite3 的写法，不如在这里把 D1 的形状实现出来——
// 迁移过来的路由代码一行都不用动，以后两边真要分叉时也容易看出差在哪。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface D1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: { changes: number; last_row_id: number }
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<D1Result<T>>
  first<T = unknown>(): Promise<T | null>
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(sql: string): Promise<void>
}

class Statement implements D1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new Statement(this.db, this.sql, values)
  }

  // D1 允许 undefined 混进参数，better-sqlite3 会直接抛错，统一转成 null。
  // 布尔也要转数字：SQLite 没有布尔类型。
  private normalized(): unknown[] {
    return this.values.map((value) => {
      if (value === undefined) return null
      if (typeof value === 'boolean') return value ? 1 : 0
      return value
    })
  }

  // better-sqlite3 是同步的，batch 在事务里需要同步拿到结果，所以拆一个同步版本
  runSync<T = unknown>(): D1Result<T> {
    const info = this.db.prepare(this.sql).run(...this.normalized() as never[])
    return {
      results: [],
      success: true,
      // node:sqlite 的 changes/lastInsertRowid 可能是 bigint
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    }
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.runSync<T>()
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...this.normalized() as never[]) as T[]
    return { results: rows, success: true, meta: { changes: 0, last_row_id: 0 } }
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.normalized() as never[]) as T | undefined
    return row ?? null
  }
}

class SqliteD1 implements D1Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatement {
    return new Statement(this.db, sql)
  }

  // D1 的 batch 是一个事务，这里也一样：中途失败整批回滚。
  // node:sqlite 没有 better-sqlite3 那种 transaction() 包装，手写一层。
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.db.exec('BEGIN')
    try {
      const results = (statements as Statement[]).map((statement) => statement.runSync<T>())
      this.db.exec('COMMIT')
      return results
    } catch (cause) {
      this.db.exec('ROLLBACK')
      throw cause
    }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }
}

export function openDatabase(file: string): { db: DatabaseSync; d1: D1Database } {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // WAL 下读写不互相阻塞，单机多连接的场景比默认模式稳得多
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return { db, d1: new SqliteD1(db) }
}

// 迁移文件和 Cloudflare 那边共用一份，别再维护两套 schema
export function runMigrations(db: DatabaseSync, dirs: string[]): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((row) => row.name),
  )
  // 每个目录内部按文件名排序，目录之间按传入顺序：共享 schema 先建表，Node 专属的再补
  const files = dirs.flatMap((dir) => readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, path: join(dir, name) })))
  const executed: string[] = []
  for (const { name, path } of files) {
    if (applied.has(name)) continue
    const sql = readFileSync(path, 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now())
      db.exec('COMMIT')
      executed.push(name)
    } catch (cause) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 ${name} 失败: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  return executed
}

// 源码跑和编译后跑，相对层级不一样（dist 里多两层），
// 所以往上找到含 server/migrations 的那层当仓库根，两种情况都对。
function repoRoot(): string {
  let dir = __dirname
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'server', 'migrations'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到仓库根目录（server/migrations 不存在）')
}

// 业务表的 schema 和 Cloudflare 那边共用一份，别再维护两套；
// Node 专属的两张状态表单独放，免得 D1 平白多出用不上的表。
// 数据库放仓库根的 data/ 下，源码跑和编译后跑指向同一个文件
export function dataRoot(): string {
  return join(repoRoot(), 'server-node', 'data')
}

export function migrationsPaths(): string[] {
  const root = repoRoot()
  return [join(root, 'server', 'migrations'), join(root, 'server-node', 'migrations')]
}
