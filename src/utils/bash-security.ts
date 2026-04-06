/**
 * bash-security.ts - Extended Bash security validator
 *
 * Round 4: Supplements the existing soft-block checks in fs-tools.ts with
 * 8 additional safety checks mirroring claude-code's bashSecurity.ts.
 *
 * Checks implemented here (ID numbering matches claude-code for traceability):
 *   CHECK_2:  JQ system function injection          ($(...) inside jq -e)
 *   CHECK_6:  Dangerous variable assignment          ($IFS / $BASH_ENV / $ENV / $CDPATH overwrite)
 *   CHECK_8:  Dangerous command substitution nesting (depth > 2)
 *   CHECK_11: IFS injection                          (IFS= or IFS=: before command)
 *   CHECK_13: /proc/environ access                   (cat /proc/[pid]/environ extraction)
 *   CHECK_20: Zsh dangerous built-in commands        (zmodload, zpty, ztcp, zsocket)
 *   CHECK_21: Backslash-escaped shell operators      (backslash before ; | & escaping)
 *   CHECK_22: Comment-quote desync                   (hash inside unbalanced quoted string)
 *
 * Usage:
 *   import { checkExtendedBashSecurity, type BashSecurityViolation } from './bash-security.js';
 *   const violations = checkExtendedBashSecurity(command);
 *   if (violations.length > 0) { ... }
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BashSecurityViolation {
  /** Check ID (matches claude-code numbering) */
  id: number;
  /** Human-readable description of the violation */
  message: string;
  /** True for hard-block (deny), false for soft-block (warn/ask) */
  isHard: boolean;
}

// ── Check implementations ──────────────────────────────────────────────────────

/**
 * CHECK_2: JQ system function injection
 *
 * jq's `debug` and `env` builtins are safe, but `@sh`, `path()`, and the
 * `system()` function (in some builds) can execute arbitrary commands.
 * Also catches `$(...)` command substitution passed inside jq filters.
 */
