/* ── PubLogic App ────────────────────────────────────────────────────────── */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const HOUR_LABELS = [
  '05:00','06:00','07:00','08:00','09:00','10:00','11:00','12:00',
  '13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00',
  '21:00','22:00','23:00','00:00','01:00','02:00','03:00','04:00'
];
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// Priority order for which category drives the headline day-of-week chart
// and heatmap for a venue. 'dept' = legacy Commodore-style all-in total.
const HEADLINE_PRIORITY = ['dept', 'food', 'bar_bev', 'bshop'];
const CATEGORY_LABELS = {
  dept: 'Department (all revenue)',
  food: 'Food (all stores)',
  bar_bev: 'Main bar beverage',
  bshop: 'Bottle shop',
};

let allFiles = [];

/* ── Content-based classification ───────────────────────────────────────── */
// Pulls "Label : value" out of the flattened report text, stopping at the
// first of the given follow-on labels (reports vary in which label comes
// next, e.g. Period Summaries have no "Till" line).
function extractField(text, label, stopLabels) {
  const stopPattern = stopLabels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:').join('|');
  const re = new RegExp(label + '\\s*:[\\s,]*(.+?)\\s*(?:' + stopPattern + ')', 'i');
  const m = text.match(re);
  return m ? m[1].trim().replace(/,$/, '') : null;
}

function extractTitle(text) {
  const m = text.match(/^\s*(.*?)\s*(?:Product\s*:|Venue\s*:)/i);
  return m ? m[1].trim() : '';
}

// The trading date lives in the report body ("From Shift: Shift: 1
// 30/06/2026"), not the filename — filenames carry the *print* date, which
// for "Yesterday" reports printed the next morning is a day later than the
// actual trading day.
function extractShiftDate(text) {
  const m = text.match(/From Shift:\s*Shift:\s*\d+\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!m) return null;
  const d = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  return isNaN(d.getTime()) ? null : d;
}

// Fallback only — used if a report has no parseable shift date in its body.
function extractDateFromFilename(name) {
  const m = name.match(/(\d{1,2})[\s_]?([A-Za-z]{3})[\s_]?(\d{4})/);
  if (!m) return null;
  const mo = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11}[m[2].toLowerCase()];
  if (mo === undefined) return null;
  const d = new Date(parseInt(m[3]), mo, parseInt(m[1]));
  return isNaN(d.getTime()) ? null : d;
}

// Classifies a report by its actual content — the Venue/Store fields and
// title inside the PDF — rather than the filename, so it works across
// venues with completely different naming conventions.
function classifyReport(text) {
  const venue = extractField(text, 'Venue', ['Store']);
  const store = extractField(text, 'Store', ['Till', 'Period']);
  if (!venue) return null;

  const title = extractTitle(text);
  const t = title.toLowerCase();
  const s = (store || '').toLowerCase();
  const isAllStores = !store || /all stores/.test(s);

  // Checked independently of the title — Period Summaries have a
  // multi-column layout where text extraction order can vary, but these
  // section headers are distinctive and always present.
  if (/stock summary|banking summary|opening stock/i.test(text)) {
    return { venue, store, title: title || 'Period Summary', category: 'period_summary', subVenue: null };
  }

  let category, subVenue = null;

  if (/bottle|bshop/.test(t) || /bottle|bshop/.test(s)) {
    category = 'bshop';
  } else if (/department|\bdept\b/.test(t)) {
    category = 'dept';
  } else if (/food/.test(t) && /bev/.test(t)) {
    category = 'food_bev_combined';
    subVenue = isAllStores ? null : store;
  } else if (/food/.test(t)) {
    category = 'food';
    subVenue = isAllStores ? null : store;
  } else if (/main\s*bar|\bmbar\b/.test(t)) {
    category = 'bar_bev';
  } else {
    // Anything else beverage/alcoholic-flavoured that isn't the main bar
    // is treated as a satellite bar (Peregrin, Bombies, Smugglers, ...).
    category = 'bar_bev';
    subVenue = isAllStores ? null : store;
  }

  return { venue, store, title, category, subVenue };
}

