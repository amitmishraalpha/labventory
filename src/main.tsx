import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import ProtectedApp from './auth/ProtectedApp'
import './styles.css'
import './auth/auth.css'
import './auth/user-management.css'
import './usage.css'
import './analytics.css'
import './admin-page.css'
import './admin-workspace.css'
import './app-shell.css'
import './mobile.css'
import { startTableLabels } from './lib/tableLabels'

startTableLabels()
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><AuthProvider><ProtectedApp /></AuthProvider></BrowserRouter></StrictMode>)
