/**
 * 合法立绘资源入口。当前仓库没有可确认授权的官方图片，因此先使用座位卡内的国风文字 fallback。
 * 后续只需把 WebP 放入本目录并在这里登记，不需要修改座位组件或角色数据。
 */
export const CHARACTER_PORTRAITS: Readonly<Record<string, string>> = {}

export function characterPortrait(characterId: string | null): string | null {
  return characterId ? CHARACTER_PORTRAITS[characterId] ?? null : null
}
