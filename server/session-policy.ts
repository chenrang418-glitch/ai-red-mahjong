/**
 * 会话有效期规则。
 *
 * Cookie 上的 Max-Age 只是让浏览器自己不要再带过期 Cookie，它不是安全边界：
 * 谁都可以把 Cookie 的值抄下来，用 curl 直接发。所以服务端必须独立卡一遍同样的期限。
 *
 * 两个常量放在一起导出，就是为了让 Cookie 和服务端判定不可能各写各的。
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000

/**
 * 会话是否已经过期。
 *
 * 固定 30 天，不做滑动续期——登录时 Cookie 一次性给 30 天，服务端保持同一套规则，
 * 否则「Cookie 说到期了但服务端还认」或者反过来，都会变成难查的登录态问题。
 *
 * 边界与全项目其它超时判定一致：now < 到期时刻算有效，now >= 到期时刻算过期。
 */
export function isSessionExpired(issuedAt: number, now: number): boolean {
  return now - issuedAt >= SESSION_MAX_AGE_MS
}

/** 会话记录里参与有效性判定的部分。 */
export interface StoredSession {
  sessionId: string
  userId: string
  nickname: string
  at: number
}

export type SessionResolution =
  | { ok: true; userId: string; nickname: string }
  /** dropSession / dropCurrentPointer 指出调用方要顺手清掉哪些存储键。 */
  | { ok: false; error: string; dropSession: boolean; dropCurrentPointer: boolean }

/**
 * 判定一个 Cookie 带来的 sessionId 是否还能用，以及要不要顺带清理存储。
 *
 * 抽成纯函数是为了能把四个分支都测到：DO 的存储在测试里没法直接构造，
 * 而「过期后有没有真的把记录和 current 指针删掉」正是最容易写漏的部分。
 */
export function resolveStoredSession(
  sessionId: string,
  record: StoredSession | undefined,
  currentSessionId: string | undefined,
  now: number,
): SessionResolution {
  if (!record) return { ok: false, error: '会话不存在', dropSession: false, dropCurrentPointer: false }
  if (isSessionExpired(record.at, now)) {
    // 过期的记录没有保留价值，顺手删掉；current 指针只有仍指向它时才清，
    // 否则会把这个人刚建立的新会话一起打掉。
    return {
      ok: false,
      error: '会话已过期',
      dropSession: true,
      dropCurrentPointer: currentSessionId === sessionId,
    }
  }
  // 同名顶号：这条记录还在，但已经不是该用户的当前会话
  if (currentSessionId !== sessionId) {
    return { ok: false, error: '会话已失效', dropSession: false, dropCurrentPointer: false }
  }
  return { ok: true, userId: record.userId, nickname: record.nickname }
}
