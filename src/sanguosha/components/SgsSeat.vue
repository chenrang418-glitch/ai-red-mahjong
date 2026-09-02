<script setup lang="ts">
import { computed } from 'vue'
import { getCharacter } from '../data/characters/standard'
import { cardGlossary, characterGlossary, identityGlossary, ruleGlossary, skillGlossary } from '../glossary'
import { useSgsGlossary } from '../composables/useSgsGlossary'
import type { PlayerPublicView } from '../engine/view'
import { characterPortrait } from '../assets/characters/manifest'

const props = withDefaults(defineProps<{
  player: PlayerPublicView
  viewerId: string
  active?: boolean
  selectable?: boolean
  selected?: boolean
  threatened?: boolean
  effect?: 'damage' | 'recover' | 'dodge' | 'skill' | null
  status?: 'online' | 'offline' | 'trustee' | 'connecting' | null
  hint?: string
  displayName?: string
  /** 认了这名角色当「麻麻」的牛来们（显示名）。公开信息，空数组表示不是任何人的麻麻。 */
  mamaOwners?: readonly string[]
}>(), { active: false, selectable: false, selected: false, threatened: false, effect: null, status: null, hint: '', displayName: '', mamaOwners: () => [] })

const emit = defineEmits<{ select: [playerId: string] }>()
const glossary = useSgsGlossary()
const IDENTITY_TEXT: Record<string, string> = { lord: '主公', loyalist: '忠臣', rebel: '反贼', renegade: '内奸' }
const SLOT_TEXT: Record<string, string> = { weapon: '武器', armor: '防具', offensiveHorse: '-1马', defensiveHorse: '+1马' }

const character = computed(() => (props.player.characterId ? getCharacter(props.player.characterId) : undefined))
/**
 * 判定区的一字标记。延时锦囊只有这三种，首字不会混淆。
 * 全名走 aria-label / title / 词条面板，信息没有丢。
 */
const JUDGE_MARK: Record<string, string> = { 乐不思蜀: '乐', 兵粮寸断: '兵', 闪电: '电' }
function judgeMark(cardName: string): string {
  return JUDGE_MARK[cardName] ?? cardName.slice(0, 1)
}
const hasStates = computed(() => props.player.chained || props.player.faceDown || !props.player.alive
  || props.mamaOwners.length > 0
  || props.status === 'offline' || props.status === 'trustee' || props.status === 'connecting')
/**
 * 武将专属牌堆（周泰的「创」）只显示「不屈 ×3」。
 *
 * 手机上把三张牌横排会直接把座位撑爆，所以这里只给技能名和张数，
 * 具体牌面点开词条看。名字取自武将技能表，找不到就退回技能 id。
 */
const characterPiles = computed(() => Object.entries(props.player.characterPiles ?? {})
  .filter(([, cards]) => cards.length > 0)
  .map(([pile, cards]) => ({
    pile,
    count: cards.length,
    label: character.value?.skills.find((skill) => skill.id === pile)?.name ?? pile,
  })))
const identityText = computed(() => (props.player.identity ? IDENTITY_TEXT[props.player.identity] : '？'))
/**
 * 体力槽。
 *
 * 已失去的体力必须靠**形状**区分，不能只靠颜色：手机上这里只有 10px，
 * 灰色实心心和红色实心心在那个尺寸下读起来是一样的，玩家会以为血没掉。
 * 空心 ♡ 在任何尺寸、任何色觉条件下都分得出来。
 */
const hpHearts = computed(() => Array.from({ length: props.player.maxHp }, (_, index) => index < props.player.hp))
const initials = computed(() => character.value?.name.slice(-1) ?? props.player.nickname.slice(0, 1))
const portrait = computed(() => characterPortrait(props.player.characterId))
/**
 * 裁切参数以 CSS 变量下发，PC 和移动端各一套，由媒体查询决定用哪套。
 * 组件不认识「曹操该往哪偏」——那是 manifest 的事。
 */
const artVars = computed(() => {
  const art = portrait.value
  if (!art) return undefined
  return {
    '--art-pos': art.desktop.position,
    '--art-scale': String(art.desktop.scale),
    '--art-pos-mobile': art.mobile.position,
    '--art-scale-mobile': String(art.mobile.scale),
  }
})
</script>

