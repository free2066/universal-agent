/**
 * bash-security.ts - Extended Bash security validator
 *
 * Round 4: Supplements the existing soft-block checks in fs-tools.ts with
 * 8 additional safety checks mirroring claude-code's bashSecurity.ts.
 *
 * Round 8: +5 additional checks for P1 security gaps (claude-code parity):
 *   CHECK_4:  Obfuscated flags via ANSI-C/locale quoting ($'...' / $"...")
 *   CHECK_15: Backslash-escaped whitespace (path traversal via command name parsing)
 *   CHECK_16: Brace expansion injection ({--flag,safe} form)
 *   CHECK_18: Unicode whitespace characters (parsing inconsistency attacks)
 *   CHECK_19: Mid-word hash character (shell-quote vs bash parse difference)
 *
 * Checks implemented here (ID numbering matches claude-code for traceability):
 *   CHECK_2:  JQ system function injection          ($(...) inside jq -e)
 *   CHECK_4:  Obfuscated flags                      ($'...', $"...", ""-flag, ''-flag)
 *   CHECK_6:  Dangerous variable assignment          ($IFS / $BASH_ENV / $ENV / $CDPATH overwrite)
 *   CHECK_8:  Dangerous command substitution nesting (depth > 2)
 *   CHECK_11: IFS injection                          (IFS= or IFS=: before command)
 *   CHECK_13: /proc/environ access                   (cat /proc/[pid]/environ extraction)
 *   CHECK_15: Backslash-escaped whitespace           (backslash before space/tab)
 *   CHECK_16: Brace expansion injection              ({a,b} and {n..m} forms)
 *   CHECK_18: Unicode whitespace                     (\u00A0 and similar non-standard whitespace)
 *   CHECK_19: Mid-word hash                          (# inside word causing shell-quote/bash divergence)
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

// ── Round 16: 10 additional security checks (claude-code full parity) ────────

/**
 * CHECK_1: INCOMPLETE_COMMANDS — 不完整命令（悬空操作符）
 * 风险：`cat /etc/passwd |` 分两次调用绕过检查，后半段绕过权限验证。
 */
