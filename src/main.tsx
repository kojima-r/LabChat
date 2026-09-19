import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// 起動の内訳を測る最初の点（起点はページ読み込み開始）
console.log(`[Boot +${(performance.now() / 1000).toFixed(2)}s] main.tsx 評価`)
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
