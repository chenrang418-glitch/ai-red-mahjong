/**
 * 「项目说明」的已读状态。
 *
 * 用 v1 而不是笼统的 `notice_seen`：以后声明正文有实质性修改时，
 * 只要把这个常量换成 `crplay_project_notice_v2`，老用户会被当作「没读过」
 * 重新确认一次；这之前不需要，也不应该主动失效已有的确认记录。
 */
export const PROJECT_NOTICE_STORAGE_KEY = 'crplay_project_notice_v1'
const ACCEPTED_VALUE = 'accepted'

/**
 * 有没有确认过项目说明。
 *
 * 读取失败（隐私模式、存储被禁用等极少数环境）一律当作「没读过」，
 * 而不是让异常直接抛出去——那样会把整个网站的启动流程带崩。
 * 结果只是这次访问会再看到一遍说明，不影响正常使用。
 */
export function hasAcceptedProjectNotice(): boolean {
  try {
    return window.localStorage.getItem(PROJECT_NOTICE_STORAGE_KEY) === ACCEPTED_VALUE
  } catch {
    return false
  }
}

/**
 * 记录已经确认过。
 *
 * 写入失败不能阻止用户继续访问——本次照常放行，只是下次可能又要看一遍，
 * 这比「存储坏了就进不去网站」好得多。
 */
export function markProjectNoticeAccepted(): void {
  try {
    window.localStorage.setItem(PROJECT_NOTICE_STORAGE_KEY, ACCEPTED_VALUE)
  } catch {
    /* 允许本次继续访问；下次访问可能会再次显示，不是致命问题 */
  }
}
