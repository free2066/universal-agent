/**
 * services/oauth/types.ts — OAuth service types
 */
export type OAuthState = 'idle' | 'pending' | 'authenticated' | 'expired' | 'error'
export type OAuthTokens = {
  access_token: string
  refresh_token?: string
  expires_at?: number
  token_type?: string
}
export type OAuthProvider = 'anthropic' | 'google' | 'github'