/* ── Date / currency helpers ─────────────────────────────────────────────── */
function dateKey(d) { return d.toISOString().slice(0,10); }
function dow(d)     { return (d.getDay() + 6) % 7; }
function cur(n)     { return '$' + Math.round(n).toLocaleString('en-AU'); }
function fmtDate(d) { return d.toLocaleDateString('en-AU', {weekday:'short', day:'numeric', month:'short'}); }
function slug(s)    { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

/* ── File reading ────────────────────────────────────────────────────────── */
async function extractPDFText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map(i => i.str).join(' ') + '\n';
  }
  return text;
}

async function extractXLSXText(file) {
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: 'array' });
  let out   = '';
  wb.SheetNames.forEach(sn => { out += XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + '\n'; });
  return out;
}

/* ── Hourly parsing ──────────────────────────────────────────────────────── */
function parseHourly(text) {
  if (!text) return null;

  const dollarNums = s => (s.match(/\$[\d,]+\.?\d*/g) || [])
    .map(m => parseFloat(m.replace(/[$,]/g, '')) || 0);

  const lines = text.split('\n');
  for (const line of lines) {
    if (/totals?/i.test(line)) {
      const nums = dollarNums(line);
      if (nums.length >= 5) {
        const total  = nums[0];
        const hourly = nums.slice(1, 25);
        while (hourly.length < 24) hourly.push(0);
        const sum = hourly.reduce((a, b) => a + b, 0);
        // A genuine $0 trading day (satellite bar closed, no sales) is a
        // valid result, not a parse failure — don't drop it.
        if (total === 0 && sum === 0) {
          return { total, hourly };
        }
        if (total > 0 && (Math.abs(sum - total) / total < 0.15 || nums.length > 10)) {
          return { total, hourly };
        }
      }
    }
  }

  // Fallback — scan all numbers
  const all = dollarNums(text);
  for (let i = 0; i < all.length - 10; i++) {
    const candidate = all.slice(i + 1, i + 25);
    const sum       = candidate.reduce((a, b) => a + b, 0);
    if (all[i] > 100 && Math.abs(sum - all[i]) / all[i] < 0.05) {
      while (candidate.length < 24) candidate.push(0);
      return { total: all[i], hourly: candidate };
    }
  }
  return null;
}

/* ── UI helpers ──────────────────────────────────────────────────────────── */
function setProgress(pct, label, count) {
  document.getElementById('progress-fill').style.width  = pct + '%';
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-count').textContent = count || '';
}

function showEl(id)  { document.getElementById(id).style.display = 'block'; }
function hideEl(id)  { document.getElementById(id).style.display = 'none';  }

/* ── File loading UI ─────────────────────────────────────────────────────── */
function handleFiles(files) {
  allFiles = Array.from(files);
  updateSummary();
}

function updateSummary() {
  document.getElementById('summary-stats').innerHTML =
    `<strong>${allFiles.length} file${allFiles.length === 1 ? '' : 's'}</strong> loaded — ` +
    `venue and report type are read from each file's contents when you analyse`;
  document.getElementById('debug-line').textContent = '';
  showEl('file-summary');
  document.getElementById('analyse-btn').disabled = allFiles.length === 0;
}

/* ── Drop zone ───────────────────────────────────────────────────────────── */
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  handleFiles(e.dataTransfer.files);
});
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', e => handleFiles(e.target.files));

