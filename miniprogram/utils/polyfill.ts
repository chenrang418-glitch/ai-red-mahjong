// core/ 里的代码是从网页版原样搬过来的，用到了两个小程序环境没有的 API。
// 在这里补上，core/ 就能保持零改动，以后主项目更新了直接覆盖同步。

const scope = globalThis as unknown as Record<string, unknown>

if (typeof scope.structuredClone !== 'function') {
  // 牌局状态全是纯数据（对象、数组、字符串、数字），没有 Date/Map/Set，
  // 也没有循环引用，所以 JSON 这一趟就够，不用引整个深拷贝库。
  scope.structuredClone = function structuredClonePolyfill<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

if (typeof Array.prototype.at !== 'function') {
  // iOS 上是 JavaScriptCore，旧版本没有 Array.prototype.at
  Object.defineProperty(Array.prototype, 'at', {
    value: function at(this: unknown[], index: number) {
      const normalized = Math.trunc(index) || 0
      return this[normalized < 0 ? this.length + normalized : normalized]
    },
    writable: true,
    configurable: true,
  })
}
