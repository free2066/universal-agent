/**
 * keybindings/types.ts — Keyboard shortcut types
 */
export type KeyBinding = {
  key: string
  action: string
  description?: string
}
export type KeyBindingMap = Record<string, KeyBinding>
export type ConfigurableShortcut = {
  id: string
  description: string
  defaultKey: string
}