/* ── Aggregation ─────────────────────────────────────────────────────────── */
// Turns a set of {date,total,hourly} day entries into every derived stat the
// UI needs — used both for a venue's headline category and for individual
// sub-venue buckets.
function computeStats(byDate) {
  const days = Object.values(byDate).sort((a, b) => a.date - b.date);
  if (!days.length) return null;

  const hourlyByDow = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const countByDow  = new Array(7).fill(0);
  const hourlyTotal = new Array(24).fill(0);
  let total = 0, best = null, worst = null;
  const totalByDay = {};

  days.forEach(d => {
    const dw = dow(d.date);
    countByDow[dw]++;
    d.hourly.forEach((v, i) => { hourlyTotal[i] += v; hourlyByDow[dw][i] += v; });
    total += d.total;
    totalByDay[dateKey(d.date)] = { total: d.total, date: d.date };
    if (!best || d.total > best.total) best = { date: d.date, total: d.total };
    if (d.total > 0 && (!worst || d.total < worst.total)) worst = { date: d.date, total: d.total };
  });

  const avgByDow = hourlyByDow.map((hrs, dw) =>
    countByDow[dw] > 0 ? hrs.map(v => v / countByDow[dw]) : new Array(24).fill(0));
  const avgDayTotal = DAYS.map((_, dw) => {
    const t = hourlyByDow[dw].reduce((s, v) => s + v, 0);
    return countByDow[dw] > 0 ? t / countByDow[dw] : 0;
  });

  const maxCell     = Math.max(...avgByDow.flatMap(r => r));
  const peakIdx     = hourlyTotal.indexOf(Math.max(...hourlyTotal));
  const activeH     = hourlyTotal.map((v, i) => ({ v, i })).filter(x => x.v > 0);
  const deadIdx     = activeH.length ? [...activeH].sort((a, b) => a.v - b.v)[0].i : -1;
  const bestDowIdx  = avgDayTotal.indexOf(Math.max(...avgDayTotal));
  const worstDowIdx = avgDayTotal.map((v, i) => ({ v, i })).filter(x => x.v > 0)
    .sort((a, b) => a.v - b.v)[0]?.i ?? -1;

  const topDays = Object.values(totalByDay).sort((a, b) => b.total - a.total).slice(0, 3);
  const botDays = Object.values(totalByDay).filter(d => d.total > 0).sort((a, b) => a.total - b.total).slice(0, 3);

  return {
    days, total, avg: total / days.length, best, worst,
    countByDow, avgByDow, avgDayTotal, hourlyTotal,
    maxCell, peakIdx, deadIdx, bestDowIdx, worstDowIdx, topDays, botDays,
  };
}

