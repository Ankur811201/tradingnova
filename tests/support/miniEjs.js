'use strict';
/**
 * Minimal, faithful EJS-subset compiler (no dependencies) used ONLY because
 * this sandbox has no network access to install the real `ejs` package
 * (confirmed: npm install returns 403 for every package, no local cache).
 *
 * Supports exactly the tag forms bot-detail.ejs uses:
 *   <%  ...js...  %>   scriptlet (control flow)
 *   <%= expr %>        HTML-escaped output
 *   <%- expr %>        raw output
 *   <%# ... %>         comment (stripped)
 *
 * This is a real transpile-to-JS-then-execute, not a mock: it will throw a
 * real SyntaxError / ReferenceError if the template is malformed or
 * references an undefined variable in a way real EJS would also reject.
 */
function compile(template) {
  let src = 'let __out = [];\n' +
    'function __esc(v){ if (v==null) return ""; return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }\n' +
    'with(__locals){\n';

  let cursor = 0;
  const tagRe = /<%([-=#]?)([\s\S]*?)%>/g;
  let match;
  while ((match = tagRe.exec(template))) {
    const plain = template.slice(cursor, match.index);
    if (plain) src += `__out.push(${JSON.stringify(plain)});\n`;

    const [, type, codeRaw] = match;
    const code = codeRaw.trim();
    if (type === '#') {
      // comment, skip
    } else if (type === '=') {
      src += `__out.push(__esc(${code}));\n`;
    } else if (type === '-') {
      src += `__out.push((${code}) == null ? "" : (${code}));\n`;
    } else {
      src += `${code}\n`;
    }
    cursor = tagRe.lastIndex;
  }
  const tail = template.slice(cursor);
  if (tail) src += `__out.push(${JSON.stringify(tail)});\n`;
  src += '}\nreturn __out.join("");';

  // eslint-disable-next-line no-new-func
  const fn = new Function('__locals', src);
  return (locals) => fn(locals);
}

module.exports = { compile };