<template>
  <article
    class="sgs-seat"
    :class="{
      'sgs-seat--active': active, 'sgs-seat--selected': selected, 'sgs-seat--selectable': selectable,
      'sgs-seat--dead': !player.alive, 'sgs-seat--chained': player.chained, 'sgs-seat--threatened': threatened,
      'sgs-seat--has-art': !!portrait,
      [`sgs-seat--effect-${effect}`]: !!effect,
    }"
    :data-seat-id="player.id"
  >
    <button v-if="selectable" type="button" class="sgs-seat__target-hitbox" :aria-label="`选择${player.nickname}为目标`" @click="emit('select', player.id)"></button>
    <!--
      座位是四层：势力底色 → 立绘 → 渐变遮罩 → 信息。
      立绘用独立 <img> 而不是 background-size:cover，因为位置、缩放、灰度、
      阵亡态这些以后都要分别控制，背景图给不了这个自由度。
    -->
    <div class="sgs-seat__portrait" :class="`sgs-seat__portrait--${character?.kingdom ?? 'unknown'}`" aria-hidden="true"><span v-if="!portrait">{{ initials }}</span></div>
    <div v-if="portrait" class="sgs-seat__art" aria-hidden="true">
      <img :src="portrait.src" :style="artVars" alt="" decoding="async" loading="lazy">
    </div>
    <div class="sgs-seat__shade" :class="{ 'sgs-seat__shade--art': !!portrait }" aria-hidden="true"></div>
    <header class="sgs-seat__header">
      <button type="button" class="sgs-seat__identity" :class="`sgs-seat__identity--${player.identity ?? 'hidden'}`" @click.stop="glossary?.open(identityGlossary(player.identity))">{{ identityText }}</button>
      <strong>{{ player.nickname }}</strong><span v-if="active" class="sgs-seat__turn">行动中</span>
    </header>
    <div class="sgs-seat__body">
      <button v-if="character" type="button" class="sgs-seat__general" @click.stop="glossary?.open(characterGlossary(player.characterId!))">{{ displayName || character.name }}</button>
      <span v-else class="sgs-seat__general">未选将</span>
      <div class="sgs-seat__hp" :aria-label="`体力 ${player.hp} / ${player.maxHp}`"><span v-for="(filled, index) in hpHearts" :key="index" :class="{ empty: !filled }">{{ filled ? '♥' : '♡' }}</span><small>{{ player.hp }}/{{ player.maxHp }}</small></div>
      <div class="sgs-seat__meta">
        <span>手牌 {{ player.handCount }}</span>
        <button v-if="player.id === viewerId" type="button" @click.stop="glossary?.open(ruleGlossary('range'))">范围 {{ player.attackRange }}</button>
        <button v-else-if="player.distanceFromViewer !== null" type="button" @click.stop="glossary?.open(ruleGlossary('distance'))">距 {{ player.distanceFromViewer }}</button>
      </div>
    </div>
    <div v-if="player.equipment.length" class="sgs-seat__equipment">
      <button v-for="card in player.equipment" :key="card.id" type="button" @click.stop="glossary?.open(cardGlossary(card.name))"><small>{{ SLOT_TEXT[card.equipmentSlot ?? ''] ?? '装备' }}</small><span>{{ card.name }}</span></button>
    </div>
    <!--
      武将专属牌堆（周泰的「创」）。手机上一张一张横排会把座位撑爆，
      所以只显示「不屈 ×3」，点开走词条面板看具体牌面。
    -->
    <div v-if="characterPiles.length" class="sgs-seat__piles">
      <button v-for="entry in characterPiles" :key="entry.pile" type="button" @click.stop="glossary?.open(skillGlossary(entry.pile))">
        {{ entry.label }} ×{{ entry.count }}
      </button>
    </div>
    <!--
      判定区并进状态行，而且只显示一个字。
      原来它是单独一行、chip 没有 flex:none：两张判定牌会被压到 16px 宽、7px 高，
      字直接被裁掉，叠在立绘上等于看不见（用户报的「被遮挡」）。
      延时锦囊只有三种，首字「乐 / 兵 / 电」不会混淆；全名在 aria-label 和词条里。
    -->
    <div v-if="player.judgingArea.length || hasStates" class="sgs-seat__states">
      <button
        v-for="card in player.judgingArea"
        :key="card.id"
        type="button"
        class="sgs-seat__judge-chip"
        :aria-label="`判定区：${card.name}`"
        :title="card.name"
        @click.stop="glossary?.open(cardGlossary(card.name))"
      >{{ judgeMark(card.name) }}</button>
      <span
        v-if="mamaOwners.length"
        class="sgs-seat__mama-chip"
        :aria-label="`${mamaOwners.join('、')}的麻麻`"
        :title="`${mamaOwners.join('、')}的麻麻`"
      >麻麻</span><button v-if="player.chained" type="button" @click.stop="glossary?.open(ruleGlossary('chained'))">横置</button><span v-if="player.faceDown">翻面</span><span v-if="!player.alive">阵亡</span><span v-if="status === 'offline'">离线</span><span v-if="status === 'trustee'">托管</span><span v-if="status === 'connecting'">连接中</span>
    </div>
    <div v-if="character?.skills.length" class="sgs-seat__skills"><button v-for="skill in character.skills" :key="skill.id" type="button" @click.stop="glossary?.open(skillGlossary(skill.id))">{{ skill.name }}</button></div>
    <p v-if="hint" class="sgs-seat__hint">{{ hint }}</p><span v-if="selected" class="sgs-seat__target-mark">目标</span>
  </article>
