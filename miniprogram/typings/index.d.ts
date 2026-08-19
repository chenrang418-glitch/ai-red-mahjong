// 先用宽松声明把工具链跑通；结构稳定后可以换成官方的 miniprogram-api-typings。
// ThisType<any> 是关键：Page/Component 里挂的自定义属性（比如牌桌页的 engine）
// 不写这个的话 this 只会认到字面量里的成员。
declare const wx: any

declare function App<T>(options: T & ThisType<any>): void
declare function Page<T>(options: T & ThisType<any>): void
declare function Component<T>(options: T & ThisType<any>): void
declare function getApp(): any
declare function getCurrentPages(): any[]

declare function setTimeout(handler: () => void, timeout?: number): number
declare function clearTimeout(id: number): void
declare function setInterval(handler: () => void, timeout?: number): number
declare function clearInterval(id: number): void

// 由 utils/polyfill.ts 在运行时补上
declare function structuredClone<T>(value: T): T

// Array.prototype.at 是 ES2022 才有的。这里不通过 tsconfig 的 lib 引入——
// 指定 lib 会让开发者工具内置的 TS 找不到基础类型，直接手写声明更稳。
// 运行时由 utils/polyfill.ts 负责。
interface Array<T> {
  at(index: number): T | undefined
}
interface ReadonlyArray<T> {
  at(index: number): T | undefined
}
