export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Escape first, then render `code` spans so code content can't inject markup.
export function richText(s) {
  return escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function newPrRowHtml(repoSlug, pr, now) {
  const link = `<a href="${escapeHtml(pr.url)}">#${escapeHtml(pr.number)} ${escapeHtml(pr.title)}</a>`;
  return `<li class="pr"><div class="prtop">${link} <span class="prmeta">${escapeHtml(repoSlug)} &middot; opened ${escapeHtml(relTime(pr.createdAt, now))}</span></div>`
    + `<div class="prsum">${richText(pr.summary || '')}</div></li>`;
}

function taskDetailsHtml(task) {
  const head = `#${escapeHtml(task.num)} &middot; ${escapeHtml(task.state)} &middot; ${escapeHtml(task.title)}`;
  // Show the objective in full — it's the line the reader scans, so don't truncate it.
  const obj = ((task.fields && task.fields.objective) || '').trim();
  const objLine = obj ? `<span class="taskobj">${richText(obj)}</span>` : '';
  return `<details><summary><span class="thead">${head}</span>${objLine}</summary>`
    + `<pre class="taskbody">${escapeHtml(task.raw || '')}</pre></details>`;
}

function attentionRowHtml(it) {
  const head = it.prUrl
    ? `<a href="${escapeHtml(it.prUrl)}">#${escapeHtml(it.taskNum)} ${escapeHtml(it.taskTitle)}</a>`
    : `#${escapeHtml(it.taskNum)} ${escapeHtml(it.taskTitle)}`;
  return `<li class="attn-row"><div>${head} <span class="prmeta">${escapeHtml(it.repo)}</span></div>`
    + `<div class="diag">${escapeHtml(it.diagnosis)}</div></li>`;
}

export function renderAttention(items = []) {
  // Empty → a positive "all clear" line (Job B always splices this when it runs and
  // finds nothing stalled, so its presence also confirms the enrich fired).
  if (!items.length) return '<div class="allclear">&#10003; Nothing needs your attention</div>';
  return `<section class="attn"><h2>&#9888; Needs your attention</h2><ul>${items.map(attentionRowHtml).join('')}</ul></section>`;
}

const PTR_HTML = '<div id="ptr"><div id="ptr-i">&#8635;</div></div>';
const PTR_SCRIPT = "<script>(function(){"
  + "var p=document.getElementById('ptr'),s=document.getElementById('ptr-i');"
  + "var y0=0,pull=false,d=0,TH=70,MAX=120;"
  + "function top(){return (window.scrollY||document.documentElement.scrollTop||0)<=0;}"
  + "addEventListener('touchstart',function(e){if(top()){y0=e.touches[0].clientY;pull=true;d=0;p.style.transition='none';}},{passive:true});"
  + "addEventListener('touchmove',function(e){if(!pull)return;d=e.touches[0].clientY-y0;"
  + "if(d>0&&top()){e.preventDefault();var h=Math.min(d,MAX);p.style.height=h+'px';p.style.opacity=Math.min(h/TH,1);s.style.transform='rotate('+h*3+'deg)';p.className=d>TH?'ready':'';}else{pull=false;}},{passive:false});"
  + "function end(){if(!pull)return;pull=false;p.style.transition='height .25s,opacity .25s';"
  + "if(d>TH){p.className='loading';location.replace(location.pathname+'?_='+Date.now());}else{p.style.height='0';p.style.opacity='0';}}"
  + "addEventListener('touchend',end);addEventListener('touchcancel',end);"
  + "})();</script>";

const STYLE = `*{box-sizing:border-box;margin:0}`
  + `body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.45}`
  + `.wrap{max-width:900px;margin:0 auto;padding:20px}`
  + `header.top{padding:8px 0 16px;border-bottom:1px solid #1e293b;margin-bottom:16px}`
  + `header.top .gen{font-size:16px;color:#7dd3fc;font-weight:600}`
  + `header.top h1{font-size:28px;margin-top:4px}`
  + `h2{font-size:21px;margin:22px 0 8px;color:#cbd5e1}`
  + `.window{color:#94a3b8;font-size:14px;margin-bottom:8px}`
  + `ul{list-style:none;padding:0}`
  + `.pr{padding:9px 0;border-bottom:1px solid #1e293b}`
  + `.prmeta{color:#94a3b8;font-size:13px}`
  + `.prsum{font-size:14px;margin-top:3px;color:#cbd5e1}`
  + `.prerr,.empty{color:#fca5a5;padding:8px 0;font-size:14px}`
  + `.empty{color:#94a3b8}`
  + `h3.repo{font-size:16px;margin:16px 0 6px;color:#94a3b8}`
  + `details{margin:5px 0;border-bottom:1px solid #1e293b;padding-bottom:5px}`
  + `summary{cursor:pointer;font-size:15px}`
  + `.taskobj{display:block;color:#94a3b8;font-size:13px;font-weight:400;margin-top:2px}`
  + `.taskbody{white-space:pre-wrap;background:#0b1220;border-radius:8px;padding:12px;margin-top:6px;font-size:13px;overflow-x:auto}`
  + `.attn{background:#3a1d1d;border-left:4px solid #f87171;border-radius:8px;padding:12px 16px;margin-bottom:16px}`
  + `.attn h2{font-size:18px;color:#fca5a5;border:0;margin:0 0 8px}`
  + `.attn-row{padding:6px 0}`
  + `.attn .diag{color:#fecaca;font-size:14px;margin-top:2px}`
  + `.allclear{color:#4ade80;font-size:14px;margin-bottom:14px}`
  + `code{background:#0b1220;padding:1px 5px;border-radius:4px;font-size:.92em}`
  + `a{color:#7dd3fc}`
  + `#ptr{height:0;overflow:hidden;display:flex;align-items:flex-end;justify-content:center;padding-bottom:8px;opacity:0;color:#7dd3fc}`
  + `#ptr-i{font-size:26px;line-height:1}#ptr.ready{color:#38bdf8}`
  + `#ptr.loading #ptr-i{animation:ptrspin .7s linear infinite}@keyframes ptrspin{to{transform:rotate(360deg)}}`
  + `footer{margin-top:24px;padding-top:12px;border-top:1px solid #1e293b;font-size:13px;color:#94a3b8}`;

export function renderDigest({ generatedAt, since, repos = [], now = Date.now() }) {
  // New PRs section
  let prsBody = '';
  let count = 0;
  for (const r of repos) {
    if (r.prError) { prsBody += `<li class="prerr">${escapeHtml(r.slug)}: PRs unavailable</li>`; continue; }
    for (const pr of (r.newPrs || [])) { count++; prsBody += newPrRowHtml(r.slug, pr, now); }
  }
  if (!prsBody) prsBody = '<li class="empty">No new PRs.</li>';

  // Tasks section
  let tasksBody = '';
  if (!repos.length) {
    tasksBody = '<p class="empty">No task queues found.</p>';
  } else {
    for (const r of repos) {
      tasksBody += `<h3 class="repo">${escapeHtml(r.slug)}</h3>`;
      tasksBody += (r.tasks || []).length
        ? r.tasks.map(taskDetailsHtml).join('')
        : '<p class="empty">No tasks.</p>';
    }
  }

  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>Review digest &mdash; ${escapeHtml(generatedAt)}</title><style>${STYLE}</style></head>`
    + `<body>${PTR_HTML}<div class="wrap">`
    + `<header class="top"><div class="gen">Generated ${escapeHtml(generatedAt)}</div><h1>Review digest</h1></header>`
    + `<!--ATTENTION-SLOT-->`
    + `<section class="prs"><h2>Pull requests</h2><div class="window">${escapeHtml(since)}${count ? ` &middot; ${count}` : ''}</div><ul>${prsBody}</ul></section>`
    + `<section class="tasks-sec"><h2>Tasks</h2>${tasksBody}</section>`
    + `<footer><a href="./archive/">archive &rarr;</a></footer>`
    + `</div>${PTR_SCRIPT}</body></html>`;
}

export function renderArchiveIndex(dates = []) {
  const items = dates.map((d) =>
    `<li><a href="./${escapeHtml(d)}.html">${escapeHtml(d)}</a></li>`).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>Review digest archive</title>`
    + `<style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;max-width:700px;margin:0 auto;padding:20px}a{color:#7dd3fc}li{padding:6px 0;list-style:none}h1{font-size:24px}</style></head>`
    + `<body><h1>Review digest &mdash; archive</h1><ul style="padding:0">${items}</ul>`
    + `<p><a href="../">&larr; latest</a></p></body></html>`;
}