function checkJqSystemFunction(cmd: string): BashSecurityViolation | null {
  // Match jq -e|--arg|-r|... followed by a filter containing $(...) or system()
  const jqPattern = /\bjq\s+[^|;&#\n]*['"][^'"]*\$\([^)]*\)[^'"]*['"]/i;
  const jqSystemPattern = /\bjq\s+[^|;&#\n]*['"][^'"]*\bsystem\s*\(/i;

  if (jqPattern.test(cmd) || jqSystemPattern.test(cmd)) {
    return {
      id: 2,
      message: 'Potential jq system function injection: command substitution inside jq filter',
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_6: Dangerous variable assignment
 *
 * Assigning to IFS, BASH_ENV, ENV, CDPATH, PROMPT_COMMAND, BASH_FUNCNAME
 * can redirect subsequent command execution.
 */
const DANGEROUS_VARS = new Set([
  'IFS', 'BASH_ENV', 'ENV', 'CDPATH', 'PROMPT_COMMAND',
  'BASH_FUNCNAME', 'BASH_COMMAND', 'PS1', 'PS2', 'PS3', 'PS4',
  'BASH_COMPAT', 'SHELLOPTS', 'BASHOPTS',
]);

function checkDangerousVariables(cmd: string): BashSecurityViolation | null {
  // Match VAR=... (assignment) but NOT VAR in $VAR or ${VAR}
  for (const varName of DANGEROUS_VARS) {
    // Matches: IFS=..., export IFS=..., IFS="" command
    const pattern = new RegExp(`(?:^|;|&&|\\|\\||\\s)(?:export\\s+)?${varName}\\s*=`, 'i');
    if (pattern.test(cmd)) {
      return {
        id: 6,
        message: `Dangerous shell variable assignment: ${varName}=... can redirect command execution`,
        isHard: false,
      };
    }
  }
  return null;
}

/**
 * CHECK_8: Dangerous command substitution nesting
 *
 * Deeply nested command substitution $($(...)) is a common obfuscation technique.
 * Flag depth > 2 as suspicious.
 */
function checkCommandSubstitutionNesting(cmd: string): BashSecurityViolation | null {
  // Count nesting depth of $( ... $( ... ) ...)
  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  let stringChar = '';
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];
    if (!inString && (ch === '"' || ch === "'")) {
      inString = true;
      stringChar = ch;
    } else if (inString && ch === stringChar && cmd[i - 1] !== '\\') {
      inString = false;
    } else if (!inString && ch === '$' && cmd[i + 1] === '(') {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      i++; // skip '('
    } else if (!inString && ch === ')') {
      if (depth > 0) depth--;
    }
    i++;
  }

  if (maxDepth > 2) {
    return {
      id: 8,
      message: `Command substitution nesting depth ${maxDepth} exceeds safe limit (2) - possible obfuscation`,
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_11: IFS injection
 *
 * Setting IFS before a command splits word boundaries differently.
 * IFS=: command  →  changes word splitting for that command
 * IFS=$'\n' command  →  common injection vector
 */
function checkIfsInjection(cmd: string): BashSecurityViolation | null {
  // IFS assignment before a command on same line: IFS=X cmd args
  const ifsPattern = /(?:^|\s|;)IFS\s*=\s*\S*\s+\w/;
  if (ifsPattern.test(cmd)) {
    return {
      id: 11,
      message: 'IFS injection: setting IFS before a command can alter word splitting behaviour',
      isHard: false,
    };
  }
  return null;
}

// CHECK_13: /proc/environ access
//
// Reading /proc/[pid]/environ or /proc/self/environ can leak environment variables
// including secrets, tokens, and credentials from other processes.
function checkProcEnviron(cmd: string): BashSecurityViolation | null {
  const procEnvPattern = /\/proc\/(?:\d+|self|\*)\/(environ|cmdline|mem|maps)/i;
  if (procEnvPattern.test(cmd)) {
    return {
      id: 13,
      message: '/proc/<pid>/environ access detected - can expose environment variables and secrets from other processes',
      isHard: true, // hard block: this is almost always malicious
    };
  }
  return null;
}

// CHECK_20: Zsh dangerous built-in commands
//
// These zsh-specific built-ins are particularly dangerous and rarely needed
// in legitimate scripts. Mirrors claude-code's ZSH_DANGEROUS_COMMANDS set.
const ZSH_DANGEROUS_COMMANDS = new Set([
  'zmodload',   // loads zsh modules - gateway to zsh/system, zsh/net/tcp, etc.
  'emulate',    // changes shell emulation mode - can bypass safety measures
  'zpty',       // pseudo-terminal - enables interactive process hijacking
  'ztcp',       // TCP connections - network exfiltration
  'zsocket',    // Unix sockets - IPC bypass
  'sysopen',    // file descriptor manipulation (zsh/system module)
  'sysread',    // direct fd read
  'syswrite',   // direct fd write
  'sysseek',    // fd seek
  'zf_rm',      // remove files (zsh/files module)
  'zf_mv',      // move files
  'zf_ln',      // hard link
  'zf_chmod',   // change permissions
  'zf_chown',   // change ownership
  'zf_mkdir',   // make directory
  'zf_symlink', // symbolic link
]);

function checkZshDangerousCommands(cmd: string): BashSecurityViolation | null {
  // Split on shell metacharacters and check each token
  const tokens = cmd.split(/[\s;|&(){}]/).filter(Boolean);
  for (const token of tokens) {
    const bare = token.replace(/^[\-]*/,'').replace(/\(.*/,''); // strip flags and args
    if (ZSH_DANGEROUS_COMMANDS.has(bare)) {
      return {
        id: 20,
        message: `Dangerous zsh built-in command: "${bare}" - can load modules that bypass shell safety measures`,
        isHard: true,
      };
    }
  }
  return null;
}

// CHECK_21: Backslash-escaped shell operators
//
// Backslash-escaping shell operators is a common obfuscation technique to
// bypass simple regex-based security checks.
// E.g.: "ls ; rm -rf /" disguised as backslash-escaped operator sequence.
function checkBackslashEscapedOperators(cmd: string): BashSecurityViolation | null {
  const patterns = [
    /\\;/, // \; (escaped semicolon)
    /\\\|/, // \| (escaped pipe)
    /\\&/, // \& (escaped ampersand)
    /\\`/, // \` (escaped backtick - old-style command substitution)
  ];
  for (const pattern of patterns) {
    if (pattern.test(cmd)) {
      return {
        id: 21,
        message: 'Backslash-escaped shell operator detected - possible obfuscation of command chaining',
        isHard: false,
      };
    }
  }
  return null;
}

// CHECK_22: Comment-quote desync
//
// A shell comment (#) after a quote that was never closed can cause the shell
// to interpret the "comment" as live code in certain parsing contexts.
function checkCommentQuoteDesync(cmd: string): BashSecurityViolation | null {
  // Look for patterns like: '...' # or "..." # followed by non-trivial content
  // More specifically: a hash inside an unbalanced quoted region
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      i += 2; // skip escaped char
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      // A hash outside quotes - that's a normal comment, fine
    } else if (ch === '#' && (inSingle || inDouble)) {
      // Hash inside a quoted string - check if there's code after the string closes
      const rest = cmd.slice(i);
      // If there are shell operators after a closing quote following this #, flag it
      if (/['"]\s*[;|&]/.test(rest)) {
        return {
          id: 22,
          message: 'Comment-quote desync detected: hash character inside quoted string may mask code injection',
          isHard: false,
        };
      }
    }
    i++;
  }

  // Unclosed quotes at end of command (typically an error, but flag it)
  if (inSingle || inDouble) {
    // Don't flag this - it's caught by shell syntax errors normally
  }

  return null;
}

// ── Main exported function ──────────────────────────────────────────────────────

/**
 * Run all extended security checks on a bash command string.
 * Returns an array of violations (empty = safe).
 *
 * @param command  The bash command string to check
 * @returns        Array of BashSecurityViolation (may be empty)
 */
export function checkExtendedBashSecurity(command: string): BashSecurityViolation[] {
  const violations: BashSecurityViolation[] = [];
  const checks = [
    checkJqSystemFunction,
    checkDangerousVariables,
    checkCommandSubstitutionNesting,
    checkIfsInjection,
    checkProcEnviron,
    checkZshDangerousCommands,
    checkBackslashEscapedOperators,
    checkCommentQuoteDesync,
  ];

  for (const check of checks) {
    const violation = check(command);
    if (violation) violations.push(violation);
  }

  return violations;
}

/**
 * Returns a formatted string describing all violations, suitable for
 * inclusion in tool error messages.
 */
export function formatBashSecurityViolations(violations: BashSecurityViolation[]): string {
  if (violations.length === 0) return '';
  return violations
    .map((v) => `[Security check #${v.id}${v.isHard ? ' (hard block)' : ''}] ${v.message}`)
    .join('\n');
}
