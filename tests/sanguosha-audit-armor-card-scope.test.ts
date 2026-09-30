import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { locateOwnedCard, moveCard, setCardNature } from '@/sanguosha/engine/zones'
import { adjustDamageAmount } from '@/sanguosha/engine/equipment'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
function fixture(){
 const g=new SanguoshaGame({seed:'audit-qinggang-card-scope',setup:{mode:'identity',generalChoices:1,players:Array.from({length:5},(_,i)=>({id:`p${i}`,nickname:`玩家${i}`,isHuman:true}))}})
 const roles=['lord','rebel','loyalist','rebel','renegade'] as const;g.state.players.forEach((p,i)=>{p.characterId='zhangfei';p.identity=roles[i]});g.start();g.state.phase='play';g.state.currentPlayerId='p0'
 const take=(name:string,to:Parameters<typeof moveCard>[3])=>{const id=Object.keys(g.state.cards).find(id=>g.state.cards[id]!.name===name)!;expect(id).toBeDefined();const owner=g.state.players.find(p=>p.zones.hand.includes(id));const from=g.state.zones.drawPile.includes(id)?{kind:'drawPile' as const}:locateOwnedCard(g.state,owner!.id,id)!;moveCard(g.state,id,from,to);return id}
 take('青釭剑',{kind:'equipment',playerId:'p0',slot:'weapon'});take('白银狮子',{kind:'equipment',playerId:'p1',slot:'armor'});const slash=take('杀',{kind:'hand',playerId:'p0'});setCardNature(g.state,slash,'normal')
 const a=g.legalActions('p0').find(a=>a.kind==='use-card'&&a.cardIds.includes(slash)&&a.targetIds[0]==='p1')!;expect(a).toBeDefined();g.act('p0',a.id);expect(g.state.pendingRequests[0]?.kind).toBe('respond-card');assertGameInvariants(g.state);return {g,slash}
}
describe('青釭剑逐牌作用域不泄漏到嵌套伤害',()=>{
 it('穿甲只适用于当前杀，同源的无牌伤害和另一实体牌保留白银狮子',()=>{
  const {g,slash}=fixture();expect(adjustDamageAmount(g.state,'p0','p1',2,'normal','杀',slash)).toBe(2)
  expect(adjustDamageAmount(g.state,'p0','p1',2,'normal',null)).toBe(1)
  const other=g.state.zones.drawPile[0]!;expect(other).not.toBe(slash);expect(adjustDamageAmount(g.state,'p0','p1',2,'normal','决斗',other)).toBe(1)
 })
 it('实际杀等待闪期间，同源独立技能伤害只受一点，原杀仍可正常续接',()=>{
  const {g,slash}=fixture();const before=g.state.players[1]!.hp;const req=g.state.pendingRequests[0]!;g.damage({sourceId:'p0',targetId:'p1',amount:2,nature:'normal'})
  expect(g.state.players[1]!.hp).toBe(before-1);expect(g.state.pendingRequests[0]?.id).toBe(req.id);g.respond({requestId:req.id,playerId:req.playerId,payload:{actionId:'respond-pass'}})
  expect(g.state.players[1]!.hp).toBe(before-2);expect(g.state.cardResolution).toBeNull();expect(g.state.zones.discardPile).toContain(slash);assertGameInvariants(g.state)
 })
})
