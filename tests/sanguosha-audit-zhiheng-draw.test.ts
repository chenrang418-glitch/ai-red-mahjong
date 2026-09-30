import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
function fixture() {
 const game=new SanguoshaGame({seed:'audit-zhiheng-draw',setup:{mode:'identity',generalChoices:1,players:Array.from({length:5},(_,i)=>({id:`p${i}`,nickname:`玩家${i}`,isHuman:true}))}})
 const identities=['lord','rebel','loyalist','rebel','renegade'] as const
 game.state.players.forEach((p,i)=>{p.characterId=i===0?'sunquan':'zhangfei';p.identity=identities[i]})
 game.start();game.state.phase='play';game.state.currentPlayerId='p0';game.state.normalTurnPlayerId='p0'
 const cards=game.state.players[0]!.zones.hand.slice(0,2)
 const action=game.legalActions('p0').find(a=>a.kind==='invoke-skill'&&a.skillId==='zhiheng')!;expect(action).toBeDefined();game.act('p0',action.id)
 const run=()=>{const r=game.state.pendingRequests[0]!;game.respond({requestId:r.id,playerId:r.playerId,payload:{cardIds:cards}})}
 return {game,cards,run}
}
describe('制衡公共摸牌审计',()=>{
 it('丢弃数量决定一次批量摸牌，发出替代窗口、牌移动与isDraw',()=>{
  const {game,cards,run}=fixture();const top=game.state.zones.drawPile.slice(0,2);const order:string[]=[]
  game.events.on('DrawAttempt',ctx=>{expect(ctx.event.payload).toMatchObject({playerId:'p0',count:2,isDraw:true});order.push('attempt')})
  game.events.on('CardZoneMoved',ctx=>{if(top.includes(ctx.event.payload.cardId as string))order.push('move')})
  game.events.on('GainCard',ctx=>{expect(ctx.event.payload).toMatchObject({playerId:'p0',cardIds:top,isDraw:true,reason:'制衡'});expect(ctx.event.targetId).toBe('p0');order.push('gain')})
  run();expect(order).toEqual(['attempt','move','move','gain']);expect(game.state.players[0]!.zones.hand).toEqual(expect.arrayContaining(top));for(const id of cards)expect(game.state.zones.discardPile).toContain(id);assertGameInvariants(game.state)
 })
 it('空牌堆时重洗包含实际弃置牌，不少摸或丢牌',()=>{
  const {game,run}=fixture();for(const id of [...game.state.zones.drawPile])moveCard(game.state,id,{kind:'drawPile'},{kind:'hand',playerId:'p4'})
  let reshuffles=0;game.events.on('DeckReshuffled',()=>{reshuffles++});const before=game.state.players[0]!.zones.hand.length;run();expect(reshuffles).toBe(1);expect(game.state.players[0]!.zones.hand).toHaveLength(before);assertGameInvariants(game.state)
 })
 it('替代拒绝经过保存恢复，弃牌及阶段限次只提交一次',()=>{
  const {game,cards,run}=fixture();game.state.players[0]!.grantedSkills.push('zanrun-sunhong:b61');const before=game.state.players[0]!.zones.hand.length
  run();expect(game.state.skillResolution?.skillId).toBe('zanrun-sunhong:b61');const restored=SanguoshaGame.restore(game.serialize());const r=restored.state.pendingRequests[0]!;restored.respond({requestId:r.id,playerId:r.playerId,payload:{optionId:'no'}})
  expect(restored.state.pendingRequests).toHaveLength(0);expect(restored.state.players[0]!.zones.hand).toHaveLength(before);for(const id of cards)expect(restored.state.zones.discardPile.filter(c=>c===id)).toHaveLength(1)
  expect(restored.legalActions('p0').some(a=>a.kind==='invoke-skill'&&a.skillId==='zhiheng')).toBe(false);assertGameInvariants(restored.state)
 })
})