</template>

<style scoped>
.sgs-seat{position:relative;min-width:0;height:100%;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:3px;padding:7px 8px;border:1px solid #415249;border-radius:12px;background:#14241d;color:#eee6d2;box-shadow:0 6px 18px rgba(0,0,0,.28);transition:opacity .18s,border-color .18s,transform .18s}.sgs-seat__target-hitbox{position:absolute;inset:0;z-index:1;border:0;border-radius:inherit;background:transparent;cursor:crosshair}.sgs-seat__portrait{position:absolute;inset:0;display:grid;place-items:center;opacity:.8;background:radial-gradient(circle at 60% 30%,rgba(181,148,79,.22),transparent 45%),linear-gradient(145deg,#344b3e,#14231d)}.sgs-seat__portrait span{color:rgba(235,217,166,.2);font:900 clamp(38px,5vw,76px)/1 KaiTi,serif;transform:rotate(-7deg)}.sgs-seat__portrait--wei{background-color:#26384c}.sgs-seat__portrait--shu{background-color:#31472d}.sgs-seat__portrait--wu{background-color:#4c2f2c}.sgs-seat__portrait--qun{background-color:#40374b}.sgs-seat__shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,16,12,.94),rgba(8,16,12,.7) 58%,rgba(8,16,12,.28))}.sgs-seat>:not(.sgs-seat__portrait,.sgs-seat__art,.sgs-seat__shade,.sgs-seat__target-hitbox){position:relative;z-index:2}.sgs-seat--selectable{border-color:#d6bd69;box-shadow:0 0 0 2px rgba(214,189,105,.28),0 0 18px rgba(214,189,105,.25)}.sgs-seat--selectable:not(.sgs-seat--selected){animation:seat-candidate 1.4s ease-in-out infinite}.sgs-seat--active{border-color:#e8c66d;box-shadow:0 0 0 1px rgba(232,198,109,.45),0 0 22px rgba(232,198,109,.32);animation:seat-active 1.8s ease-in-out infinite}.sgs-seat--selected{border-color:#f06f5c;box-shadow:0 0 0 3px rgba(240,111,92,.55),0 0 24px rgba(240,85,70,.3)}.sgs-seat--threatened,.sgs-seat--effect-damage{border-color:#ef6559;animation:seat-hit .48s ease}.sgs-seat--effect-recover{border-color:#68d191;animation:seat-recover .65s ease}.sgs-seat--effect-dodge{border-color:#dce8d4}.sgs-seat--effect-skill{border-color:#b89bf0}.sgs-seat--dead{opacity:.76}.sgs-seat--chained:after{content:'⛓';position:absolute;right:5px;bottom:4px;z-index:2;color:#d0b865;font-size:14px}.sgs-seat__header{display:flex;align-items:center;gap:4px;min-width:0}.sgs-seat__header strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}button{font:inherit}.sgs-seat__identity,.sgs-seat__general,.sgs-seat__meta button,.sgs-seat__equipment button,.sgs-seat__states button,.sgs-seat__skills button{border:0;padding:0;background:transparent;color:inherit;cursor:help}.sgs-seat__identity{flex:none;padding:1px 5px;border-radius:4px;background:#2b3831;color:#9cac9f;font-size:9px}.sgs-seat__identity--lord{background:#6a4a1c;color:#ffd98a}.sgs-seat__identity--rebel{background:#5c2622;color:#ffb3aa}.sgs-seat__identity--loyalist{background:#21432f;color:#a6e0bb}.sgs-seat__identity--renegade{background:#3d3151;color:#cbb6ee}.sgs-seat__turn{margin-left:auto;padding:1px 4px;border-radius:4px;background:#806226;color:#ffe39a;font-size:8px;white-space:nowrap}.sgs-seat__body{display:grid;gap:2px}.sgs-seat__general{justify-self:start;color:#ead28b;font-weight:800;font-size:13px}.sgs-seat__hp{display:flex;align-items:center;gap:1px;color:#e76054;font-size:12px;line-height:1}.sgs-seat__hp .empty{color:#8d8375}.sgs-seat__hp small{margin-left:3px;color:#d8cfc0;font-size:8px}.sgs-seat__meta{display:flex;gap:7px;color:#a5b3aa;font-size:9px}.sgs-seat__meta button{text-decoration:underline dotted;text-underline-offset:2px}.sgs-seat__equipment,.sgs-seat__piles{display:flex;gap:3px;min-width:0;overflow:hidden}.sgs-seat__piles button{padding:1px 4px;border:1px solid rgba(215,150,120,.4);border-radius:3px;background:rgba(60,26,22,.7);color:#f0b9a6;font-size:8px;cursor:help}.sgs-seat__equipment button{min-width:0;display:flex;gap:3px;padding:1px 3px;border:1px solid rgba(157,141,96,.3);border-radius:4px;background:rgba(8,14,11,.6);font-size:8px}.sgs-seat__equipment small{color:#8e9b92}.sgs-seat__equipment span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d7c795}.sgs-seat__states,.sgs-seat__skills{display:flex;gap:3px;flex-wrap:wrap;font-size:8px}.sgs-seat__states span,.sgs-seat__states button{flex:none;padding:1px 3px;border-radius:3px;background:#3a2926;color:#f1afa5}.sgs-seat__judge-chip{min-width:13px;text-align:center;background:#7d2b23;color:#ffd9d2;font-weight:800}.sgs-seat__mama-chip{background:#4a3a6b;color:#dcc8ff;font-weight:800}.sgs-seat__skills button{padding:1px 3px;border:1px solid rgba(210,183,106,.25);border-radius:3px;color:#cdbd8e}.sgs-seat__hint{margin:0;color:#f2d47e;font-size:8px}.sgs-seat__target-mark{position:absolute!important;right:5px;top:24px;padding:2px 5px;border-radius:8px;background:#a83e35;color:white;font-size:8px;font-weight:800}@keyframes seat-active{50%{box-shadow:0 0 0 2px rgba(232,198,109,.55),0 0 28px rgba(232,198,109,.4)}}@keyframes seat-candidate{50%{border-color:#ffe39a}}@keyframes seat-hit{30%{transform:translateX(-4px)}60%{transform:translateX(4px)}}@keyframes seat-recover{50%{box-shadow:0 0 28px rgba(81,210,132,.62)}}@media(max-width:820px){.sgs-seat{padding:5px 6px;border-radius:9px}.sgs-seat__equipment{display:none}.sgs-seat__skills{max-height:14px;overflow:hidden}.sgs-seat__general{font-size:11px}.sgs-seat__hp{font-size:10px}.sgs-seat__header strong{font-size:9px}}@media(prefers-reduced-motion:reduce){.sgs-seat{animation:none!important;transition:none!important}}
.sgs-seat__target-hitbox{z-index:3}.sgs-seat button:not(.sgs-seat__target-hitbox){position:relative;z-index:4}

/*
 * 手机座位仍要展示完整公开信息。旧规则直接隐藏装备并把技能裁到 14px，
 * 导致玩家必须猜测场面；这里改用紧凑双列槽位，不再以隐藏内容换取空间。
 */
@media (max-width: 820px) {
  .sgs-seat { gap: 2px; padding: 4px 5px; }
  .sgs-seat__body { gap: 1px; }
  /* 体力数字是唯一无歧义的信息，之前为省空间藏掉了，结果掉血看不出来 */
  .sgs-seat__hp small { display: inline; margin-left: 2px; font-size: 7px; }
  .sgs-seat__equipment {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
    overflow: visible;
  }
  .sgs-seat__equipment button {
    min-width: 0;
    justify-content: center;
    padding: 1px 2px;
    font-size: 7px;
    line-height: 1.15;
  }
  .sgs-seat__equipment small { display: none; }
  .sgs-seat__equipment span {
    overflow: visible;
    text-overflow: clip;
    white-space: nowrap;
  }
  .sgs-seat__skills {
    max-height: none;
    overflow: visible;
    flex-wrap: nowrap;
    gap: 2px;
  }
  .sgs-seat__skills button {
    padding: 1px 3px;
    white-space: nowrap;
    font-size: 8px;
    line-height: 1.15;
  }
}

@media (orientation: landscape) and (max-height: 500px) {
  .sgs-seat { gap: 1px; padding: 3px 4px; }
  .sgs-seat__header strong, .sgs-seat__general { font-size: 9px; }
  .sgs-seat__hp { font-size: 8px; }
  .sgs-seat__meta, .sgs-seat__states, .sgs-seat__skills { font-size: 7px; }
  .sgs-seat__equipment button, .sgs-seat__skills button { font-size: 7px; }
}
/*
 * 立绘层。
 *
 * 人物只占座位右侧一条，左侧留给文字；左边缘用 mask 化开，
 * 否则看起来像贴了一个矩形补丁而不是「座位里有个人」。
 */
.sgs-seat__art {
  position: absolute; z-index: 1; right: 0; top: 0; bottom: 0;
  left: 0;
  /*
   * 立绘铺满整个座位，不加遮罩——用户选的就是这个「整张画」的观感。
   * 文字的可读性改由轻量阴影承担，见下面 `--has-art` 那一段。
   *
   * 外层负责裁剪。放大后的图必须在这里被切掉，不能只靠座位卡的 overflow：
   * 那样 transform 撑出来的部分会算进座位的 scrollHeight，
   * 「角色卡内容被裁切」的检查会误判成信息放不下。
   */
  overflow: hidden;
  pointer-events: none;
}
.sgs-seat__art img {
  width: 100%; height: 100%; display: block;
  object-fit: cover;
  object-position: var(--art-pos, 50% 20%);
  transform: scale(var(--art-scale, 1));
  /* 缩放围绕同一个焦点：焦点定「看哪儿」，倍率定「多近」，两个参数不打架 */
  transform-origin: var(--art-pos, 50% 20%);
  transition: filter .22s ease, opacity .22s ease;
}
/* 自己的座位更宽更矮，人物可以露多一点，但不能压到操作信息 */

/*
 * 文字侧再加一层投影。
 *
 * 实测下来技能标签这一行会伸进立绘的不透明区：自己座位最多 26px，其他座位 1~9px。
 * 收窄文字列会把移动端的双列装备槽挤坏（那正是上一批刚修好的），
 * 所以这里用投影兜底，不动布局。
 */
.sgs-seat--has-art .sgs-seat__header strong,
.sgs-seat--has-art .sgs-seat__general,
.sgs-seat--has-art .sgs-seat__hp,
.sgs-seat--has-art .sgs-seat__hp small,
.sgs-seat--has-art .sgs-seat__meta,
.sgs-seat--has-art .sgs-seat__meta button,
.sgs-seat--has-art .sgs-seat__hint {
  color: #fff;
  text-shadow: 0 1px 2px #000, 0 0 5px rgba(0, 0, 0, .92);
}
.sgs-seat--has-art .sgs-seat__general { color: #ffe6a0; font-weight: 900; }
.sgs-seat--has-art .sgs-seat__hp span { color: #ff6a5c; }
/* 空心心在亮底上要够亮才看得出是「空的」 */
.sgs-seat--has-art .sgs-seat__hp .empty { color: #e8e0d2; }
/* 这几类本来就有底色，加深到足以盖住任意画面即可，不额外加新的色块 */
.sgs-seat--has-art .sgs-seat__identity,
.sgs-seat--has-art .sgs-seat__equipment button,
.sgs-seat--has-art .sgs-seat__skills button,
.sgs-seat--has-art .sgs-seat__states span,
.sgs-seat--has-art .sgs-seat__states button { background: rgba(0, 0, 0, .78); color: #fff; text-shadow: none; }
/*
  判定标记不跟着变成黑底白字：它是「你下回合会被跳过 / 会被劈」这种要一眼看见的信息，
  在立绘上必须比其他状态更抢眼，所以保留红底。这条排在通用规则之后才生效。
*/
.sgs-seat--has-art .sgs-seat__states .sgs-seat__mama-chip { background: rgba(74, 58, 107, .95); color: #e4d5ff; text-shadow: 0 1px 2px rgba(0, 0, 0, .9); }
/* 选择器要比上面那条 `.sgs-seat--has-art .sgs-seat__states button`(0,2,1) 更具体，
   否则红底会被通用的黑底盖掉——实测踩过 */
.sgs-seat--has-art .sgs-seat__states .sgs-seat__judge-chip { background: rgba(140, 42, 34, .95); color: #ffdcd5; text-shadow: 0 1px 2px rgba(0, 0, 0, .9); }
.sgs-seat .sgs-seat__identity--lord { background: rgba(114, 85, 29, .94); color: #ffe39a; }
.sgs-seat .sgs-seat__identity--renegade { background: rgba(118, 47, 43, .94); color: #ffc0b8; }
.sgs-seat .sgs-seat__identity--rebel { background: rgba(89, 50, 111, .94); color: #e6c8ff; }
.sgs-seat .sgs-seat__identity--loyalist { background: rgba(36, 83, 58, .94); color: #b8f0ca; }
.sgs-seat .sgs-seat__identity--hidden { background: rgba(0, 0, 0, .82); color: #fff; }
.sgs-seat--has-art .sgs-seat__turn { background: rgba(122, 92, 30, .92); color: #ffe39a; text-shadow: none; }

/*
 * 有立绘时不压任何遮罩。
 *
 * 试过三种遮罩方案：整体压暗会把画糊掉；只压左侧文字区读得清但画面被切成两半；
 * 满幅压渐变则会把脸推到右边缘。最后选的是「一点不压 + 轻量文字阴影」，
 * 避免 iPhone Safari 在小字号中文上出现描边笔画粘连。
 */
.sgs-seat__shade--art { background: none; }

/*
 * 阵亡：只把人物变灰变暗，座位整体仍保持可读。
 * 原来是给整个 .sgs-seat 加 grayscale + opacity，连身份和血量一起糊掉了。
 */
.sgs-seat--dead .sgs-seat__art img { filter: grayscale(1) brightness(.42); opacity: .72; }
/* 当前行动的人亮一点，边框之外再多一层提示 */
.sgs-seat--active .sgs-seat__art img { filter: saturate(1.12) brightness(1.06); }
/* 被选为目标时人物压暗，让红色高亮边框和目标标记先被看到 */
.sgs-seat--selected .sgs-seat__art img { filter: brightness(.82) saturate(.9); }

/*
 * 手机的两种姿态都要走「更紧」的一套参数。
 *
 * 只写 max-width:820px 是不够的：手机横屏是 932×430，宽度超过 820 却只有 94px 高的座位，
 * 会拿到 PC 的裁切参数，脸就太小。座位布局本身就是按这两条断点排的，这里对齐它。
 */
@media (max-width: 820px), (orientation: landscape) and (max-height: 500px) {
  /* 座位又矮又窄，裁切优先级是脸 > 上半身 > 武器，所以换一套更紧的参数 */
  .sgs-seat__art img {
    object-position: var(--art-pos-mobile, var(--art-pos, 50% 18%));
    transform: scale(var(--art-scale-mobile, var(--art-scale, 1)));
    transform-origin: var(--art-pos-mobile, var(--art-pos, 50% 18%));
  }
}
@media (prefers-reduced-motion: reduce) { .sgs-seat__art img { transition: none; } }
</style>
