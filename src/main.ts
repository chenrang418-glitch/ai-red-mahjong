import { createApp } from 'vue'
import RootApp from './RootApp.vue'
import './styles/root.css'
import { gameAudio } from './composables/useGameAudio'
import { cleanupLegacyStorage } from './cleanupLegacyStorage'

cleanupLegacyStorage()

document.addEventListener('pointerdown', (event) => {
  const button = (event.target as Element | null)?.closest('button') as HTMLButtonElement | null
  if (button && !button.disabled) gameAudio.buttonFeedback()
})

function renderBootFailure(): void {
  const root = document.querySelector<HTMLElement>('#app')
  if (!root) return
  root.replaceChildren()
  const main = document.createElement('main')
  main.className = 'root-error'
  const section = document.createElement('section')
  section.setAttribute('role', 'alert')
  const mark = document.createElement('span')
  mark.textContent = 'CR'
  const title = document.createElement('h1')
  title.textContent = '游戏启动失败'
  const copy = document.createElement('p')
  copy.textContent = '页面没有正常启动，请重新加载；如果问题持续，可先返回游戏中心。'
  const actions = document.createElement('div')
  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = '重新加载'
  reload.addEventListener('click', () => window.location.reload())
  const portal = document.createElement('button')
  portal.type = 'button'
  portal.textContent = '返回游戏中心'
  portal.addEventListener('click', () => { window.location.href = '/' })
  actions.append(reload, portal)
  section.append(mark, title, copy, actions)
  main.append(section)
  root.append(main)
}

try {
  const app = createApp(RootApp)
  app.config.errorHandler = () => renderBootFailure()
  app.mount('#app')
} catch {
  renderBootFailure()
}
