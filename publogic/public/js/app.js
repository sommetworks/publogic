/* ── PubLogic App ────────────────────────────────────────────────────────── */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const HOUR_LABELS = [
  '05:00','06:00','07:00','08:00','09:00','10:00','11:00','12:00',
  '13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00',
  '21:00','22:00','23:00','00:00','01:00','02:00','03:00','04:00'
];
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

let allFiles = [];

/* ── File classification ─────────────────────────────────────────────────── */
function norm(n) { return n.toLowerCase().replace(/[\s_]+/g, '_'); }

function classifyFile(name) {
  const n = norm(name);
  if (n.includes('department_time_break'))     return 'dept';
  if (n.includes('food_time_break'))           return 'food';
  if (n.includes('hotel_beverage_time_break')) return 'bar_bev';
  if (n.includes('bshop_beverage_time_break')) return 'bshop';
  if (n.includes('smugglers_till_time_break')) return 'smugglers';
  return null;
}

function extractDate(name) {
  const m = name.match(/(\d{1,2})[\s_]?([A-Za-z]{3})[\s_]?(\d{4})/);
  if (!m) return null;
  const mo = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11}[m[2].toLowerCase()];
  if (mo === undefined) return null;
  const d = new Date(parseInt(m[3]), mo, parseInt(m[1]));
  return isNaN(d.getTime()) ? null : d;
}

function dateKey(d) { return d.toISOString().slice(0,10); }
function dow(d)     { return (d.getDay() + 6) % 7; }
function cur(n)     { return '$' + Math.round(n).toLocaleString('en-AU'); }
function fmtDate(d) { return d.toLocaleDateString('en-AU', {weekday:'short', day:'numeric', month:'short'}); }

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
  const typeCounts = {}, dateCounts = new Set();
  let unrecog = 0, sampleName = '', sampleType = '', sampleDate = '';

  allFiles.forEach(f => {
    const type = classifyFile(f.name), date = extractDate(f.name);
    if (!sampleName) {
      sampleName = f.name;
      sampleType = type || 'NOT RECOGNISED';
      sampleDate = date ? fmtDate(date) : 'NOT FOUND';
    }
    if (type) typeCounts[type] = (typeCounts[type] || 0) + 1;
    else unrecog++;
    if (date) dateCounts.add(dateKey(date));
  });

  const typeCount = Object.keys(typeCounts).length;
  const dayCount  = dateCounts.size;

  document.getElementById('summary-stats').innerHTML =
    `<strong>${allFiles.length} files</strong> loaded — ` +
    `<strong>${dayCount} trading days</strong> — ` +
    `<strong>${typeCount}/5</strong> report types — ` +
    `<strong style="color:${unrecog > 0 ? '#DC2626' : '#16A34A'}">${unrecog} unrecognised</strong>`;

  document.getElementById('debug-line').textContent =
    `Sample: "${sampleName}" → type: ${sampleType} | date: ${sampleDate}`;

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

