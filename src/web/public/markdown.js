// Tiny markdown renderer shared by the web UI and saved reports: tables, headings, lists, "> " notes, **bold**, _italic_, `code`.
// A classic script (globals md / esc) so the page can load it with <script src> and Node can run it in a vm context.
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function md(src) {
  const lines = String(src || '').split('\n');
  const out = [];
  let i = 0;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)_(.+?)_(?=\s|$|[.,;:])/g, '$1<i>$2</i>').replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(high)\]/g, '<span class="sev-high">[high]</span>').replace(/\[(medium)\]/g, '<span class="sev-medium">[medium]</span>').replace(/\[(low)\]/g, '<span class="sev-low">[low]</span>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(`<table><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    let m;
    if (/^> /.test(l)) {
      // quote block: one highlighted note
      const q = [];
      while (i < lines.length && /^> ?/.test(lines[i]) && lines[i].trim()) q.push(inline(lines[i++].replace(/^> ?/, '')));
      out.push(`<div class="note">${q.join('<br>')}</div>`);
      continue;
    }
    if ((m = l.match(/^(#{1,3}) (.*)/))) out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    else if (/^\s*[-*] /.test(l)) { const items = []; while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*] /, ''))}</li>`); out.push(`<ul>${items.join('')}</ul>`); continue; }
    else if (/^\d+\. /.test(l)) {
      const items = [];
      while (i < lines.length && (/^\d+\. /.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^\d+\. /.test(lines[i])) items.push(inline(lines[i].replace(/^\d+\. /, '')));
        else items[items.length - 1] += '<br>' + inline(lines[i].trim().replace(/^- /, '• '));
        i++;
      }
      out.push(`<ol>${items.map((x) => `<li>${x}</li>`).join('')}</ol>`);
      continue;
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
    i++;
  }
  return out.join('\n');
}
