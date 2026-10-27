'use strict';
/**
 * Konversi placeholder SQL portable `?` -> `$1..$n` (PostgreSQL).
 * Placeholder di dalam literal string ('...') atau identifier ("...") diabaikan agar
 * konversi tidak merusak SQL.
 */
function toPgPlaceholders(sql){
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length){
    const ch = sql[i];
    if (ch === "'"){
      // single-quoted literal (dengan escape '' )
      out += ch; i++;
      while (i < sql.length){
        out += sql[i];
        if (sql[i] === "'"){
          if (sql[i + 1] === "'"){ out += sql[++i]; i++; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"'){
      out += ch; i++;
      while (i < sql.length){
        out += sql[i];
        if (sql[i] === '"'){ i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '?'){ n++; out += '$' + n; i++; continue; }
    out += ch; i++;
  }
  return out;
}

/** Placeholder untuk SQLite: biarkan `?` apa adanya. */
function toSqlitePlaceholders(sql){ return sql; }

module.exports = { toPgPlaceholders, toSqlitePlaceholders };