function checkIncompleteCommands(cmd: string): BashSecurityViolation | null {
  const trimmed = cmd.trimEnd();
  // 以管道、逻辑运算符、分号结尾（允许行末 # 注释后无代码）
  if (/[|&;]\s*(?:#[^\n]*)?\s*$/.test(trimmed)) {
    return {
      id: 1,
      message: 'Command ends with incomplete operator (dangling pipe/&&/||/;) — command may be split across calls to bypass validation',
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_3: JQ_FILE_ARGUMENTS — jq --rawfile/--slurpfile/-f 危险参数
 * 风险：`jq -f /etc/passwd` 可将任意文件内容作为 jq 过滤器执行，读取敏感数据。
 */
function checkJqFileArguments(cmd: string): BashSecurityViolation | null {
  // -f <file>, --rawfile <var> <file>, --slurpfile <var> <file>, --fromfile <file>
  if (/\bjq\b[^|;&#\n]*(?:--rawfile|--slurpfile|--fromfile|-f)\s+(?!\s*-|\s*'[^']*'|\s*"[^"]*")/.test(cmd)) {
    return {
      id: 3,
      message: 'jq file argument (--rawfile/--slurpfile/-f) may read arbitrary files as filter programs',
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_5: SHELL_METACHARACTERS — 引号内嵌的 shell 元字符
 * 风险：`"arg;rm -rf /"` 在某些插值场景中 shell 不会将引号识别为保护。
 */
function checkShellMetacharacters(cmd: string): BashSecurityViolation | null {
  // 在双引号字符串内检测未转义的 ; & | （非 $(...) 内部的）
  const doubleQuotedPattern = /"[^"\\]*(?:\\.[^"\\]*)*"/g;
  let m: RegExpExecArray | null;
  while ((m = doubleQuotedPattern.exec(cmd)) !== null) {
    const content = m[0].slice(1, -1); // 去掉外层引号
    // 双引号内的 ; 或 & 或未转义的 | 是可疑的
    if (/(?<!\\)[;&|]/.test(content) && !/^\$\(/.test(content)) {
      return {
        id: 5,
        message: 'Shell metacharacters (;/&/|) found inside double-quoted string — potential injection in interpolated contexts',
        isHard: false,
      };
    }
  }
  return null;
}

/**
 * CHECK_7: NEWLINES — 命令内换行注入
 * 风险：`echo "foo\nrm -rf /"` 中嵌入 \n 会使 shell 在换行处开始新命令。
 */
function checkNewlineInjection(cmd: string): BashSecurityViolation | null {
  // 字面换行（\n 字符）嵌入命令主体（非行尾注释后的正常换行）
  // 检测在引号外的字面换行
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === '\n' && !inSingle && !inDouble) {
      // 换行出现在引号外 — 合法的多行命令，但检查换行后是否有实质内容
      const rest = cmd.slice(i + 1).trimStart();
      if (rest.length > 0 && !/^#/.test(rest)) {
        return {
          id: 7,
          message: 'Command contains embedded newline outside quotes — may execute additional commands on the new line',
          isHard: false,
        };
      }
    }
  }
  return null;
}

/**
 * CHECK_9: DANGEROUS_PATTERNS_INPUT_REDIRECTION — 危险输入重定向
 * 风险：`cmd < /etc/passwd`、`cmd <<< "$(evil)"` 等读取敏感文件或注入 here-string。
 */
function checkDangerousInputRedirection(cmd: string): BashSecurityViolation | null {
  // < /sensitive-path or <<< $(...) or <<EOF with command substitution
  if (/(?:^|[\s;|&])<\s*(?:\/etc\/|\/proc\/|\/sys\/|~\/\.ssh\/)/.test(cmd)) {
    return {
      id: 9,
      message: 'Dangerous input redirection from sensitive path (/etc/, /proc/, /sys/, ~/.ssh/)',
      isHard: true,
    };
  }
  if (/<<<\s*\$\(/.test(cmd)) {
    return {
      id: 9,
      message: 'Here-string with command substitution (<<<$(...)) may inject dangerous input',
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_10: DANGEROUS_PATTERNS_OUTPUT_REDIRECTION — 危险输出重定向
 * 风险：`cmd >> ~/.bashrc`、`cmd > /etc/crontab` 等向系统文件追加内容。
 */
function checkDangerousOutputRedirection(cmd: string): BashSecurityViolation | null {
  // >> or > to sensitive paths (profile files, cron, sudoers, etc.)
  const SENSITIVE_WRITE_TARGETS = [
    /~\/\.(?:bash|zsh|fish|profile|bashrc|bash_profile|bash_login|zshrc|zprofile|zlogin|config\/fish)/i,
    /\/etc\/(?:crontab|sudoers|passwd|shadow|hosts|ssh\/|profile|environment|rc\.|cron)/i,
    /\/var\/spool\/cron/i,
    /\/root\/\./i,
  ];
  for (const pattern of SENSITIVE_WRITE_TARGETS) {
    if (/(?:>>?|>\|)\s*/.test(cmd) && pattern.test(cmd)) {
      return {
        id: 10,
        message: `Dangerous output redirection to sensitive path detected (${pattern.source.split('/')[1]})`,
        isHard: true,
      };
    }
  }
  return null;
}

/**
 * CHECK_12: GIT_COMMIT_SUBSTITUTION — git commit -m 中的命令替换
 * 风险：`git commit -m "$(evil_command)"` — commit message 中的 $() 会被执行。
 * 正常 git commit 不需要 command substitution in the message。
 */
function checkGitCommitSubstitution(cmd: string): BashSecurityViolation | null {
  // git commit ... -m "..." 或 -m '...' 中含有 $(...) 或 `...`
  if (/\bgit\s+commit\b/.test(cmd)) {
    const msgMatch = cmd.match(/-m\s*(?:"([^"]+)"|'([^']+)')/);
    if (msgMatch) {
      const msg = msgMatch[1] ?? msgMatch[2] ?? '';
      if (/\$\(/.test(msg) || /`[^`]+`/.test(msg)) {
        return {
          id: 12,
          message: 'git commit -m message contains command substitution ($(...) or backticks) which will be executed',
          isHard: false,
        };
      }
    }
    // 未引号保护的 -m 后跟命令替换
    if (/-m\s+\$\(/.test(cmd) || /-m\s+`/.test(cmd)) {
      return {
        id: 12,
        message: 'git commit -m followed by unquoted command substitution',
        isHard: false,
      };
    }
  }
  return null;
}

/**
 * CHECK_14: MALFORMED_TOKEN_INJECTION — 畸形 token 注入（shell-quote vs bash 解析差异）
 * 风险：`$'\x2d\x2d\x75\x70\x6c\x6f\x61\x64\x2dpack'` 等十六进制转义绕过。
 * 此检查与 CHECK_4 互补：CHECK_4 检测引号包裹的 $'...'，CHECK_14 检测十六进制/八进制字符。
 */
function checkMalformedTokenInjection(cmd: string): BashSecurityViolation | null {
  // $'\xNN' 十六进制转义（在 ANSI-C 引号外）
  if (/\$'\\.{0,3}\\x[0-9a-fA-F]{2}/.test(cmd)) {
    return {
      id: 14,
      message: "ANSI-C hex escape ($'\\xNN') detected — can encode arbitrary characters to bypass flag blacklists",
      isHard: false,
    };
  }
  // $'\NNN' 八进制转义
  if (/\$'\\[0-7]{3}/.test(cmd)) {
    return {
      id: 14,
      message: "ANSI-C octal escape ($'\\NNN') detected — can encode arbitrary characters",
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_17: CONTROL_CHARACTERS — 不可见控制字符注入
 * 风险：ASCII 控制字符（\x01-\x08, \x0b-\x0c, \x0e-\x1f）嵌入命令，
 * 终端可能将其解释为特殊序列（如 \x08=backspace 可删除前面的字符）。
 */
function checkControlCharacters(cmd: string): BashSecurityViolation | null {
  // 排除 \t（\x09）、\n（\x0a）、\r（\x0d）— 这些是合法空白
  // eslint-disable-next-line no-control-regex
  if (/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(cmd)) {
    return {
      id: 17,
      message: 'Command contains non-printable control characters (\\x01-\\x1F) that may be interpreted as terminal control sequences',
      isHard: true,
    };
  }
  return null;
}

/**
 * CHECK_23: QUOTED_NEWLINE — 引号内换行
 * 风险：`"foo
 * bar"` — 某些 shell/环境中引号内换行会导致多行命令继续，
 * 可能在 heredoc 或 eval 场景中执行注入内容。
 */
function checkQuotedNewline(cmd: string): BashSecurityViolation | null {
  // 在双引号内检测字面换行字符（不是 \n 转义序列，而是真正的 \n）
  const doubleQuoteNewline = /"[^"]*\n[^"]*"/;
  const singleQuoteNewline = /'[^']*\n[^']*'/;
  if (doubleQuoteNewline.test(cmd) || singleQuoteNewline.test(cmd)) {
    return {
      id: 23,
      message: 'Literal newline inside quoted string — may enable multi-line injection in eval/heredoc contexts',
      isHard: false,
    };
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

// ── Round 8: 5 additional security checks (claude-code parity) ───────────────

/**
 * CHECK_4: Obfuscated flags via ANSI-C quoting / locale quoting / empty-quote concat
 * (Round 8: claude-code validateObfuscatedFlags parity)
 *
 * Threat: $'\x2d' encodes '-' as ANSI-C escape, $"..." uses locale quoting,
 * ""-exec or ''-exec concatenates empty string to hide flag name.
 * These techniques bypass blacklists that inspect flag names directly.
 */
function checkObfuscatedFlags(cmd: string): BashSecurityViolation | null {
  // ANSI-C quoting: $'...' — can encode any character including -
  if (/\$'[^']*'/.test(cmd)) {
    return {
      id: 4,
      message: "Command contains ANSI-C quoting ($'...') which can hide characters and bypass flag blacklists",
      isHard: false,
    };
  }
  // Locale quoting: $"..." — locale-dependent character encoding
  if (/\$"[^"]*"/.test(cmd)) {
    return {
      id: 4,
      message: 'Command contains locale quoting ($"...") which can encode characters to bypass checks',
      isHard: false,
    };
  }
  // Empty-quote flag concatenation: ""-exec, ''-exec, ""-f, ''-f
  // Matches: ("" or '') immediately followed by optional spaces then a dash
  if (/(?:''|"")[\s]*-/.test(cmd)) {
    return {
      id: 4,
      message: 'Command contains empty-quote flag concatenation (""-flag) which can hide flag names',
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_15: Backslash-escaped whitespace (path traversal via command-name parsing)
 * (Round 8: claude-code validateBackslashEscapedWhitespace parity)
 *
 * Threat: `echo\ test/../../../usr/bin/touch /tmp/file` — bash treats "echo test"
 * as a single token (command name) due to backslash-space, while shell-quote
 * may split it differently, enabling directory traversal via command resolution.
 */
function checkBackslashEscapedWhitespace(cmd: string): BashSecurityViolation | null {
  // Detect backslash followed by space or tab (not inside single-quoted strings)
  if (/\\ /.test(cmd) || /\\\t/.test(cmd)) {
    return {
      id: 15,
      message: 'Command contains backslash-escaped whitespace (\\ space or \\tab) that could alter command parsing and enable path traversal',
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_16: Brace expansion injection
 * (Round 8: claude-code validateBraceExpansion parity)
 *
 * Threat: `git ls-remote {--upload-pack="touch /tmp/test",test}` — shell-quote
 * treats braces as literal, but bash expands them to inject dangerous flags.
 * Also catches {1..5} sequence expansion used for loop-based attacks.
 */
function checkBraceExpansion(cmd: string): BashSecurityViolation | null {
  // {a,b} form — comma-separated brace expansion
  if (/\{[^{}]*,[^{}]*\}/.test(cmd)) {
    return {
      id: 16,
      message: 'Command contains brace expansion {a,b} which could inject flags or arguments invisible to shell-quote analysis',
      isHard: false,
    };
  }
  // {n..m} form — sequence expansion
  if (/\{[^{}]*\.\.[^{}]*\}/.test(cmd)) {
    return {
      id: 16,
      message: 'Command contains brace sequence expansion {n..m} which could enable loop-based attacks',
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_18: Unicode whitespace characters
 * (Round 8: claude-code validateUnicodeWhitespace parity)
 *
 * Threat: Non-standard Unicode whitespace (e.g. \u00A0 non-breaking space,
 * \u2028 line separator) is treated as a word separator by shell-quote but
 * as a literal character by bash, causing parsing inconsistencies.
 */
const UNICODE_WS_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

function checkUnicodeWhitespace(cmd: string): BashSecurityViolation | null {
  if (UNICODE_WS_RE.test(cmd)) {
    return {
      id: 18,
      message: 'Command contains Unicode whitespace characters that could cause shell-quote vs bash parsing inconsistencies',
      isHard: false,
    };
  }
  return null;
}

/**
 * CHECK_19: Mid-word hash character
 * (Round 8: claude-code validateMidWordHash parity)
 *
 * Threat: shell-quote treats `#` as start of a comment, but bash treats
 * it as a literal character when not at word boundary.
 * Example: `curl http://host:8080#fragment` — shell-quote may truncate URL.
 * This divergence can cause the validator to see a different command than bash executes.
 */
function checkMidWordHash(cmd: string): BashSecurityViolation | null {
  // Detect non-whitespace followed by # not at the start of the string
  // Exclude ${...} variable expansions where # is length operator
  // and #!/ shebang patterns
  if (/\S#/.test(cmd) && !/^\s*#/.test(cmd) && !/\$\{[^}]*#/.test(cmd)) {
    return {
      id: 19,
      message: 'Command contains mid-word # character which is parsed differently by shell-quote vs bash (e.g. in URLs)',
      isHard: false,
    };
  }
  return null;
}

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
    checkIncompleteCommands,          // CHECK_1  (Round 16: new)
    checkJqSystemFunction,
    checkJqFileArguments,             // CHECK_3  (Round 16: new)
    checkObfuscatedFlags,             // CHECK_4  (Round 8)
    checkShellMetacharacters,         // CHECK_5  (Round 16: new)
    checkDangerousVariables,
    checkNewlineInjection,            // CHECK_7  (Round 16: new)
    checkCommandSubstitutionNesting,
    checkDangerousInputRedirection,   // CHECK_9  (Round 16: new)
    checkDangerousOutputRedirection,  // CHECK_10 (Round 16: new)
    checkIfsInjection,
    checkGitCommitSubstitution,       // CHECK_12 (Round 16: new)
    checkProcEnviron,
    checkMalformedTokenInjection,     // CHECK_14 (Round 16: new)
    checkBackslashEscapedWhitespace,  // CHECK_15 (Round 8)
    checkBraceExpansion,              // CHECK_16 (Round 8)
    checkControlCharacters,           // CHECK_17 (Round 16: new)
    checkUnicodeWhitespace,           // CHECK_18 (Round 8)
    checkMidWordHash,                 // CHECK_19 (Round 8)
    checkZshDangerousCommands,
    checkBackslashEscapedOperators,
    checkCommentQuoteDesync,
    checkQuotedNewline,               // CHECK_23 (Round 16: new)
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

// ── B16: Environment variable stripping + wrapper stripping ─────────────────
//
// 对标 claude-code/src/tools/BashTool/bashPermissions.ts
// stripAllLeadingEnvVars + BINARY_HIJACK_VARS + stripSafeWrappers
//
// 风险场景: `LD_PRELOAD=/malicious.so denied_cmd` — 前缀 env var 绕过 deny 规则
// wrapper 场景: `timeout 30 denied_cmd` — wrapper 包裹后 deny 规则无法匹配

/**
 * B16: BINARY_HIJACK_VARS — 可劫持二进制执行路径的环境变量前缀
 * LD_XXX/DYLD_XXX: 动态链接器注入（Linux/macOS）
 * PATH=: 劫持命令查找路径
 * PYTHONPATH/NODE_PATH/PERL5LIB: 语言运行时劫持
 */
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH=|PYTHONPATH=|NODE_PATH=|PERL5LIB=|RUBY_LIB=|RUBYLIB=|GOPATH=)/;

/**
 * B16: stripAllLeadingEnvVars — 剥离命令开头的所有环境变量赋值
 *
 * 例：`FOO=bar BAZ=qux cmd arg` → `cmd arg`
 *     `export FOO=bar cmd arg` → `cmd arg`
 *     `LD_PRELOAD=/x.so rm -rf /` → `rm -rf /`
 *
 * @param command  原始命令字符串
 * @param onBinaryHijack  可选回调，当检测到二进制劫持变量时触发
 */
export function stripAllLeadingEnvVars(
  command: string,
  onBinaryHijack?: (varName: string) => void,
): string {
  let remaining = command.trim();

  // 剥离 `export VAR=value` 前缀
  while (/^export\s+\w/.test(remaining)) {
    const m = remaining.match(/^export\s+(\w+=\S*)\s*/);
    if (!m) break;
    const varAssign = m[1]!;
    if (onBinaryHijack && BINARY_HIJACK_VARS.test(varAssign)) {
      onBinaryHijack(varAssign.split('=')[0]!);
    }
    remaining = remaining.slice(m[0]!.length);
  }

  // 剥离 `VAR=value` 前缀（可能多个）
  let matched = true;
  while (matched) {
    matched = false;
    const m = remaining.match(/^(\w+=(?:[^\s"'\\]|"[^"]*"|'[^']*'|\\.)*)\s+/);
    if (m) {
      const varAssign = m[1]!;
      if (onBinaryHijack && BINARY_HIJACK_VARS.test(varAssign)) {
        onBinaryHijack(varAssign.split('=')[0]!);
      }
      remaining = remaining.slice(m[0]!.length);
      matched = true;
    }
  }

  return remaining;
}

/**
 * B16: SAFE_WRAPPERS — 安全的命令包装器列表
 * 这些包装器不改变命令语义，应被剥离以匹配 deny 规则。
 */
const SAFE_WRAPPER_PATTERN = /^(?:timeout\s+\d+(?:\.\d+)?[smhd]?\s+|nice\s+(?:-n\s+[-\d]+\s+)?|nohup\s+|stdbuf\s+(?:-[oei][LU\d]+\s+)*|setsid\s+|ionice\s+(?:-c\s+\d+\s+)?(?:-n\s+\d+\s+)?|taskset\s+(?:\S+\s+)?|env\s+(?:-\w+\s+)*(?:\w+=\S+\s+)*)(.+)/s;

/**
 * B16: stripSafeWrappers — 剥离 timeout/nice/nohup/stdbuf 等安全包装器
 *
 * 例：`timeout 30 denied_cmd` → `denied_cmd`
 *     `nice -n 10 nohup denied_cmd` → `denied_cmd`（多层剥离）
 */
export function stripSafeWrappers(command: string): string {
  let remaining = command.trim();
  let stripped = true;
  let iterations = 0;
  const MAX_ITERATIONS = 5; // 防止无限循环

  while (stripped && iterations < MAX_ITERATIONS) {
    stripped = false;
    const m = remaining.match(SAFE_WRAPPER_PATTERN);
    if (m && m[1] && m[1] !== remaining) {
      remaining = m[1].trim();
      stripped = true;
    }
    iterations++;
  }

  return remaining;
}

/**
 * B16: normalizeCommandForPermissionCheck — 权限规则匹配前的命令规范化
 *
 * 对标 claude-code bashPermissions.ts 中在规则匹配前调用的规范化流程：
 *   1. 剥离前置 env vars（含二进制劫持检测）
 *   2. 剥离安全包装器（timeout/nice/nohup 等）
 *
 * @param command  原始 bash 命令
 * @param onBinaryHijack  检测到二进制劫持变量时的回调
 * @returns  规范化后用于规则匹配的命令
 */
export function normalizeCommandForPermissionCheck(
  command: string,
  onBinaryHijack?: (varName: string) => void,
): string {
  const stripped = stripAllLeadingEnvVars(command, onBinaryHijack);
  return stripSafeWrappers(stripped);
}