/* ── Main analysis ───────────────────────────────────────────────────────── */
async function runAnalysis() {
  document.getElementById('analyse-btn').disabled = true;
  hideEl('error-msg');
  showEl('progress-wrap');

  const dayData = {};
  let parsed = 0, failed = 0;

  for (let i = 0; i < allFiles.length; i++) {
    const f = allFiles[i];
    const pct = Math.round((i / allFiles.length) * 82);
    setProgress(pct, `Reading file ${i + 1} of ${allFiles.length}`, f.name.slice(0, 50));
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0)); // keep UI responsive

    const type = classifyFile(f.name);
    const date = extractDate(f.name);
    if (!type || !date) { failed++; continue; }

    const dk = dateKey(date);
    if (!dayData[dk]) dayData[dk] = { date, types: {} };

    try {
      const text   = f.name.toLowerCase().endsWith('.pdf')
        ? await extractPDFText(f)
        : await extractXLSXText(f);
      const result = parseHourly(text);
      if (result) { dayData[dk].types[type] = result; parsed++; }
      else failed++;
    } catch (e) { failed++; }
  }

  setProgress(90, 'Aggregating patterns...', '');
  await new Promise(r => setTimeout(r, 50));

  const days = Object.values(dayData).sort((a, b) => a.date - b.date);

  if (days.length === 0 || parsed === 0) {
    document.getElementById('error-msg').innerHTML =
      `Parsed ${parsed} valid files from ${allFiles.length} uploaded. ` +
      `Check the debug line — if type shows "NOT RECOGNISED" share a sample filename.`;
    showEl('error-msg');
    hideEl('progress-wrap');
    document.getElementById('analyse-btn').disabled = false;
    return;
  }

  /* ── Aggregate data ─────────────────────────────────────────────────── */
  const hourlyByDow = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const countByDow  = new Array(7).fill(0);
  const hourlyTotal = new Array(24).fill(0);
  let grandTotal = 0, foodTotal = 0, barTotal = 0, bshopTotal = 0;
  let bestDay = null, worstDay = null;
  const totalByDay = {};

  days.forEach(d => {
    const dept  = d.types['dept'];
    const food  = d.types['food'];
    const bar   = d.types['bar_bev'];
    const bshop = d.types['bshop'];
    const dayT  = dept ? dept.total : 0;
    const dw    = dow(d.date);
    totalByDay[dateKey(d.date)] = { total: dayT, date: d.date };
    countByDow[dw]++;
    if (dept) {
      dept.hourly.forEach((v, i) => { hourlyTotal[i] += v; hourlyByDow[dw][i] += v; });
      grandTotal += dayT;
    }
    if (food)  foodTotal  += food.total;
    if (bar)   barTotal   += bar.total;
    if (bshop) bshopTotal += bshop.total;
    if (!bestDay  || dayT > bestDay.total)              bestDay  = { date: d.date, total: dayT };
    if (dayT > 0 && (!worstDay || dayT < worstDay.total)) worstDay = { date: d.date, total: dayT };
  });

  const avgByDow    = hourlyByDow.map((hrs, dw) =>
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

  setProgress(100, 'Building report...', '');
  await new Promise(r => setTimeout(r, 30));
  hideEl('progress-wrap');

  /* ── Render results ─────────────────────────────────────────────────── */
  hideEl('upload-panel');
  showEl('results-panel');

  document.getElementById('results-title').textContent =
    days.length > 0
      ? `${fmtDate(days[0].date)} – ${fmtDate(days[days.length - 1].date)}`
      : 'Trading Analysis';

  document.getElementById('results-meta').textContent =
    `${parsed} files parsed · ${days.length} trading days · ${failed > 0 ? failed + ' skipped' : 'all files read successfully'}`;

  // Metrics
  const metricsEl = document.getElementById('metrics-grid');
  const metrics = [
    { label: 'Total revenue',   value: cur(grandTotal),              sub: `${days.length} days` },
    { label: 'Daily average',   value: cur(grandTotal / days.length), sub: 'per trading day' },
    { label: 'Food revenue',    value: cur(foodTotal),               sub: `${grandTotal ? Math.round(foodTotal/grandTotal*100) : 0}% of total` },
    { label: 'Bar beverage',    value: cur(barTotal),                sub: '' },
    { label: 'Bottle shop',     value: cur(bshopTotal),              sub: '' },
    { label: 'Peak hour',       value: HOUR_LABELS[peakIdx],         sub: 'highest avg revenue' },
  ];
  metricsEl.innerHTML = metrics.map(m => `
    <div class="metric-card">
      <div class="metric-label">${m.label}</div>
      <div class="metric-value">${m.value}</div>
      ${m.sub ? `<div class="metric-sub">${m.sub}</div>` : ''}
    </div>`).join('');

  // DOW chart
  const maxAvg = Math.max(...avgDayTotal);
  const dowEl  = document.getElementById('dow-chart');
  dowEl.innerHTML = DAYS.map((day, dw) => {
    const avg = avgDayTotal[dw];
    const w   = maxAvg > 0 ? Math.round(avg / maxAvg * 100) : 0;
    const clr = avg > maxAvg * .8 ? '#0F766E' : avg > maxAvg * .5 ? '#14B8A6' : '#9CA3AF';
    const tc  = w > 28 ? 'white' : 'var(--ink-mid)';
    return `<div class="dow-row">
      <span class="dow-label">${day} (${countByDow[dw]}d)</span>
      <div class="dow-track">
        <div class="dow-fill" style="width:${w}%;background:${clr}">
          <span style="color:${tc}">${cur(avg)}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  // Heatmap
  const hmEl = document.getElementById('heatmap');
  hmEl.innerHTML =
    `<div class="heatmap-day-labels">${DAYS.map(d => `<span class="heatmap-day-label">${d}</span>`).join('')}</div>` +
    HOUR_LABELS.map((hr, hi) => {
      const cells = DAYS.map((_, dw) => {
        const v         = avgByDow[dw][hi];
        const intensity = maxCell > 0 ? v / maxCell : 0;
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

  // Flags
  const flagsEl = document.getElementById('flags');
  const flags   = [];
  if (bestDay)           flags.push({ cls:'good', icon:'↑', text:`Best day: <strong>${fmtDate(bestDay.date)}</strong> — ${cur(bestDay.total)}` });
  if (worstDay)          flags.push({ cls:'warn', icon:'↓', text:`Lowest day: <strong>${fmtDate(worstDay.date)}</strong> — ${cur(worstDay.total)}` });
  if (bestDowIdx >= 0)   flags.push({ cls:'good', icon:'★', text:`Strongest day of week: <strong>${DAYS[bestDowIdx]}</strong> (avg ${cur(avgDayTotal[bestDowIdx])})` });
  if (worstDowIdx >= 0)  flags.push({ cls:'warn', icon:'⚠', text:`Weakest day of week: <strong>${DAYS[worstDowIdx]}</strong> (avg ${cur(avgDayTotal[worstDowIdx])}) — review rostering` });
  if (deadIdx >= 0)      flags.push({ cls:'info', icon:'⏱', text:`Quietest active hour: <strong>${HOUR_LABELS[deadIdx]}</strong> — check staffing levels at this time` });
  flagsEl.innerHTML = flags.map(f =>
    `<div class="flag ${f.cls}"><span class="flag-icon">${f.icon}</span><span>${f.text}</span></div>`
  ).join('');

  // AI Brief
  const briefEl = document.getElementById('brief-text');
  briefEl.textContent = '';
  briefEl.classList.add('streaming');

  const prompt = `You are a hospitality operations consultant writing a monthly trading analysis for the Commodore Hotel, Sydney. Write 4-5 direct paragraphs — no bullet points, no headers. Be specific with hours, days, and dollar figures. Surface patterns that a busy owner or manager might not notice themselves.

Trading data (${days.length} days):
- Total revenue: ${cur(grandTotal)} | Daily avg: ${cur(grandTotal / days.length)}
- Food: ${cur(foodTotal)} (${grandTotal ? Math.round(foodTotal/grandTotal*100) : 0}%) | Bar beverage: ${cur(barTotal)} | Bottle shop: ${cur(bshopTotal)}
- Best day: ${bestDay ? fmtDate(bestDay.date)+' '+cur(bestDay.total) : 'n/a'} | Worst: ${worstDay ? fmtDate(worstDay.date)+' '+cur(worstDay.total) : 'n/a'}
- Top 3 days: ${topDays.map(d => fmtDate(d.date)+' '+cur(d.total)).join(', ')}
- Bottom 3 days: ${botDays.map(d => fmtDate(d.date)+' '+cur(d.total)).join(', ')}
- Day of week averages: ${DAYS.map((d, i) => d+': '+cur(avgDayTotal[i])+' ('+countByDow[i]+'d)').join(' | ')}
- Peak trading hour: ${HOUR_LABELS[peakIdx]} | Quietest active: ${deadIdx >= 0 ? HOUR_LABELS[deadIdx] : 'n/a'}
- Peak hour by day of week: ${DAYS.map((day, dw) => {
    const top = avgByDow[dw].map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)[0];
    return top && top.v > 0 ? day+' peaks at '+HOUR_LABELS[top.i]+' (avg '+cur(top.v)+')' : '';
  }).filter(Boolean).join(' | ')}

Cover: what the hourly patterns reveal about staffing opportunities, which day-of-week patterns are structurally strong or weak and why, what the best vs worst days suggest about demand drivers, and give 2 specific operational recommendations.`;

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
            if (p.delta?.text) briefEl.textContent += p.delta.text;
          } catch (e) { /* skip */ }
        }
      }
    }
  } catch (e) {
    briefEl.textContent = `Could not generate narrative: ${e.message}`;
  } finally {
    briefEl.classList.remove('streaming');
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
  document.getElementById('brief-text').textContent = '';
  document.getElementById('metrics-grid').innerHTML = '';
  document.getElementById('dow-chart').innerHTML = '';
  document.getElementById('heatmap').innerHTML = '';
  document.getElementById('flags').innerHTML = '';
}
