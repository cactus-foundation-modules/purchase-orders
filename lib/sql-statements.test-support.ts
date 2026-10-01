// Splitting a migration file into statements, for the live suites that run
// this module's SQL against a real Postgres one statement at a time.

/** Split a migration file into statements, dollar-quote aware: core's init does
 *  use `DO $$ ... $$`, and a splitter that is not would cut one in half. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let current = ''
  let at = 0
  while (at < sql.length) {
    const rest = sql.slice(at)
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', at)
      at = end === -1 ? sql.length : end + 1
      continue
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', at + 2)
      at = end === -1 ? sql.length : end + 2
      continue
    }
    const char = sql[at]!
    if (char === "'" || char === '"') {
      const end = closingQuote(sql, at, char)
      current += sql.slice(at, end)
      at = end
      continue
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest)
    if (dollar) {
      const tag = dollar[0]
      const end = sql.indexOf(tag, at + tag.length)
      const stop = end === -1 ? sql.length : end + tag.length
      current += sql.slice(at, stop)
      at = stop
      continue
    }
    if (char === ';') {
      if (current.trim()) out.push(current.trim())
      current = ''
      at++
      continue
    }
    current += char
    at++
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** Where a quoted run ends, doubled quotes ('' and "") counting as escapes. */
function closingQuote(sql: string, start: number, quote: string): number {
  let at = start + 1
  while (at < sql.length) {
    if (sql[at] === quote) {
      if (sql[at + 1] === quote) {
        at += 2
        continue
      }
      return at + 1
    }
    at++
  }
  return sql.length
}
