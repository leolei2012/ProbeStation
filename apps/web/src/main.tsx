import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { OperationNotifications } from './OperationNotifications'

createRoot(document.getElementById('root')!).render(<><App /><OperationNotifications /></>)
