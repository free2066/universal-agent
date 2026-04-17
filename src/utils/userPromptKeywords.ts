/**
 * Checks if input matches negative keyword patterns
 */

// Pre-compile regex patterns at module level for better performance
const NEGATIVE_PATTERN =
  /\b(wtf|wth|ffs|omfg|shit(ty|tiest)?|dumbass|horrible|awful|piss(ed|ing)? off|piece of (shit|crap|junk)|what the (fuck|hell)|fucking? (broken|useless|terrible|awful|horrible)|fuck you|screw (this|you)|so frustrating|this sucks|damn it)\b/

const KEEP_GOING_PATTERN = /\b(keep going|go on)\b/

export function matchesNegativeKeyword(input: string): boolean {
  return NEGATIVE_PATTERN.test(input.toLowerCase())
}

/**
 * Checks if input matches keep going/continuation patterns
 */
export function matchesKeepGoingKeyword(input: string): boolean {
  const lowerInput = input.toLowerCase().trim()

  // Match "continue" only if it's the entire prompt
  if (lowerInput === 'continue') {
    return true
  }

  // Match "keep going" or "go on" anywhere in the input
  return KEEP_GOING_PATTERN.test(lowerInput)
}
