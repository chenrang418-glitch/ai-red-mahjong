<script setup lang="ts">
import { computed } from 'vue'
import { getCharacter } from '../data/characters/standard'
import type { PlayerView } from '../engine/view'
import type { GameResult } from '../engine/types'

/**
 * 对局结算弹层。单机和联机共用同一个组件。
 *
 * 联机原来只有一行「本局结束 + 原因」，看不到谁是什么身份——而那正是
 * 一局身份局结束时玩家最想看的一屏。两边共用一份实现，样式和信息量
 * 就不会再各自漂移。
 *
 * 身份在 `status === 'game-over'` 时由服务端统一公开，这里不自己推断。
 */

const props = defineProps<{
  view: PlayerView
  result: GameResult
  /** 主按钮文案。单机是「再来一局」，联机等其他人时会变成「等待其他玩家」。 */
  againLabel?: string
  againDisabled?: boolean
  /** 次按钮文案。单机「返回首页」，联机「退出对局」。 */
  exitLabel?: string
}>()

const emit = defineEmits<{ again: []; exit: [] }>()

const CAMP_LABEL: Record<string, string> = { lord: '主公与忠臣', rebel: '反贼', renegade: '内奸' }
const IDENTITY_LABEL: Record<string, string> = { lord: '主公', loyalist: '忠臣', rebel: '反贼', renegade: '内奸' }
const WINNING_IDENTITIES: Record<string, string[]> = {
  lord: ['lord', 'loyalist'], rebel: ['rebel'], renegade: ['renegade'],
}

const campLabel = computed(() => CAMP_LABEL[props.result.winningCamp] ?? props.result.winningCamp)

const roster = computed(() => {
  const winners = WINNING_IDENTITIES[props.result.winningCamp] ?? []
  return props.view.players.map((player) => ({
    id: player.id,
    nickname: player.nickname,
    identity: player.identity ?? 'unknown',
    characterName: player.characterId ? getCharacter(player.characterId)?.name ?? '未知' : '未选将',
    alive: player.alive,
    hp: player.hp,
    maxHp: player.maxHp,
    won: winners.includes(player.identity ?? ''),
    self: player.id === props.view.viewerId,
  }))
})
</script>

<template>
  <div class="sgs-result-backdrop">
    <section class="sgs-result" role="dialog" aria-modal="true">
      <h2>{{ campLabel }}获胜</h2>
      <p>{{ result.reason }}</p>
      <!-- 牌局结束才公开全部身份，这是玩家最想看的一屏 -->
      <ol class="sgs-result__roster">
        <li v-for="player in roster" :key="player.id" :class="{ won: player.won, dead: !player.alive, self: player.self }">
          <span class="sgs-result__identity" :class="`sgs-result__identity--${player.identity}`">{{ IDENTITY_LABEL[player.identity] ?? '？' }}</span>
          <strong>{{ player.nickname }}<em v-if="player.self" class="sgs-result__self">你</em></strong>
          <small>{{ player.characterName }}</small>
          <em>{{ player.alive ? `存活 ${player.hp}/${player.maxHp}` : '阵亡' }}</em>
        </li>
      </ol>
      <div class="sgs-result__actions">
        <button type="button" class="danger" @click="emit('exit')">{{ exitLabel ?? '返回首页' }}</button>
        <button type="button" class="primary" :disabled="againDisabled" @click="emit('again')">{{ againLabel ?? '再来一局' }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sgs-result-backdrop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 20px; background: rgba(3, 10, 8, .74); }
.sgs-result {
  width: min(380px, 100%); padding: 24px; text-align: center;
  border: 1px solid rgba(226, 191, 98, .38); border-radius: 20px;
  background: linear-gradient(160deg, #1d2b23, #131c17); color: #e8dfca;
  box-shadow: 0 26px 70px rgba(0, 0, 0, .55);
  animation: sgs-result-in .28s ease-out both;
}
@keyframes sgs-result-in { from { opacity: 0; transform: translateY(14px) scale(.97); } }
.sgs-result h2 { margin: 0 0 8px; color: #f3d67c; font-size: 21px; }
.sgs-result p { margin: 0 0 18px; color: #a3aea5; font-size: 13px; }
.sgs-result__roster { margin: 0 0 16px; padding: 0; list-style: none; display: grid; gap: 5px; max-height: 44dvh; overflow-y: auto; }
.sgs-result__roster li {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px;
  padding: 7px 9px; border: 1px solid #3a453d; border-radius: 9px; background: rgba(34, 50, 42, .7);
}
.sgs-result__roster li.won { border-color: #cfa456; background: rgba(155, 122, 55, .22); }
.sgs-result__roster li.dead { opacity: .55; }
.sgs-result__roster li.self { box-shadow: inset 0 0 0 1px rgba(226, 191, 98, .45); }
.sgs-result__roster strong { min-width: 0; display: flex; align-items: center; gap: 5px; overflow: hidden; color: #f7f0df; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; text-shadow: 0 1px 2px rgba(0, 0, 0, .72); }
.sgs-result__self { flex: none; padding: 0 4px; border-radius: 4px; background: #5d471f; color: #ffe8aa; font-size: 9px; font-style: normal; }
.sgs-result__roster small { grid-column: 2; color: #8f9a91; font-size: 11px; text-align: left; }
.sgs-result__roster em { grid-row: 1 / 3; color: #b6bfb7; font-size: 11px; font-style: normal; }
.sgs-result__identity { grid-row: 1 / 3; padding: 2px 6px; border-radius: 5px; background: #2b3831; color: #93a49b; font-size: 10px; }
.sgs-result__identity--lord { background: #6a4a1c; color: #ffd98a; }
.sgs-result__identity--rebel { background: #59326f; color: #e6c8ff; }
.sgs-result__identity--loyalist { background: #21432f; color: #a6e0bb; }
.sgs-result__identity--renegade { background: #762f2b; color: #ffc0b8; }
.sgs-result__actions { display: flex; gap: 8px; }
/*
  两个按钮**同一套形状**，只有配色不同：用户明确要求退出键和再来一局
  长得一样。所以圆角、高度、字重都写在这条通用规则里，
  各自的 class 只覆盖颜色。
*/
.sgs-result__actions button {
  flex: 1; min-height: 52px; padding: 0 18px; border-radius: 11px;
  border: 1px solid #9e7f3c; background: linear-gradient(180deg, #6d5527, #4c3b1a);
  color: #ffe6a8; cursor: pointer; font: inherit; font-weight: 800;
}
.sgs-result__actions button:disabled { opacity: .5; cursor: default; }
.sgs-result__actions .danger { border-color: #b95147; background: linear-gradient(180deg, #a9433a, #7f2d28); color: #fff1ed; }
@media (max-width: 620px), (orientation: landscape) and (max-height: 500px) {
  .sgs-result { padding: 18px; }
  .sgs-result__actions button { min-height: 44px; }
}
</style>
