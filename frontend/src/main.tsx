import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled fonts (no CDN): the UI is embedded in the binary and must render
// offline (spec Requirement 10).
// 600 for the live conversation's head title (mesa task 1069); 700 for
// everything else Orbitron titles.
import '@fontsource/orbitron/600.css'
import '@fontsource/orbitron/700.css'
import '@fontsource/share-tech-mono/400.css'
// Body face (mesa task 1566); 400/500/600 cover text, buttons and headings.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
// Icons-only Nerd Font: the PUA-glyph fallback layer for terminal panes.
import '@azurity/pure-nerd-font/pure-nerd-font.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
