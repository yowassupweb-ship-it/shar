import { useEffect, useState } from 'react'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

interface ToastMessage {
  id: string
  message: string
  type: ToastType
}

let toastIdCounter = 0
const toastListeners: ((message: ToastMessage) => void)[] = []

export const showToast = (message: string, type: ToastType = 'info') => {
  const toast: ToastMessage = {
    id: `toast-${toastIdCounter++}`,
    message,
    type,
  }
  toastListeners.forEach((listener) => listener(toast))
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  useEffect(() => {
    const listener = (toast: ToastMessage) => {
      setToasts((prev) => [...prev, toast])
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id))
      }, 3000)
    }

    toastListeners.push(listener)
    return () => {
      const index = toastListeners.indexOf(listener)
      if (index > -1) toastListeners.splice(index, 1)
    }
  }, [])

  const getToastStyles = (type: ToastType) => {
    switch (type) {
      case 'success':
        return 'bg-green-500 text-white'
      case 'error':
        return 'bg-red-500 text-white'
      case 'warning':
        return 'bg-yellow-500 text-[#1b1b2c]'
      case 'info':
      default:
        return 'bg-blue-500 text-white'
    }
  }

  const getIcon = (type: ToastType) => {
    switch (type) {
      case 'success':
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )
      case 'error':
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        )
      case 'warning':
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        )
      case 'info':
      default:
        return (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )
    }
  }

  return (
    // Top-center (not bottom-left) — this is now mounted app-wide, including the
    // mobile chat screen, where a bottom-left toast would collide with the
    // floating composer/keyboard. Top stays clear on every screen this renders
    // on, mobile or desktop.
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[250] flex flex-col gap-2 items-center px-4 w-full max-w-md"
      style={{ top: 'calc(var(--electron-titlebar-height, 0px) + env(safe-area-inset-top, 0px) + 12px)' }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg w-full animate-slide-in ${getToastStyles(toast.type)}`}
        >
          {getIcon(toast.type)}
          <p className="flex-1 font-medium">{toast.message}</p>
        </div>
      ))}
    </div>
  )
}
