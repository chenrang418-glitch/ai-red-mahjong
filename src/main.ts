import { createApp } from 'vue'
import App from './App.vue'
import './styles/main.css'
import { gameAudio } from './composables/useGameAudio'
import { cleanupLegacyStorage } from './cleanupLegacyStorage'

cleanupLegacyStorage()

document.addEventListener('pointerdown', (event) => {
  const button = (event.target as Element | null)?.closest('button') as HTMLButtonElement | null
  if (button && !button.disabled) gameAudio.buttonFeedback()
})

createApp(App).mount('#app')