/* ── Render helpers (per venue) ──────────────────────────────────────────── */
function dowChartHTML(stats) {
  const maxAvg = Math.max(...stats.avgDayTotal);
  return DAYS.map((day, dw) => {
    const avg = stats.avgDayTotal[dw];
    const w   = maxAvg > 0 ? Math.round(avg / maxAvg * 100) : 0;
    const clr = avg > maxAvg * .8 ? '#0F766E' : avg > maxAvg * .5 ? '#14B8A6' : '#9CA3AF';
    const tc  = w > 28 ? 'white' : 'var(--ink-mid)';
    return `<div class="dow-row">
      <span class="dow-label">${day} (${stats.countByDow[dw]}d)</span>
      <div class="dow-track">
        <div class="dow-fill" style="width:${w}%;background:${clr}">
          <span style="color:${tc}">${cur(avg)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function heatmapHTML(stats) {
  return `<div class="heatmap-day-labels">${DAYS.map(d => `<span class="heatmap-day-label">${d}</span>`).join('')}</div>` +
    HOUR_LABELS.map((hr, hi) => {
      const cells = DAYS.map((_, dw) => {
        const v         = stats.avgByDow[dw][hi];
        const intensity = stats.maxCell > 0 ? v / stats.maxCell : 0;
        const bg        = intensity < 0.05
          ? '#F3F4F6'
          : `rgb(${Math.round(15 + 40 * (1 - intensity))},${Math.round(100 + 58 * (1 - intensity))},${Math.round(130 * (1 - intensity))})`;
        const tc        = intensity > 0.45 ? 'white' : '#9CA3AF';
        const label     = v > 500 ? cur(v).replace('$','').replace(',','') : '';
        return `<div class="heatmap-cell" style="background:${bg};color:${tc}" title="${hr} ${DAYS[dw]}: ${cur(v)}">${label}</div>`;
      }).join('');
      return `<div class="heatmap-row">
        <span class="heatmap-hour-label">${hr}</span>
        <div class="heatmap-cells">${cells}</div>
      </div>`;
    }).join('');
}

function flagsHTML(stats, label) {
  const flags = [];
  if (stats.best)          flags.push({ cls:'good', icon:'↑', text:`Best day (${label}): <strong>${fmtDate(stats.best.date)}</strong> — ${cur(stats.best.total)}` });
  if (stats.worst)         flags.push({ cls:'warn', icon:'↓', text:`Lowest day (${label}): <strong>${fmtDate(stats.worst.date)}</strong> — ${cur(stats.worst.total)}` });
  if (stats.bestDowIdx >= 0)  flags.push({ cls:'good', icon:'★', text:`Strongest day of week: <strong>${DAYS[stats.bestDowIdx]}</strong> (avg ${cur(stats.avgDayTotal[stats.bestDowIdx])})` });
  if (stats.worstDowIdx >= 0) flags.push({ cls:'warn', icon:'⚠', text:`Weakest day of week: <strong>${DAYS[stats.worstDowIdx]}</strong> (avg ${cur(stats.avgDayTotal[stats.worstDowIdx])}) — review rostering` });
  if (stats.deadIdx >= 0)     flags.push({ cls:'info', icon:'⏱', text:`Quietest active hour: <strong>${HOUR_LABELS[stats.deadIdx]}</strong> — check staffing levels at this time` });
  return flags.map(f =>
    `<div class="flag ${f.cls}"><span class="flag-icon">${f.icon}</span><span>${f.text}</span></div>`
  ).join('');
}

function subVenueCardHTML(sv) {
  const stats = computeStats(sv.byDate);
  if (!stats) return '';
  const catLabel = sv.category === 'food_bev_combined' ? 'Food + Bev'
                  : sv.category === 'food' ? 'Food'
                  : sv.category === 'bshop' ? 'Bottle shop' : 'Beverage';
  return `<div class="metric-card">
    <div class="metric-label">${sv.label} — ${catLabel}</div>
    <div class="metric-value">${cur(stats.total)}</div>
    <div class="metric-sub">${stats.days.length} days · avg ${cur(stats.avg)}/day · best ${fmtDate(stats.best.date)}</div>
  </div>`;
}

/* ── Venue narrative prompt ──────────────────────────────────────────────── */
function buildPrompt(venueName, headline, headlineLabel, categoryStats, subVenues) {
  const catLines = categoryStats.map(c =>
    `- ${CATEGORY_LABELS[c.key] || c.key}: total ${cur(c.stats.total)} over ${c.stats.days.length} days, daily avg ${cur(c.stats.avg)}`
  ).join('\n');

  const subLines = subVenues.map(sv => {
    const s = computeStats(sv.byDate);
    return s ? `- ${sv.label} (${sv.category}): total ${cur(s.total)} over ${s.days.length} days, daily avg ${cur(s.avg)}` : '';
  }).filter(Boolean).join('\n');

  const peakByDow = DAYS.map((day, dw) => {
    const top = headline.avgByDow[dw].map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)[0];
    return top && top.v > 0 ? day + ' peaks at ' + HOUR_LABELS[top.i] + ' (avg ' + cur(top.v) + ')' : '';
  }).filter(Boolean).join(' | ');

  return `You are a hospitality operations consultant writing a trading analysis for ${venueName}. Write 3-4 direct paragraphs — no bullet points, no headers. Be specific with hours, days, and dollar figures. This venue's POS reports revenue in separate categories that should NOT be added into one combined "total revenue" figure — do not invent or state a single grand total. Surface patterns a busy owner or manager might not notice themselves.

Revenue by category:
${catLines}
${subLines ? '\nSub-venues / satellite bars:\n' + subLines : ''}

Hourly pattern is based on ${headlineLabel}:
- Daily average: ${cur(headline.avg)} | Best day: ${headline.best ? fmtDate(headline.best.date)+' '+cur(headline.best.total) : 'n/a'} | Worst: ${headline.worst ? fmtDate(headline.worst.date)+' '+cur(headline.worst.total) : 'n/a'}
- Top 3 days: ${headline.topDays.map(d => fmtDate(d.date)+' '+cur(d.total)).join(', ')}
- Bottom 3 days: ${headline.botDays.map(d => fmtDate(d.date)+' '+cur(d.total)).join(', ')}
- Day of week averages: ${DAYS.map((d, i) => d+': '+cur(headline.avgDayTotal[i])+' ('+headline.countByDow[i]+'d)').join(' | ')}
- Peak trading hour: ${HOUR_LABELS[headline.peakIdx]} | Quietest active: ${headline.deadIdx >= 0 ? HOUR_LABELS[headline.deadIdx] : 'n/a'}
- Peak hour by day of week: ${peakByDow}

Cover: what the hourly pattern reveals about staffing opportunities, which day-of-week patterns are structurally strong or weak and why, what the best vs worst days suggest about demand drivers, and give 2 specific operational recommendations. Reference the category breakdown where relevant instead of a combined total.`;
}

async function streamBrief(prompt, targetEl) {
  targetEl.textContent = '';
  targetEl.classList.add('streaming');
  try {
    const response = await fetch('/api/analyse', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prompt }),
    });
    if (!response.ok) throw new Error(`API error ${response.status}`);

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const d = line.slice(6).trim();
          if (d === '[DONE]') break;
          try {
            const p = JSON.parse(d);
            if (p.delta?.text) targetEl.textContent += p.delta.text;
          } catch (e) { /* skip */ }
        }
      }
    }
  } catch (e) {
    targetEl.textContent = `Could not generate narrative: ${e.message}`;
  } finally {
    targetEl.classList.remove('streaming');
  }
}

/* ── Main analysis ───────────────────────────────────────────────────────── */
async function runAnalysis() {
  document.getElementById('analyse-btn').disabled = true;
  hideEl('error-msg');
  showEl('progress-wrap');

  // venues[venueName] = { categories: {key: {byDate}}, subVenues: {key: {label,category,byDate}}, periodSummaryCount }
  const venues = {};
  let parsed = 0, failed = 0, periodSummarySkipped = 0;
  const failureSamples = [];

  for (let i = 0; i < allFiles.length; i++) {
    const f = allFiles[i];
    const pct = Math.round((i / allFiles.length) * 82);
    setProgress(pct, `Reading file ${i + 1} of ${allFiles.length}`, f.name.slice(0, 50));
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0)); // keep UI responsive

    let text;
    try {
      text = f.name.toLowerCase().endsWith('.pdf')
        ? await extractPDFText(f)
        : await extractXLSXText(f);
    } catch (e) {
      failed++;
      failureSamples.push(`${f.name}: could not read file (${e.message})`);
      continue;
    }

    const info = classifyReport(text);
    if (!info) {
      failed++;
      failureSamples.push(`${f.name}: could not find a Venue field in the report`);
      continue;
    }

    if (info.category === 'period_summary') {
      periodSummarySkipped++;
      venues[info.venue] = venues[info.venue] || { categories: {}, subVenues: {}, periodSummaryCount: 0 };
      venues[info.venue].periodSummaryCount++;
      continue;
    }

    const date = extractShiftDate(text) || extractDateFromFilename(f.name);
    if (!date) {
      failed++;
      failureSamples.push(`${f.name}: recognised as "${info.title}" but no trading date found`);
      continue;
    }

    const result = parseHourly(text);
    if (!result) {
      failed++;
      failureSamples.push(`${f.name}: recognised as "${info.title}" but couldn't find an hourly totals row`);
      continue;
    }

    venues[info.venue] = venues[info.venue] || { categories: {}, subVenues: {}, periodSummaryCount: 0 };
    const v = venues[info.venue];
    const dk = dateKey(date);
    const entry = { date, total: result.total, hourly: result.hourly };

    if (!info.subVenue) {
      v.categories[info.category] = v.categories[info.category] || { byDate: {} };
      v.categories[info.category].byDate[dk] = entry;
    } else {
      const key = `${info.category}::${info.subVenue}`;
      v.subVenues[key] = v.subVenues[key] || { label: info.subVenue, category: info.category, byDate: {} };
      v.subVenues[key].byDate[dk] = entry;
    }
    parsed++;
  }

  setProgress(90, 'Aggregating patterns...', '');
  await new Promise(r => setTimeout(r, 50));

  const venueNames = Object.keys(venues);

  if (venueNames.length === 0 || parsed === 0) {
    const detail = failureSamples.slice(0, 3).map(s => `<br>• ${s}`).join('');
    document.getElementById('error-msg').innerHTML =
      `Parsed ${parsed} valid files from ${allFiles.length} uploaded. ${detail}`;
    showEl('error-msg');
    hideEl('progress-wrap');
    document.getElementById('analyse-btn').disabled = false;
    return;
  }

  setProgress(100, 'Building report...', '');
  await new Promise(r => setTimeout(r, 30));
  hideEl('progress-wrap');

  /* ── Render ──────────────────────────────────────────────────────────── */
  hideEl('upload-panel');
  showEl('results-panel');

  document.getElementById('results-title').textContent =
    `${venueNames.length} venue${venueNames.length === 1 ? '' : 's'} analysed`;
  document.getElementById('results-meta').textContent =
    `${parsed} files parsed · ${failed > 0 ? failed + ' skipped' : 'all files read successfully'}` +
    (periodSummarySkipped > 0 ? ` · ${periodSummarySkipped} period summary file${periodSummarySkipped === 1 ? '' : 's'} seen (not yet charted)` : '');

  const container = document.getElementById('venue-results');
  container.innerHTML = '';

  const briefTargets = []; // {prompt, el} queued for sequential streaming after render

  venueNames.forEach(venueName => {
    const v = venues[venueName];
    const availableCats = HEADLINE_PRIORITY.filter(k => v.categories[k]);
    const otherCats = Object.keys(v.categories).filter(k => !HEADLINE_PRIORITY.includes(k));
    const catStats = [...availableCats, ...otherCats]
      .map(key => ({ key, stats: computeStats(v.categories[key].byDate) }))
      .filter(c => c.stats);

    const metricsHTML = catStats.length ? catStats.map(c => `
      <div class="metric-card">
        <div class="metric-label">${CATEGORY_LABELS[c.key] || c.key}</div>
        <div class="metric-value">${cur(c.stats.total)}</div>
        <div class="metric-sub">${c.stats.days.length} days · avg ${cur(c.stats.avg)}/day</div>
      </div>`).join('')
      : `<div class="metric-card"><div class="metric-label">No Time Break reports</div><div class="metric-sub">Only Period Summary files were provided for this venue — those aren't charted yet.</div></div>`;

    const subVenueList = Object.values(v.subVenues);
    const subVenueHTML = subVenueList.map(subVenueCardHTML).join('');

    const primary = catStats[0]; // headline chart driver, by HEADLINE_PRIORITY order
    const vslug = slug(venueName);

    let chartSection = '';
    if (primary) {
      const label = CATEGORY_LABELS[primary.key] || primary.key;
      chartSection = `
        <div class="result-card">
          <div class="card-label">Revenue by day of week — ${label}</div>
          <div>${dowChartHTML(primary.stats)}</div>
        </div>
        <div class="result-card">
          <div class="card-label">Hourly heatmap — ${label}</div>
          <div class="heatmap-wrap">${heatmapHTML(primary.stats)}</div>
          <div class="heatmap-legend">Darker teal = higher average revenue &nbsp;·&nbsp; Hover cells for exact figures</div>
        </div>
        <div class="result-card">
          <div class="card-label">Key flags — ${label}</div>
          <div>${flagsHTML(primary.stats, label)}</div>
        </div>`;
    }

    const dateRange = primary
      ? `${fmtDate(primary.stats.days[0].date)} – ${fmtDate(primary.stats.days[primary.stats.days.length - 1].date)}`
      : '';

    const section = document.createElement('div');
    section.className = 'venue-section';
    section.innerHTML = `
      <div class="venue-header">
        <h3>${venueName}</h3>
        <p class="results-meta">${dateRange}${v.periodSummaryCount ? ` · ${v.periodSummaryCount} period summary file${v.periodSummaryCount === 1 ? '' : 's'} not charted` : ''}</p>
      </div>
      <div class="metrics-grid">${metricsHTML}</div>
      ${subVenueList.length ? `<div class="result-card"><div class="card-label">Sub-venues / satellite bars</div><div class="metrics-grid">${subVenueHTML}</div></div>` : ''}
      ${chartSection}
      <div class="result-card brief-card">
        <div class="card-label">
          <span>AI ops narrative</span>
          <span class="powered-by">Powered by Claude</span>
        </div>
        <div class="brief-text" id="brief-${vslug}"></div>
      </div>`;
    container.appendChild(section);

    if (primary) {
      const prompt = buildPrompt(venueName, primary.stats, CATEGORY_LABELS[primary.key] || primary.key, catStats, subVenueList);
      briefTargets.push({ prompt, el: section.querySelector(`#brief-${vslug}`) });
    } else {
      section.querySelector(`#brief-${vslug}`).textContent = 'Not enough category data for a narrative on this venue.';
    }
  });

  // Stream briefs one venue at a time (sequential, to stay within API limits).
  for (const { prompt, el } of briefTargets) {
    await streamBrief(prompt, el);
  }
}

/* ── Reset ───────────────────────────────────────────────────────────────── */
function resetApp() {
  allFiles = [];
  document.getElementById('file-input').value = '';
  hideEl('file-summary');
  hideEl('error-msg');
  hideEl('progress-wrap');
  hideEl('results-panel');
  showEl('upload-panel');
  document.getElementById('analyse-btn').disabled = true;
  document.getElementById('venue-results').innerHTML = '';
}
