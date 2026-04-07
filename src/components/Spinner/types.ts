/**
 * components/Spinner/types.ts — Spinner component types
 */
export type SpinnerType = 'dots' | 'line' | 'arc' | 'circle'
export type SpinnerProps = {
  type?: SpinnerType
  label?: string
  color?: string
}
