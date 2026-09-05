import { type GameRequest, type GameResponse } from './requests'

/**
 * 真人操作超时时的默认答案。
 *
 * 规则只有一条：**能放弃就放弃**。超时说明这个人没有在做决定——
 * 替他把手里的闪、桃、无懈打出去，或者替他用一张牌，等于替他做了
 * 一个他没同意的决定，牌打光了他还不知道。所以只回「最不消耗、
 * 最不承诺」的那个合法答案。
 *
 * 拿不出这样的答案时返回 `null`，由调用方兜底（必答请求不能不答，
 * 例如选将、观星排序、弃牌阶段的强制弃牌）。这里**不**做任何策略判断，
 * 也不碰随机数——超时的结果必须是确定的。
 *
 * 托管（手动挂机 / 掉线接管）走的不是这条路：那是玩家授权 AI 代打，
 * 仍然由 `decideResponse` 决策。
 */
export function timeoutDefaultResponse(request: GameRequest): GameResponse | null {
  const base = { requestId: request.id, playerId: request.playerId }
  switch (request.kind) {
    case 'respond-card':
    case 'use-card':
    case 'invoke-skill':
      // 「本轮均不使用」是更强的承诺，超时不替他做；只放弃眼前这一次
      return request.actionIds.includes('respond-pass') ? { ...base, payload: { actionId: 'respond-pass' } } : null

    case 'rescue':
      return request.actionIds.includes('rescue-pass') ? { ...base, payload: { actionId: 'rescue-pass' } } : null

    case 'choose-cards':
      return request.min === 0 ? { ...base, payload: { cardIds: [] } } : null

    case 'choose-targets':
      return request.min === 0 ? { ...base, payload: { targetIds: [] } } : null

    case 'distribute-cards':
      return request.min === 0 ? { ...base, payload: { assignments: [] } } : null

    // 以下都必须给出一个实质答案，没有「放弃」这个选项
    case 'choose-general':
    case 'choose-option':
    case 'choose-suit':
    case 'choose-number':
    case 'arrange-cards':
      return null

    default:
      return null
  }
}
