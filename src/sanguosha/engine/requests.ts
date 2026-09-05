import type { CardId, CharacterId, PlayerId, Suit } from './types'

interface RequestBase<K extends string> {
  id: string
  kind: K
  playerId: PlayerId
  prompt: string
  timeoutMs: number
  optional: boolean
}

export type ChooseGeneralRequest = RequestBase<'choose-general'> & {
  /** 本局随机发到的候选，固定娱乐武将也会包含在这里。 */
  candidates: CharacterId[]
  /** 仅单机真人拥有；用于自选界面，服务端仍按该白名单校验。 */
  allCandidates?: CharacterId[]
  /** 固定展示在“自定义武将”分区的候选。 */
  fixedCandidates?: CharacterId[]
  min: 1
  max: 1
}
export type ChooseCardsRequest = RequestBase<'choose-cards'> & {
  cardIds: CardId[]
  hiddenCardSlots: string[]
  min: number
  max: number
  purpose?: 'discard-phase' | 'card-effect' | 'skill' | 'retrial' | 'pindian'
  /**
   * 改判专用：当前判定牌的公开信息。
   *
   * 判定牌是翻开的，这里不含任何暗信息。给成结构化字段而不是让客户端
   * 和 AI 去解析提示文案——文案改一个字就会把判断打错。
   */
  retrial?: {
    /** 正在判定的角色。判定对他有利与否，决定要不要改。 */
    judgingPlayerId: PlayerId
    reason: string
    cardName: string
    suit: Suit
    rank: number
  }
}
export type ChooseTargetsRequest = RequestBase<'choose-targets'> & { candidateIds: PlayerId[]; min: number; max: number }
export type ChooseOptionRequest = RequestBase<'choose-option'> & { options: Array<{ id: string; label: string }> }
export type ChooseSuitRequest = RequestBase<'choose-suit'> & { suits: Suit[] }
export type ChooseNumberRequest = RequestBase<'choose-number'> & { min: number; max: number }
export type UseCardRequest = RequestBase<'use-card'> & { actionIds: string[] }
export type RespondCardRequest = RequestBase<'respond-card'> & {
  actionIds: string[]
  requiredCardName: string
  /**
   * 还可以打出的另一种牌名。
   *
   * 绝大多数求牌只认一种（求闪、求杀）。【奇正相生】是例外：目标可以自由选择
   * 打出【杀】或【闪】，而**打错类型仍然消耗那张牌**，所以不能拆成两次询问，
   * 必须一次把两种候选都摆出来。
   */
  alternativeCardName?: string
}
export type InvokeSkillRequest = RequestBase<'invoke-skill'> & { skillId: string; actionIds: string[] }
export type ArrangeCardsRequest = RequestBase<'arrange-cards'> & { cardIds: CardId[]; minTop: number; maxTop: number; allowBottom: boolean }
export type DistributeCardsRequest = RequestBase<'distribute-cards'> & { cardIds: CardId[]; recipientIds: PlayerId[]; min: number; max: number }
export type RescueRequest = RequestBase<'rescue'> & { dyingPlayerId: PlayerId; actionIds: string[]; requiredRecover: number }

export type GameRequest =
  | ChooseGeneralRequest | ChooseCardsRequest | ChooseTargetsRequest | ChooseOptionRequest
  | ChooseSuitRequest | ChooseNumberRequest | UseCardRequest | RespondCardRequest
  | InvokeSkillRequest | ArrangeCardsRequest | DistributeCardsRequest | RescueRequest

export interface GameResponse {
  requestId: string
  playerId: PlayerId
  payload: unknown
}

export function assertNever(value: never): never {
  throw new Error(`未处理的分支：${JSON.stringify(value)}`)
}

export function requestLabel(request: GameRequest): string {
  switch (request.kind) {
    case 'choose-general': return '选择武将'
    case 'choose-cards': return '选择卡牌'
    case 'choose-targets': return '选择目标'
    case 'choose-option': return '选择选项'
    case 'choose-suit': return '选择花色'
    case 'choose-number': return '选择数字'
    case 'use-card': return '使用卡牌'
    case 'respond-card': return '响应卡牌'
    case 'invoke-skill': return '发动技能'
    case 'arrange-cards': return '排列卡牌'
    case 'distribute-cards': return '分配卡牌'
    case 'rescue': return '濒死救援'
    default: return assertNever(request)
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function validateResponse(request: GameRequest, response: GameResponse): string | null {
  if (response.requestId !== request.id) return 'requestId 不匹配'
  if (response.playerId !== request.playerId) return '响应玩家不匹配'
  const payload = response.payload as Record<string, unknown> | null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '响应 payload 必须是对象'

  switch (request.kind) {
    case 'choose-general': {
      const allowed = request.allCandidates ?? request.candidates
      return typeof payload.characterId === 'string' && allowed.includes(payload.characterId) ? null : '武将选择非法'
    }
    case 'choose-cards': {
      if (!isStringArray(payload.cardIds)) return '卡牌选择格式错误'
      const allowed = new Set([...request.cardIds, ...request.hiddenCardSlots])
      return payload.cardIds.length >= request.min
        && payload.cardIds.length <= request.max
        && new Set(payload.cardIds).size === payload.cardIds.length
        && payload.cardIds.every((id) => allowed.has(id))
        ? null
        : '卡牌选择非法'
    }
    case 'choose-targets': {
      if (!isStringArray(payload.targetIds)) return '目标选择格式错误'
      return payload.targetIds.length >= request.min
        && payload.targetIds.length <= request.max
        && new Set(payload.targetIds).size === payload.targetIds.length
        && payload.targetIds.every((id) => request.candidateIds.includes(id))
        ? null
        : '目标选择非法'
    }
    case 'choose-option': return typeof payload.optionId === 'string' && request.options.some((option) => option.id === payload.optionId) ? null : '选项非法'
    case 'choose-suit': return typeof payload.suit === 'string' && request.suits.includes(payload.suit as Suit) ? null : '花色非法'
    case 'choose-number': return Number.isInteger(payload.number) && Number(payload.number) >= request.min && Number(payload.number) <= request.max ? null : '数字非法'
    case 'use-card':
    case 'respond-card':
    case 'invoke-skill':
    case 'rescue': return typeof payload.actionId === 'string' && request.actionIds.includes(payload.actionId) ? null : 'actionId 非法'
    case 'arrange-cards': {
      if (!isStringArray(payload.top) || !isStringArray(payload.bottom)) return '排列格式错误'
      const all = [...payload.top, ...payload.bottom]
      return all.length === request.cardIds.length && new Set(all).size === all.length && all.every((id) => request.cardIds.includes(id)) && payload.top.length >= request.minTop && payload.top.length <= request.maxTop && (request.allowBottom || payload.bottom.length === 0) ? null : '排列结果非法'
    }
    case 'distribute-cards': {
      const assignments = payload.assignments
      if (!Array.isArray(assignments)) return '分配格式错误'
      const valid = assignments.every((item) => item && typeof item === 'object' && typeof item.cardId === 'string' && typeof item.recipientId === 'string' && request.cardIds.includes(item.cardId) && request.recipientIds.includes(item.recipientId))
      const ids = assignments.map((item) => (item as { cardId: string }).cardId)
      return valid && ids.length >= request.min && ids.length <= request.max && new Set(ids).size === ids.length ? null : '分配结果非法'
    }
    default: return assertNever(request)
  }
}
