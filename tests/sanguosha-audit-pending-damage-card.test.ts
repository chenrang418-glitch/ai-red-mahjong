import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { locateOwnedCard, moveCard, setCardNature } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
function fixture(kind:'aoe'|'slash'){
 const g=new SanguoshaGame({seed:`audit-pending-damage-${kind}`,setup:{mode:'identity',generalChoices:1,players:Array.from({length:5},(_,i)=>({id:`p${i}`,nickname:`玩家${i}`,isHuman:true}))}})
 const identities=['lord','rebel','loyalist','rebel','renegade'] as const;g.state.players.forEach((p,i)=>{p.identity=identities[i];p.characterId=(kind==='aoe'?i===1:i===0)?'luotong':'zhangfei'});g.start();g.state.phase='play';g.state.currentPlayerId='p0';g.state.normalTurnPlayerId='p0'
 const name=kind==='aoe'?'南蛮入侵':'杀';const id=Object.keys(g.state.cards).find(id=>g.state.cards[id]!.name===name)!;const holder=g.state.players.find(p=>p.zones.hand.includes(id));moveCard(g.state,id,g.state.zones.drawPile.includes(id)?{kind:'drawPile'}:locateOwnedCard(g.state,holder!.id,id)!,{kind:'hand',playerId:'p0'});if(kind==='slash')setCardNature(g.state,id,'normal')
 const action=g.legalActions('p0').find(a=>a.kind==='use-card'&&a.cardIds.includes(id)&&a.targetIds[0]==='p1')!;expect(action).toBeDefined();g.act('p0',action.id)
 let guard=0;while(g.state.pendingRequests[0]?.kind==='respond-card'){
 const r=g.state.pendingRequests[0]!;if(r.kind!=='respond-card')break;if(guard++>20)throw new Error('没有到达进谏窗口');g.respond({requestId:r.id,playerId:r.playerId,payload:{actionId:'respond-pass'}});if(g.state.pendingTargetDamage||g.state.pendingSourceDamage)break
 }
 return {g,id}
}
describe('公共伤害交互不会提前推进牌目标或阻塞发问',()=>{
 for(const choice of ['yes','no'])it(`南蛮伤害在进谏${choice}决定前保持首目标，回答后续接下一目标`,()=>{
 const {g,id}=fixture('aoe');expect(g.state.pendingTargetDamage?.skillId).toBe('jinjian');expect(g.state.cardResolution?.kind).toBe('trick');if(g.state.cardResolution?.kind==='trick')expect(g.state.cardResolution.targetIndex).toBe(0)
 const r=g.state.pendingRequests[0]!;expect(r?.kind).toBe('choose-option');expect(g.state.skillResolution?.skillId).toBe('jinjian');const before=g.state.players[1]!.hp;g.respond({requestId:r.id,playerId:r.playerId,payload:{optionId:choice}})
 expect(g.state.players[1]!.hp).toBe(before-(choice==='yes'?0:1));expect(g.state.pendingTargetDamage).toBeUndefined();expect(g.state.cardResolution?.kind).toBe('trick');if(g.state.cardResolution?.kind==='trick')expect(g.state.cardResolution.targetIndex).toBe(1)
 let steps=0;while(g.state.pendingRequests.length){if(steps++>30)throw new Error('后续目标不收敛');const next=g.state.pendingRequests[0]!;expect(next.kind).toBe('respond-card');g.respond({requestId:next.id,playerId:next.playerId,payload:{actionId:'respond-pass'}})}expect(g.state.cardResolution).toBeNull();expect(g.state.zones.discardPile).toContain(id);assertGameInvariants(g.state)
 })
 for(const choice of ['yes','no'])it(`杀来源进谏${choice}决定前牌仍处理中，实际伤害只结算一次`,()=>{
 const {g,id}=fixture('slash');expect(g.state.pendingSourceDamage?.skillId).toBe('jinjian');expect(g.state.cardResolution?.kind).toBe('slash');expect(g.state.zones.processingArea).toContain(id);const r=g.state.pendingRequests[0]!;expect(r?.kind).toBe('choose-option');const before=g.state.players[1]!.hp;g.respond({requestId:r.id,playerId:r.playerId,payload:{optionId:choice}});expect(g.state.players[1]!.hp).toBe(before-(choice==='yes'?2:1));expect(g.state.cardResolution).toBeNull();expect(g.state.pendingSourceDamage).toBeUndefined();expect(g.state.zones.discardPile.filter(c=>c===id)).toHaveLength(1);assertGameInvariants(g.state)
 })
})
