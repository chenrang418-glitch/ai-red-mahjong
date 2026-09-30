export type SgsSeatSlot = 'self' | 'right-bottom' | 'right-top' | 'top-right' | 'top-center' | 'top-left' | 'left-top' | 'left-bottom'

const OPPONENT_SLOTS: Record<number, SgsSeatSlot[]> = {
  // 五人局：除自己外，四名对手在左右两侧各两名，保持镜像对称。
  4: ['right-bottom', 'right-top', 'left-top', 'left-bottom'],
  5: ['right-bottom', 'right-top', 'top-center', 'left-top', 'left-bottom'],
  6: ['right-bottom', 'right-top', 'top-right', 'top-left', 'left-top', 'left-bottom'],
  7: ['right-bottom', 'right-top', 'top-right', 'top-center', 'top-left', 'left-top', 'left-bottom'],
}

/** 下家从右侧开始、上家落在左侧；数组顺序就是从观察者起的顺时针座次。 */
export function seatSlotsForPlayerCount(playerCount: number): SgsSeatSlot[] {
  const slots = OPPONENT_SLOTS[playerCount - 1]
  if (!slots) throw new Error(`不支持 ${playerCount} 人座位布局`)
  return ['self', ...slots]
}
