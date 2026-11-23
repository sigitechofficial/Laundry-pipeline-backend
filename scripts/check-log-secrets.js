/**
 * Fails (exit 1) when application code logs credentials.
 *
 * Flags console.* calls whose arguments include, outside string literals:
 *  - a whole request body / cookies / headers   (req.body, req.cookies, req.headers)
 *  - a credential variable                      (password, OTP, accessToken, redisToken, …)
 *  - a whole user row                           (userFind, userData, … — rows carry the password hash)
 * unless the value is wrapped in redact(...) (utils/redact.js).
 *
 * A line may opt out with a trailing `// log-secrets-ok: <reason>` when it is
 * provably safe; reviewers should challenge every such comment.
 *
 *   npm run lint:log-secrets
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['controllers', 'services', 'middlewares', 'utils', 'helper', 'routes', 'redis', 'socket_io.js', 'laundary.js'];
const SKIP = /(^|\/)(node_modules|tests?)\/|\.test\.js$/;

const RULES = [
  { name: 'whole request body/cookies/headers', re: /\breq\.(?:body\b(?!\s*\.)|cookies\b|headers\b(?!\s*[.[]))/ },
  {
    name: 'credential value',
    re: /\b(?:password|confirmPassword|newPassword|oldPassword|hashpass|hashedPassword|passwordHash|otp|OTP|testOTP|accessToken|refreshToken|redisToken|redis_Validate|validateToken|clientSecret|client_secret)\b(?!\s*\.\s*length)/,
  },
  { name: 'whole user row', re: /\b(?:userFind|userfind|userData|socialUserFind|userExist|userfindByEmail)\b(?!\s*[.[])/ },
];

function listFiles(entry) {
  const abs = path.join(ROOT, entry);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return abs.endsWith('.js') ? [abs] : [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => {
    const rel = path.join(entry, d.name);
    if (SKIP.test(rel + (d.isDirectory() ? '/' : ''))) return [];
    return d.isDirectory() ? listFiles(rel) : d.name.endsWith('.js') ? [path.join(ROOT, rel)] : [];
  });
}

/** Remove string-literal text (keeping ${...} expressions of template literals) and comments. */
function codeOnly(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') break;
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
      out += q + q;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          let expr = '';
          while (i < src.length && depth) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth) expr += src[i];
            i++;
          }
          out += ` ${expr} `;
          continue;
        }
        i++;
      }
      out += '``';
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Code of the console.* call starting at line idx: raw lines are joined until the
 * call's parentheses balance, and strings are stripped from the JOINED text so
 * multi-line template literals are handled correctly.
 */
function callText(lines, idx, start) {
  let raw = lines[idx].slice(start);
  for (let i = idx; i < lines.length && i < idx + 60; i++) {
    if (i > idx) raw += '\n' + lines[i];
    const stripped = codeOnlyMultiline(raw);
    let depth = 0;
    for (const ch of stripped) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth <= 0) return stripped;
  }
  return codeOnlyMultiline(raw);
}

/** codeOnly over multi-line text: `//` comments end at the line break, not the text end. */
function codeOnlyMultiline(text) {
  // Strip strings/templates across lines first, then drop line comments per line.
  const noComments = text
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
  return codeOnly(noComments.replace(/\n/g, '\u0000')).replace(/\u0000/g, '\n');
}

/** Violations in one source text: [{ line, rule, text }]. */
function findViolationsInSource(source) {
  const found = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const m = /\bconsole\.(?:log|info|warn|error|debug|dir)\s*\(/.exec(line);
    if (!m || /^\s*\/\//.test(line) || line.includes('log-secrets-ok:')) return;
    const args = callText(lines, idx, m.index + m[0].length - 1);
    const unredacted = args.replace(/\bredact\s*\((?:[^()]|\([^()]*\))*\)/g, 'redact()');
    const rule = RULES.find((r) => r.re.test(unredacted));
    if (rule) found.push({ line: idx + 1, rule: rule.name, text: line.trim().slice(0, 120) });
  });
  return found;
}

function scan() {
  return DIRS.flatMap(listFiles).flatMap((file) =>
    findViolationsInSource(fs.readFileSync(file, 'utf8')).map(
      (v) => `${path.relative(ROOT, file)}:${v.line}  [${v.rule}]  ${v.text}`
    )
  );
}

if (require.main === module) {
  const violations = scan();
  if (violations.length) {
    console.error(`[log-secrets] ${violations.length} log statement(s) may write credentials:\n  ${violations.join('\n  ')}`);
    console.error('  Fix: remove the log, log specific safe fields, or wrap the value in redact() (utils/redact.js).');
    process.exitCode = 1;
  } else {
    console.log('[log-secrets] OK — no credential logging found.');
  }
}

module.exports = { scan, findViolationsInSource };
