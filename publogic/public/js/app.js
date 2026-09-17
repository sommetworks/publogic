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
// Every "Label : value" header field seen across report families — used as
// the universal stop-set so extractField doesn't need to know in advance
// which label follows which (field order varies: daily reports go
// Venue/Store/Till/Period, weekly ones go Group/Period, Stock Loss puts
// Period before Venue, etc).
const HEADER_STOP_LABELS = ['Venue', 'Store', 'Till', 'Display Period', 'Period', 'Group', 'From Shift', 'To Shift', 'Flags', 'FILTER', 'Product', 'Report By Location', 'Table Group'];

// Pulls "Label : value" out of the flattened report text, stopping at the
// next header label (whichever comes first) or end of text.
//
// Labels are word-boundary anchored (\b) — without it, a bare "Venue"
// pattern matches as a substring inside unrelated words like "Revenue:",
// which shows up repeatedly in Period Summary reports' per-category sales
// breakdown ("Event Revenue:", etc). An unanchored match there hijacks the
// label search and swallows everything up to the *real* field further
// down the text.
function extractField(text, label) {
  // Most labels use ":", but FILTER lines use "=" — accept either.
  const stopPattern = HEADER_STOP_LABELS.filter(l => l !== label)
    .map(l => '\\b' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]').join('|');
  const re = new RegExp('\\b' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:[\\s,]*(.{1,120}?)\\s*(?:' + stopPattern + '|$)', 'i');
  const m = text.match(re);
  return m ? m[1].trim().replace(/,$/, '') : null;
}

function extractTitle(text) {
  // Group is also a valid boundary (Staff Sales has no Product/Venue field
  // at all) — but "Product Group :" is one label, not two, so a Group
  // match immediately after "Product " doesn't count.
  // Same word-boundary reasoning as extractField above: without \b, "Venue"
  // can match inside "Revenue" deep in the report body and drag the
  // "title" capture across nearly the whole document.
  const m = text.match(/^\s*(.*?)\s*(?:\bProduct\s*:|\bVenue\s*:|\bStore\s*:|\bTill\s*:|\bDisplay Period\s*:|\bFrom Shift\s*:|(?<!Product\s)\bGroup\s*:)/i);
  let title = m ? m[1].trim() : text.trim();

  // Belt-and-braces cap: some weekly XLSX exports put the Criteria sheet
  // (and therefore every stop label above) at the very END of the workbook,
  // after a large data table and sometimes a ValueList_Helper lookup sheet
  // — e.g. a Stock Loss weekly export's Criteria sheet lands after ~230 rows
  // of transaction data. Without a cap, the "title" balloons to include that
  // entire table, which can then accidentally contain an unrelated keyword
  // (a till named "Bottleshop 4", a comment mentioning "food", etc) and
  // hijack classifyReport's keyword matching. The real title is always the
  // first sheet's name, well under this length.
  if (title.length > 80) title = title.slice(0, 80).trim();
  return title;
}

// The trading date lives in the report body ("From Shift: Shift: 1
// 30/06/2026"), not the filename — filenames carry the *print* date, which
// for "Yesterday" reports printed the next morning is a day later than the
// actual trading day.
function extractShiftDate(text) {
  let m = text.match(/From Shift:\s*Shift:\s*\d+\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!m) {
    // Bepoz's XLSX exports don't carry a "From Shift:" line at all — the
    // trading date instead lives in "Display Period: Yesterday (Shift: 1
    // 02/08/2026)" on the Criteria sheet. Without this fallback the date
    // silently falls back to the filename's *print* date, which for
    // "Yesterday" reports printed the next morning is a day later than the
    // actual trading day.
    m = text.match(/Display Period:.{0,40}?Shift:\s*\d+\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  }
  if (!m) return null;
  const d = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  return isNaN(d.getTime()) ? null : d;
}

// Weekly reports cover a From/To range rather than a single trading day.
function extractShiftDateRange(text) {
  let m = text.match(/From Shift:\s*Shift:\s*\d+\s+(\d{1,2})\/(\d{1,2})\/(\d{4}).*?To Shift:\s*Shift:\s*\d+\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/is);
  if (!m) {
    // Bepoz's weekly XLSX exports don't carry "From Shift:...To Shift:..."
    // at all — the range instead lives in "Display Period: Last Week
    // (Shift: 1 07/09/2026 - Shift: 1 13/09/2026 (7 Days))" on the Criteria
    // sheet, confirmed consistent across every weekly XLSX report family
    // (Staff Sales, Product Summary, Stock Loss, Bulk Beer Litres, ...).
    m = text.match(/Display Period:.{0,30}?\(\s*Shift:\s*\d+\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*Shift:\s*\d+\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/is);
  }
  if (!m) return null;
  const from = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  const to   = new Date(parseInt(m[6]), parseInt(m[5]) - 1, parseInt(m[4]));
  return (isNaN(from.getTime()) || isNaN(to.getTime())) ? null : { from, to };
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
  // Most reports carry "Venue :"; Staff Sales instead only has "Group :
  // Commodore" (a shorthand for the venue name — merged back together by
  // resolveVenueKey at aggregation time). Bepoz's weekly Staff Sales XLSX
  // export carries neither field at all (confirmed on real Harbord Hotel
  // data — its Criteria sheet has no Venue/Store/Group row whatsoever), so
  // this can legitimately come back empty; callers fold the placeholder
  // into whichever single real venue is already in the batch, the same way
  // a generic "All Venues" filter is folded (see resolveVenueKey).
  const venue = extractField(text, 'Venue') || extractField(text, 'Group');
  const store = extractField(text, 'Store');

  const title = extractTitle(text);
  const t = title.toLowerCase();
  const s = (store || '').toLowerCase();
  const isAllStores = !store || /all stores/.test(s);

  // Nothing to identify this report by at all — genuinely unparseable.
  if (!venue && !title) return null;

  // Checked independently of the title — Period Summaries have a
  // multi-column layout where text extraction order can vary, but these
  // section headers are distinctive and always present.
  if (/stock summary|banking summary|opening stock/i.test(text)) {
    return { venue: venue || '(Unknown Venue)', store, title: title || 'Period Summary', category: 'period_summary', subVenue: null };
  }

  // Bepoz's weekly exports carry a "Display Period: Last Week (Shift: N D1
  // - Shift: N D2 (N Days))" range instead of a single trading-day shift —
  // used below to keep a weekly-shaped report that doesn't match any known
  // weekly sub-type out of the daily-report categories (dept/food/bar_bev/
  // bshop), which expect a single day of hourly data, not a 7-day range.
  // NOTE: a *daily* report's own "From Shift:...To Shift:..." line also
  // matches extractShiftDateRange (a single trading day is a range whose
  // from/to dates happen to be equal), so isWeekly requires an actual
  // multi-day span, not just a successful range match.
  const shiftRange = extractShiftDateRange(text);
  const isWeekly = !!shiftRange && shiftRange.from.getTime() !== shiftRange.to.getTime();

  let category, subVenue = null;

  // Specific report-type keywords are checked FIRST, before the generic
  // store-name-based shortcuts below — otherwise a weekly Product Summary
  // report against a store named "HH Bottleshop" (real example: Harbord
  // Hotel's "Prod Summ Weekly Bshop") gets hijacked into the daily 'bshop'
  // headline category purely because its store name contains "Bottleshop",
  // never reaching the "prod summ" check at all.
  if (/staff sales/.test(t)) {
    category = 'staff_sales';
  } else if (/weekly cog|\bcog\b/.test(t)) {
    category = 'cogs';
  } else if (/\bprod(uct)?\s*summ?\b/.test(t)) {
    // Matches "Prod Summ"/"Product Summary" (the common spelling) and also
    // "Prod Sum" (single 'm' — confirmed on Harbord's BombieFood/Hotel Food
    // Product Summary weekly exports).
    category = 'product_mix';
  } else if (/manager.{0,10}stock\s*loss/.test(t)) {
    // Checked before the plain "stock loss" match below — despite the name,
    // Bepoz's "Manager Stockloss" export is a completely different report:
    // it's a table/tab close-out list (comped manager & staff meals written
    // off as a loss), not a product-level stock-loss transaction log. Real
    // Harbord Hotel data confirms the two need separate parsers entirely.
    category = 'table_writeoffs';
  } else if (/bulk\s*beer/.test(t)) {
    category = 'bulk_beer';
  } else if (/stock\s*loss/.test(t)) {
    // \s* (not a literal space) also matches "Stockloss" run together —
    // confirmed on Harbord's "Manager Stockloss Last WK" export (though
    // that's now caught by the manager-specific check above first).
    category = 'stock_loss';
  } else if (/account\s*summ/.test(t)) {
    category = 'account_summary';
  } else if (/bottle|bshop/.test(t) || /bottle|bshop/.test(s)) {
    category = isWeekly ? 'unsupported_weekly' : 'bshop';
  } else if (/department|\bdept\b/.test(t)) {
    category = isWeekly ? 'unsupported_weekly' : 'dept';
  } else if (/food/.test(t) && /bev/.test(t)) {
    category = isWeekly ? 'unsupported_weekly' : 'food_bev_combined';
    subVenue = isWeekly ? null : (isAllStores ? null : store);
  } else if (/food/.test(t)) {
    category = isWeekly ? 'unsupported_weekly' : 'food';
    subVenue = isWeekly ? null : (isAllStores ? null : store);
  } else if (/main\s*bar|\bmbar\b|\bhotel\b/.test(t)) {
    // Some venues rename their main-bar report over time without changing
    // its Store field — Harbord Hotel's "Mbar Time Break Alcoholic" and
    // "HH Hotel Time Break Alc" are confirmed to be the same report family
    // (both against Store "HH Hotel"), just from different periods.
    category = isWeekly ? 'unsupported_weekly' : 'bar_bev';
  } else if (isWeekly) {
    // A genuinely new/unrecognised weekly report shape (e.g. Harbord's
    // "Bulk Beer Litres Last Week", which has no product-mix-style keyword
    // and a plain "All Stores" store field) — surfaced to the user as
    // "recognised, not yet supported" rather than being force-fitted into
    // a daily category and run through hourly parsing, which is the exact
    // "weekly treated as daily" symptom this was built to fix.
    category = 'unsupported_weekly';
  } else {
    // Anything else beverage/alcoholic-flavoured that isn't the main bar
    // is treated as a satellite bar (Peregrin, Bombies, Smugglers, ...).
    category = 'bar_bev';
    subVenue = isAllStores ? null : store;
  }

  return { venue: venue || '(Unknown Venue)', store, title, category, subVenue };
}

// "Commodore" (from a Staff Sales report's Group field) and "Commodore
// Hotel" (from every other report) are the same venue. Merges the new name
// into an existing bucket when one is a substring of the other, keeping
// whichever name is more descriptive as the canonical key.
function resolveVenueKey(venues, rawName) {
  const norm = s => s.toLowerCase().trim();
  // "(Unknown Venue)" is classifyReport's placeholder for a report with no
  // Venue/Store/Group field at all (Bepoz's weekly Staff Sales export) —
  // folded into the batch's one real venue exactly like a generic "All
  // Venues" filter.
  const isGeneric = s => /^all venues?$/i.test(s) || /^\(unknown venue\)$/i.test(s);
  const n = norm(rawName);
  const keys = Object.keys(venues);

  // Some Bepoz Period Summary exports carry a generic "All Venues" Venue
  // filter even when the Store field is store-specific (and even when a
  // sibling report for the same store, like its Time Break export, correctly
  // says the real venue name) — seen on real Harbord Hotel data. Don't let
  // that spawn a phantom "All Venues" venue: fold it into the one real venue
  // already in this batch, in whichever order the files land.
  if (isGeneric(n)) {
    const realKeys = keys.filter(k => !isGeneric(norm(k)));
    if (realKeys.length === 1) return realKeys[0];
    // Zero or multiple real venues so far — genuinely ambiguous, fall
    // through to the normal matching below (reuse/start an "All Venues"
    // bucket rather than guess).
  } else {
    const genericKeys = keys.filter(k => isGeneric(norm(k)));
    if (genericKeys.length === 1 && keys.length === 1) {
      venues[rawName] = venues[genericKeys[0]];
      delete venues[genericKeys[0]];
      return rawName;
    }
  }

  for (const key of keys) {
    const nk = norm(key);
    if (nk === n) return key;
    if (nk.includes(n) || n.includes(nk)) {
      if (rawName.length > key.length) {
        venues[rawName] = venues[key];
        delete venues[key];
        return rawName;
      }
      return key;
    }
  }
  return rawName;
}

/* ── Weekly report table parsing ─────────────────────────────────────────── */
// Bepoz reprints the report's column-header row (plus a "(cont.)" page
// marker) at the top of every new page. When a product/category/staff list
// continues across a page break, that repeated header can run directly into
// the next row's real name with no separator — e.g. "...NettTotal of Sales
// Amt of Sales Veuve Clicquot NV" instead of just "Veuve Clicquot NV".
// cleanLeakedName() recovers the real trailing name by cutting after the
// last recognisable header-column marker; if nothing recoverable is left,
// the row is dropped (returns null) rather than shown with a corrupted
// label — losing one row's data is far better than mislabeling it.
const HEADER_LEAK_WORDS = /\b(Product Name|Size Name|Units Sold|NettTotal|CostEx|Profit Amt|CostInc|Gross Sales|Last Trans)\b/i;
const HEADER_LEAK_MARKERS = /(?:of\s+Sales|Last\s+Trans\.?)/gi;
function cleanLeakedName(raw) {
  if (!HEADER_LEAK_WORDS.test(raw)) return raw;
  let lastEnd = -1, m;
  HEADER_LEAK_MARKERS.lastIndex = 0;
  while ((m = HEADER_LEAK_MARKERS.exec(raw))) lastEnd = m.index + m[0].length;
  const cleaned = lastEnd >= 0 ? raw.slice(lastEnd).trim() : raw.trim();
  if (!cleaned || cleaned.length < 2 || HEADER_LEAK_WORDS.test(cleaned)) return null;
  return cleaned;
}

// Row shape: "Name  <int qty>  $gross  -$discount  $nett  dd.dd%  $cost
// $profit  dd.dd%  DD-Mon-YYYY HH:MM:SS AM/PM". Column gaps are sometimes
// zero-width in extracted text, so separators are \s* not \s+ throughout.
function parseStaffSalesRows(text) {
  // Name capture is bounded (not open-ended) so a repeated page-header line
  // can never run away and swallow real rows beyond it — see
  // cleanLeakedName() above for what happens when one leaks in anyway.
  const rowRe = /([A-Za-z][A-Za-z .'-]{0,149}?)\s+(\d+)\s+\$([\d,]+\.\d{2})\s+(-?)\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+([\d.]+)%\s*(-?)\$([\d,]+\.\d{2})\s+(-?)\$([\d,]+\.\d{2})\s+(-?[\d.]+)%\s*(\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2}\s*[AP]M)/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(text))) {
    const name = cleanLeakedName(m[1].trim());
    if (name === null) continue;
    rows.push({
      name,
      transactions: parseInt(m[2], 10),
      grossSales: parseFloat(m[3].replace(/,/g, '')),
      discount: (m[4] ? -1 : 1) * parseFloat(m[5].replace(/,/g, '')),
      nettTotal: parseFloat(m[6].replace(/,/g, '')),
      pctOfNett: parseFloat(m[7]),
      costOfSales: (m[8] ? -1 : 1) * parseFloat(m[9].replace(/,/g, '')),
      profitAmt: (m[10] ? -1 : 1) * parseFloat(m[11].replace(/,/g, '')),
      profitPct: parseFloat(m[12]),
      lastTrans: m[13].trim(),
    });
  }
  return rows;
}

// Shared row shape for Weekly COG (categories) and Prod Summ Weekly
// (individual products) — both list "<Name>  All Sizes  qty  $nett  dd.dd%
// $costEx  $profit  dd.dd%  $costInc". Per-type subtotal rows in the
// product summary don't say "All Sizes", so they're naturally skipped.
function parseSizedRows(text) {
  // A handful of heavily-discounted items sell at a loss, so profit $ and %
  // (and occasionally nett total, for returns/adjustments) can be negative.
  // Name capture is bounded (not open-ended) — see cleanLeakedName() above.
  const rowRe = /([A-Za-z][\w &+'./()%$-]{0,149}?)\s+All Sizes\s+([\d,]+\.\d{2})\s+(-?)\$([\d,]+\.\d{2})\s+(-?[\d.]+)%\s*\$([\d,]+\.\d{2})\s+(-?)\$([\d,]+\.\d{2})\s+(-?[\d.]+)%\s*\$([\d,]+\.\d{2})/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(text))) {
    const name = cleanLeakedName(m[1].trim());
    if (name === null) continue;
    rows.push({
      name,
      qty: parseFloat(m[2].replace(/,/g, '')),
      nettTotal: (m[3] ? -1 : 1) * parseFloat(m[4].replace(/,/g, '')),
      pctOfNett: parseFloat(m[5]),
      costEx: parseFloat(m[6].replace(/,/g, '')),
      profitAmt: (m[7] ? -1 : 1) * parseFloat(m[8].replace(/,/g, '')),
      profitPct: parseFloat(m[9]),
      costInc: parseFloat(m[10].replace(/,/g, '')),
    });
  }
  return rows;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// parseStaffSalesRows/parseSizedRows above read the flattened, regex-matched
// text — which works for PDF weekly reports because Bepoz's PDF renderer
// always prints every figure pre-formatted ("$1,204.70", "67.34%"). Bepoz's
// weekly XLSX exports do NOT do this for individual line-item rows: only
// the per-category/grand "Totals:" rows carry formatted display strings —
// every individual product or staff row is a raw, unformatted number (and
// sometimes a floating-point artifact like 7.1e-15 instead of an exact
// zero), confirmed on all of Harbord Hotel's real weekly XLSX exports. The
// text-regex parsers can't match those rows at all (no "$"/"%" to anchor
// on), and their open-ended name capture can wander across several
// unrelated rows looking for one, producing exactly the garbled
// concatenated-row output seen in production. These read the workbook's
// cells directly instead, by column position, whenever one is available.
function findDataSheet(workbook) {
  if (!workbook) return null;
  const name = workbook.SheetNames.find(n => !/^criteria/i.test(n) && n !== 'ValueList_Helper');
  return name ? workbook.Sheets[name] : null;
}

// Bepoz ships weekly Product Summary XLSX exports in two different column
// layouts, confirmed on real Harbord Hotel data — same report family, but
// the "...Food Prod Sum..." variant (BombieFood, Hotel Food) drops the
// Size column and the %-of-Nett column entirely in favour of Gross and GST
// Total, while the "Prod Summ Weekly ..." variant (Bombies/Bshop/Hotel) has
// them. Detected from the header row rather than guessed from the filename.
//   with Size:    Product Name / Size Name / Qty Units Sold / NettTotal /
//                 % of NettTotal / CostEx of Sales / Profit Amt / Profit% /
//                 CostInc of Sales — individual rows always say "All Sizes"
//   without Size: Name / Units Sold / Gross / Nett Total / Costex of Sales /
//                 ProfitAmt / Profit% / GST Total / (formula column)
// costInc/pctOfNett aren't rendered anywhere downstream for these rows (only
// name/qty/nettTotal/profitPct/costEx are), so the no-Size shape leaves them
// at 0 rather than approximating a number nothing displays.
function parseWeeklyProductRows(workbook) {
  const sheet = findDataSheet(workbook);
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (!rows.length) return null;
  const header = (rows[0] || []).map(h => String(h || '').replace(/\s+/g, ' ').trim().toLowerCase());
  const hasSizeColumn = header.some(h => h === 'size name' || h === 'size');

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawName = r[0];
    if (typeof rawName !== 'string' || !rawName.trim()) continue;
    if (/^totals?\s*:/i.test(rawName) || /^type\s*:/i.test(rawName)) continue;

    if (hasSizeColumn) {
      if (r[1] !== 'All Sizes') continue; // per-type subtotal/category rows don't say "All Sizes"
      const qty = Number(r[2]);
      if (!Number.isFinite(qty)) continue;
      const name = cleanLeakedName(rawName.trim());
      if (name === null) continue;
      out.push({
        name,
        qty,
        nettTotal: round2(r[3]),
        pctOfNett: round2(Number(r[4]) * 100),
        costEx: round2(r[5]),
        profitAmt: round2(r[6]),
        profitPct: round2(Number(r[7]) * 100),
        costInc: round2(r[8]),
      });
    } else {
      const qty = Number(r[1]);
      if (!Number.isFinite(qty)) continue;
      const name = cleanLeakedName(rawName.trim());
      if (name === null) continue;
      out.push({
        name,
        qty,
        nettTotal: round2(r[3]),
        pctOfNett: 0,
        costEx: round2(r[4]),
        profitAmt: round2(r[5]),
        profitPct: round2(Number(r[6]) * 100),
        costInc: 0,
      });
    }
  }
  return out;
}

// Shape: Name/QtyTransactions/GrossSales/TotalDiscount/NettTotal/
// %ofNettTotal/CostOfSales/ProfitAmt/Profit%/DateTimeLastTrans.
function parseWeeklyStaffSalesRows(workbook) {
  const sheet = findDataSheet(workbook);
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawName = r[0];
    if (typeof rawName !== 'string' || !rawName.trim()) continue;
    if (/^totals?\s*:/i.test(rawName)) continue;
    const transactions = Number(r[1]);
    if (!Number.isFinite(transactions)) continue;
    const name = cleanLeakedName(rawName.trim());
    if (name === null) continue;
    out.push({
      name,
      transactions,
      grossSales: round2(r[2]),
      discount: round2(r[3]),
      nettTotal: round2(r[4]),
      pctOfNett: round2(Number(r[5]) * 100),
      costOfSales: round2(r[6]),
      profitAmt: round2(r[7]),
      profitPct: round2(Number(r[8]) * 100),
      lastTrans: r[9] ? String(r[9]) : '',
    });
  }
  return out;
}

// Bepoz's Stock Loss transaction log has one "header" row per loss event
// (Till/Operator/Comment, with the $ value in the "Transaction Total"
// column) followed by zero or more "product" sub-rows for the same
// transaction, which record Bepoz's own increment/decrement UI history for
// that event (e.g. qty 1, -1, 2, -2, 3... as someone adjusts the entry) —
// confirmed on real Harbord Hotel data these oscillate and do NOT net to a
// meaningful per-product quantity, so they're deliberately not used here.
// The header row's Transaction Total sums exactly to the report's own
// "Totals:" row Nett figure (verified to the cent on two real weeks), so
// it's the reliable per-event $ figure — grouped by Till and listed as the
// biggest individual events, which is the level a manager can actually act
// on (a keg that keeps going flat on Main Bar 1, a specific big write-off).
function parseStockLossRows(workbook) {
  const sheet = findDataSheet(workbook);
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (rows.length < 2) return null;
  const header = (rows[0] || []).map(h => String(h || '').replace(/\s+/g, ' ').trim().toLowerCase());
  if (!header[0].startsWith('date') || !header[3].startsWith('till')) return null; // unexpected layout

  const events = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[6]) continue; // product sub-row (Bepoz's UI adjustment history) — skip
    const transId = r[1];
    if (!transId || typeof transId !== 'number') continue; // "Totals:" row or blank
    const amount = round2(r[5]);
    events.push({
      date: r[0] ? String(r[0]) : '',
      till: (r[3] || '').toString().trim() || 'Unknown till',
      operator: (r[4] || '').toString().trim(),
      amount,
      comment: (r[12] || '').toString().trim(),
    });
  }
  if (!events.length) return null;

  const total = round2(events.reduce((s, e) => s + e.amount, 0));
  const byTillMap = new Map();
  events.forEach(e => {
    const cur = byTillMap.get(e.till) || { till: e.till, amount: 0, count: 0 };
    cur.amount += e.amount;
    cur.count++;
    byTillMap.set(e.till, cur);
  });
  const byTill = Array.from(byTillMap.values())
    .map(t => ({ ...t, amount: round2(t.amount) }))
    .sort((a, b) => b.amount - a.amount);
  const topEvents = events.slice().sort((a, b) => b.amount - a.amount).slice(0, 8);

  return { total, count: events.length, byTill, topEvents };
}

// Bepoz's "Manager Stockloss" export, despite the name, is a table/tab
// close-out list — every table tab closed with an unpaid balance written
// off as a loss (confirmed on real Harbord Hotel data: almost entirely
// comped manager/staff meals, free-text "Name" field like "MANAGERS MEALS",
// "STAFFY", with a lot of inconsistent spelling/typos). Individual reasons
// are too free-text to group exactly, so they're bucketed into Manager
// Meals / Staff Meals / Other by keyword, which the real data shows covers
// the large majority cleanly.
function classifyWriteoffReason(name) {
  const n = (name || '').toLowerCase();
  if (/manager/.test(n) || /\bman\b/.test(n)) return 'Manager meals';
  if (/staff/.test(n)) return 'Staff meals';
  return 'Other';
}
function parseTableWriteoffRows(workbook) {
  const sheet = findDataSheet(workbook);
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (rows.length < 2) return null;
  const header = (rows[0] || []).map(h => String(h || '').replace(/\s+/g, ' ').trim().toLowerCase());
  if (!header[1].startsWith('table number') && !header[1].startsWith('table')) return null; // unexpected layout

  const events = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[1] === 'Totals:') continue;
    const losses = Number(r[8]);
    if (!Number.isFinite(losses) || losses === 0) continue; // no write-off on this table
    const rawName = (r[10] || '').toString().trim();
    events.push({
      tableNumber: (r[1] || '').toString().trim(),
      dateOpened: r[2] ? String(r[2]) : '',
      amount: round2(losses),
      name: rawName || 'Unnamed',
      reason: classifyWriteoffReason(rawName),
      tableGroup: (r[14] || '').toString().trim() || 'Unknown',
    });
  }
  if (!events.length) return null;

  const total = round2(events.reduce((s, e) => s + e.amount, 0));
  const byReasonMap = new Map();
  events.forEach(e => {
    const cur = byReasonMap.get(e.reason) || { reason: e.reason, amount: 0, count: 0 };
    cur.amount += e.amount;
    cur.count++;
    byReasonMap.set(e.reason, cur);
  });
  const byReason = Array.from(byReasonMap.values())
    .map(r => ({ ...r, amount: round2(r.amount) }))
    .sort((a, b) => b.amount - a.amount);
  const topEvents = events.slice().sort((a, b) => b.amount - a.amount).slice(0, 8);

  return { total, count: events.length, byReason, topEvents };
}

// Bulk Beer Litres: a straightforward per-product report (revenue, cost,
// litres sold, supplier) — same shape family as parseWeeklyProductRows but
// with its own column layout (no Size/qty-transaction columns, litres
// instead).
function parseBulkBeerRows(workbook) {
  const sheet = findDataSheet(workbook);
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (rows.length < 2) return null;
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawName = r[0];
    if (typeof rawName !== 'string' || !rawName.trim() || /^totals?\s*:/i.test(rawName)) continue;
    const litresSold = Number(r[5]);
    if (!Number.isFinite(litresSold)) continue;
    const name = cleanLeakedName(rawName.trim());
    if (name === null) continue;
    const nettTotal = round2(r[3]);
    const costEx = round2(r[4]);
    out.push({
      name,
      litresSold: round2(litresSold),
      nettTotal,
      costEx,
      profitAmt: round2(nettTotal - costEx),
      profitPct: nettTotal > 0 ? round2((nettTotal - costEx) / nettTotal * 100) : 0,
      supplier: (r[6] || '').toString().trim(),
    });
  }
  return out;
}

/* ── Staff Roster (generic template) ─────────────────────────────────────── */
// Not a Bepoz export at all — a plain staff list (role/department/hours)
// the operator maintains themselves, or eventually a direct FoundU export
// mapped onto this same shape. Detected from its own header row rather than
// Bepoz's Venue:/Store: Criteria-sheet model, which a roster file has no
// reason to follow. Joined onto the weekly Staff Sales leaderboard by name
// (case-insensitive) at render time — see matchRosterEntry() below — rather
// than folded into a venue while files are still being read, since a
// roster's usefulness doesn't depend on which venue(s) it's read alongside.
const ROSTER_HEADER_ALIASES = {
  name: ['name', 'staff name', 'employee name', 'employee'],
  role: ['role', 'position', 'job title', 'job role'],
  department: ['department', 'dept', 'store', 'area', 'section'],
  hours: ['hours', 'hours worked', 'hours this week', 'total hours', 'hrs', 'hrs worked'],
  venue: ['venue', 'site', 'location'],
};

// Requires a Name column PLUS at least one of Role/Department/Hours — a bare
// "Name" column alone (e.g. the weekly Staff Sales report's own header) is
// too generic to safely claim as a roster file.
function detectRosterSheet(workbook) {
  if (!workbook) return null;
  for (const sheetName of workbook.SheetNames) {
    if (/^criteria/i.test(sheetName) || sheetName === 'ValueList_Helper') continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
    if (!rows.length) continue;
    const header = (rows[0] || []).map(h => String(h || '').replace(/\s+/g, ' ').trim().toLowerCase());
    const findCol = aliases => header.findIndex(h => aliases.includes(h));
    const nameIdx = findCol(ROSTER_HEADER_ALIASES.name);
    if (nameIdx < 0) continue;
    const roleIdx = findCol(ROSTER_HEADER_ALIASES.role);
    const deptIdx = findCol(ROSTER_HEADER_ALIASES.department);
    const hoursIdx = findCol(ROSTER_HEADER_ALIASES.hours);
    if (roleIdx < 0 && deptIdx < 0 && hoursIdx < 0) continue;
    const venueIdx = findCol(ROSTER_HEADER_ALIASES.venue);
    return { rows, nameIdx, roleIdx, deptIdx, hoursIdx, venueIdx };
  }
  return null;
}

function parseRosterRows(workbook) {
  const sheet = detectRosterSheet(workbook);
  if (!sheet) return null;
  const { rows, nameIdx, roleIdx, deptIdx, hoursIdx, venueIdx } = sheet;
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawName = r[nameIdx];
    if (typeof rawName !== 'string' || !rawName.trim()) continue;
    const roleRaw = roleIdx >= 0 ? String(r[roleIdx] || '').trim() : '';
    const hoursRaw = hoursIdx >= 0 ? Number(r[hoursIdx]) : NaN;
    out.push({
      name: rawName.trim(),
      role: roleRaw || 'Staff',
      // Blank department is meaningful, not missing data — it's how a
      // Manager (or anyone who floats across departments rather than having
      // one fixed one) is represented in this template.
      department: deptIdx >= 0 ? String(r[deptIdx] || '').trim() : '',
      hours: Number.isFinite(hoursRaw) && hoursRaw > 0 ? round2(hoursRaw) : null,
      venue: venueIdx >= 0 ? String(r[venueIdx] || '').trim() : '',
    });
  }
  return out;
}

// A name can appear more than once across roster rows — most operators will
// only ever have one row per person, but a multi-venue upload might list the
// same person twice with different Venue values. Prefer whichever entry's
// Venue matches the venue being rendered, falling back to the first.
function matchRosterEntry(rosterByName, name, venueName) {
  const entries = rosterByName[String(name || '').toLowerCase().trim()];
  if (!entries || !entries.length) return null;
  if (entries.length === 1) return entries[0];
  const vn = String(venueName || '').toLowerCase();
  return entries.find(e => e.venue && vn.includes(e.venue.toLowerCase())) || entries[0];
}

function isManagerRole(role) {
  return /manager|supervisor|duty mgr/i.test(role || '');
}

/* ── Daily Period Summary parsing ────────────────────────────────────────── */
// Bepoz's Period Summary export lays four independent tables (Stock, Sales,
// Discount, Product Sortgroup) out side by side in one sheet. Flattening
// joins them row by row, which scrambles the columns together, but every
// figure below is still uniquely labelled, so label-anchored regexes — not
// row position — pull them out reliably. Some rows (e.g. Pricing Variance)
// are omitted entirely by Bepoz on a $0 day, so nothing here assumes a fixed
// layout or that every field is present.
function moneyAfter(text, labelPattern) {
  const re = new RegExp(labelPattern + '\\s*:?\\s*\\$?(-?[\\d,]+\\.\\d{2})', 'i');
  const m = text.match(re);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function parsePeriodSummary(text) {
  const grossSales   = moneyAfter(text, 'Gross Sales');
  const nettTotal    = moneyAfter(text, 'Nett Total');
  // Negative lookahead so "Cost of Sales Adjusted" doesn't get matched by
  // the plain "Cost of Sales" search.
  const costOfSales  = moneyAfter(text, 'Cost of Sales(?!\\s*Adjusted)');

  const profitM = text.match(/\bProfit(?!\s*Adjusted)\s*:?\s*(-?[\d.]+)%\s*\$?(-?[\d,]+\.\d{2})/i);
  const profitPct = profitM ? parseFloat(profitM[1]) : null;
  const profitAmt = profitM ? parseFloat(profitM[2].replace(/,/g, '')) : null;

  const bankedTotal = moneyAfter(text, 'Banked Total');
  const drawerM = text.match(/Drawer Tot\s*:?\s*\$?(-?[\d,]+\.\d{2})\s*\$?(-?[\d,]+\.\d{2})/i);
  const drawerCounted     = drawerM ? parseFloat(drawerM[1].replace(/,/g, '')) : null;
  const drawerTheoretical = drawerM ? parseFloat(drawerM[2].replace(/,/g, '')) : null;

  // The sign is already on the number ("-$22.40"); the trailing Over/Under
  // word is a redundant label, not needed to read the direction.
  const diffM = text.match(/\bDifference\s*:?\s*(-?)\$?([\d,]+\.\d{2})/i);
  const difference = diffM ? (diffM[1] ? -1 : 1) * parseFloat(diffM[2].replace(/,/g, '')) : null;

  if (nettTotal === null) return null; // no Sales Summary found — not a usable report
  return { grossSales, nettTotal, costOfSales, profitPct, profitAmt, bankedTotal, drawerCounted, drawerTheoretical, difference };
}

// The Discount Totals table is a genuine exception to "everything is
// label-anchored regex on flattened text": it's a repeating list of ~20-30
// rows (one per discount/pricing-variance reason configured in Bepoz — the
// exact reasons, their wording, and how many fire on a given day all vary
// by venue and even by store, confirmed on real Harbord Hotel data), sitting
// in its own column block next to three unrelated tables that share the
// same rows. Flattening interleaves all four tables' cells row by row, which
// destroys any way to tell where one reason's label/qty/amount ends and the
// next table's unrelated cell begins. So this reads the workbook directly:
// find the "DISCOUNT TOTALS:" header cell, then walk straight down its
// column (label, qty, amount) until the label cell goes blank — that blank
// is the real end of the table, not a fixed row count.
function parseDiscounts(workbook) {
  if (!workbook) return null; // not available for PDF Period Summaries
  for (const sn of workbook.SheetNames) {
    if (/^criteria/i.test(sn)) continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sn], { header: 1, defval: '', raw: false });
    if (!rows.length) continue;
    const header = rows[0];
    const discCol = header.findIndex(c => String(c).trim().toUpperCase() === 'DISCOUNT TOTALS:');
    if (discCol < 0) continue;

    const items = [];
    for (let i = 1; i < rows.length; i++) {
      const label = rows[i][discCol];
      if (!label || !String(label).trim()) break;
      const cleanLabel = String(label).trim();
      // Pricing Variance isn't a discount reason — it's Bepoz's own rollup
      // row, always equal to the sum of every other row in this table
      // (confirmed exactly on real Harbord Hotel data: e.g. Main Bar's
      // Pricing Variance of -$1,356.15 matched its other 8 reasons' total
      // to the cent). Including it double-counts the "total discounted"
      // figure and makes it look responsible for ~50% of all discounts by
      // definition, not because it's actually a reason anyone chose.
      if (/^pricing variance$/i.test(cleanLabel)) continue;
      const qty = parseInt(String(rows[i][discCol + 1]).replace(/,/g, ''), 10) || 0;
      const amount = parseFloat(String(rows[i][discCol + 2] || '').replace(/[$,]/g, '')) || 0;
      if (qty === 0 && amount === 0) continue; // reason didn't fire this day
      items.push({ label: cleanLabel, qty, amount });
    }
    return { items };
  }
  return null; // this workbook's data sheet has no Discount Totals column
}

// Rolls a store's per-day discount breakdowns up into one ranked list for
// the whole period, and expresses the total against gross sales as a rough
// "discount rate" — the cleanest honest read on margin impact available
// here, since Bepoz doesn't expose a clean per-reason link to Nett/Profit.
function aggregateDiscounts(days) {
  const byLabel = {};
  let grossTotal = 0;
  let sawAny = false;
  days.forEach(d => {
    if (d.grossSales) grossTotal += d.grossSales;
    if (!d.discounts || !d.discounts.items) return;
    sawAny = true;
    d.discounts.items.forEach(it => {
      byLabel[it.label] = byLabel[it.label] || { label: it.label, qty: 0, amount: 0 };
      byLabel[it.label].qty += it.qty;
      byLabel[it.label].amount += it.amount;
    });
  });
  if (!sawAny) return null;
  const rows = Object.values(byLabel).filter(r => r.amount !== 0 || r.qty !== 0)
    .sort((a, b) => a.amount - b.amount); // most negative (biggest giveaway) first
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const pctOfGross = grossTotal > 0 ? Math.abs(total) / grossTotal * 100 : null;
  return { rows, total, pctOfGross };
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

// Flattens every cell in the workbook — including each sheet's own NAME —
// into one continuous space-joined string, the same shape extractPDFText
// produces for a page (content.items.map(i => i.str).join(' ')). This
// matters because classifyReport/extractField/extractTitle/extractShiftDate
// are all regex-scanned against that flattened shape and can't cross a
// newline; a plain sheet_to_csv() export (one row per line) breaks them,
// because Bepoz's XLSX exports split a report across two sheets — the data
// sheet (whose NAME is the report title, e.g. "Bombie Food Time Break Yst
// REV" — that title never appears in any cell) and a second "Criteria ..."
// sheet several rows deep holding Venue/Store/Display Period — so the title
// and the Venue: field a classifier needs are never on the same CSV line.
// Flattening the whole workbook into one line reunites them, exactly as a
// PDF page already does.
// Returns both the flattened text (used everywhere else in the app) and the
// parsed workbook itself — parseDiscounts needs the real rows/columns of the
// sheet, which flattening destroys (see its comment for why).
async function extractXLSXText(file) {
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: 'array' });
  let out   = '';
  wb.SheetNames.forEach(sn => {
    out += sn + ' ';
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '', raw: false });
    rows.forEach(row => {
      row.forEach(cell => {
        const s = String(cell).replace(/\r?\n/g, ' ').trim();
        if (s) out += s + ' ';
      });
    });
  });
  return { text: out, workbook: wb };
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

/* ── Weekly ops rendering ─────────────────────────────────────────────────── */
function weekLabel(entry) {
  return `${fmtDate(entry.weekStart)} – ${fmtDate(entry.weekEnd)}`;
}

// Picks the most recently ending week from a list of same-category weekly
// report entries — the UI shows one week of detail at a time.
function latestWeek(entries) {
  return entries.slice().sort((a, b) => b.weekEnd - a.weekEnd)[0];
}

function staffLeaderboardHTML(entries, rosterByName = {}, venueName = '') {
  if (!entries.length) return '';
  const week = latestWeek(entries);
  const rows = week.rows.slice().sort((a, b) => b.nettTotal - a.nettTotal);
  const avgProfitPct = rows.reduce((s, r) => s + r.profitPct, 0) / rows.length;

  // Role/Department columns only appear once a roster file has actually been
  // joined to at least one name this week — an all-dash pair of columns for
  // every venue that hasn't uploaded one yet would just be visual noise.
  const rosterTags = rows.map(r => matchRosterEntry(rosterByName, r.name, venueName));
  const hasRoster = rosterTags.some(Boolean);

  const tableRows = rows.map((r, i) => `
    <tr>
      <td>${r.name}</td>
      ${hasRoster ? `<td>${rosterTags[i] ? rosterTags[i].role : '—'}</td><td>${rosterTags[i] ? (rosterTags[i].department || '—') : '—'}</td>` : ''}
      <td class="num">${r.transactions}</td>
      <td class="num">${cur(r.nettTotal)}</td>
      <td class="num">${r.profitPct.toFixed(0)}%</td>
    </tr>`).join('');

  const outliers = rows.filter(r => r.transactions >= 10 && r.profitPct < avgProfitPct - 15);
  const flags = outliers.length
    ? `<div class="flag warn"><span class="flag-icon">⚠</span><span>${outliers.map(r => `<strong>${r.name}</strong> (${r.profitPct.toFixed(0)}% profit vs team avg ${avgProfitPct.toFixed(0)}%)`).join(', ')} — worth checking discounting/comps on these shifts</span></div>`
    : '';

  return `<div class="result-card">
    <div class="card-label">Staff performance — week of ${weekLabel(week)}${entries.length > 1 ? ` <span class="powered-by">${entries.length} weeks uploaded, showing latest</span>` : ''}</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Name</th>${hasRoster ? '<th>Role</th><th>Department</th>' : ''}<th class="num">Txns</th><th class="num">Nett sales</th><th class="num">Profit %</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
    ${flags}
  </div>`;
}

// Revenue-per-labour-hour by department — only rendered once a roster file
// with usable Hours has actually joined to at least one of this week's
// leaderboard rows. Deliberately NOT a labour-cost-% metric (that needs pay
// rates, which weren't part of the roster template by design).
function staffProductivityHTML(entries, rosterByName = {}, venueName = '') {
  if (!entries.length) return '';
  const week = latestWeek(entries);
  const rows = week.rows;
  const joined = rows.map(r => ({ r, roster: matchRosterEntry(rosterByName, r.name, venueName) }));
  const withHours = joined.filter(j => j.roster && j.roster.hours);
  if (!withHours.length) return '';

  const byDept = new Map();
  withHours.forEach(({ r, roster }) => {
    const dept = roster.department || (isManagerRole(roster.role) ? 'Management / floating' : 'Unassigned department');
    const agg = byDept.get(dept) || { dept, revenue: 0, hours: 0 };
    agg.revenue += r.nettTotal;
    agg.hours += roster.hours;
    byDept.set(dept, agg);
  });
  const deptRows = Array.from(byDept.values())
    .map(d => ({ ...d, perHour: d.hours > 0 ? d.revenue / d.hours : 0 }))
    .sort((a, b) => b.perHour - a.perHour);

  const totalRevenue = withHours.reduce((s, { r }) => s + r.nettTotal, 0);
  const totalHours = withHours.reduce((s, { roster }) => s + roster.hours, 0);
  const overallPerHour = totalHours > 0 ? totalRevenue / totalHours : 0;

  const tableRows = deptRows.map(d => `
    <tr>
      <td>${d.dept}</td>
      <td class="num">${d.hours.toFixed(1)}</td>
      <td class="num">${cur(d.revenue)}</td>
      <td class="num">${cur(d.perHour)}</td>
    </tr>`).join('');

  const laggards = deptRows.filter(d => d.hours >= 4 && d.perHour < overallPerHour * 0.7);
  const flags = laggards.length
    ? `<div class="flag warn"><span class="flag-icon">⚠</span><span>${laggards.map(d => `<strong>${d.dept}</strong> (${cur(d.perHour)}/hour vs venue avg ${cur(overallPerHour)}/hour)`).join(', ')} — well below average revenue per labour hour, worth checking rostering against demand</span></div>`
    : '';

  const unmatched = rows.length - withHours.length;

  return `<div class="result-card">
    <div class="card-label">Revenue per labour hour — week of ${weekLabel(week)}${entries.length > 1 ? ` <span class="powered-by">${entries.length} weeks uploaded, showing latest</span>` : ''}</div>
    <div class="metric-value">${cur(overallPerHour)}/hr</div>
    <div class="metric-sub">${withHours.length} of ${rows.length} staff on the leaderboard matched to roster hours${unmatched ? ` · ${unmatched} not matched (add them to your roster file for a complete picture)` : ''}</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Department</th><th class="num">Hours</th><th class="num">Revenue</th><th class="num">Revenue / hour</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
    ${flags}
  </div>`;
}

function cogsHTML(entries) {
  if (!entries.length) return '';
  const week = latestWeek(entries);
  const rows = week.rows.slice().sort((a, b) => b.nettTotal - a.nettTotal);
  const totalNett = rows.reduce((s, r) => s + r.nettTotal, 0);
  const totalProfit = rows.reduce((s, r) => s + r.profitAmt, 0);
  const overallProfitPct = totalNett > 0 ? totalProfit / totalNett * 100 : 0;

  const tableRows = rows.map(r => `
    <tr>
      <td>${r.name}</td>
      <td class="num">${cur(r.nettTotal)}</td>
      <td class="num">${cur(r.costEx)}</td>
      <td class="num">${r.profitPct.toFixed(0)}%</td>
    </tr>`).join('');

  const lowMargin = rows.filter(r => r.nettTotal > totalNett * 0.02 && r.profitPct < overallProfitPct - 15);
  const flags = lowMargin.length
    ? `<div class="flag warn"><span class="flag-icon">⚠</span><span>${lowMargin.map(r => `<strong>${r.name}</strong> (${r.profitPct.toFixed(0)}% margin)`).join(', ')} running well below the week's overall ${overallProfitPct.toFixed(0)}% margin — worth a pricing/cost review</span></div>`
    : '';

  return `<div class="result-card">
    <div class="card-label">Margin by category — week of ${weekLabel(week)}${entries.length > 1 ? ` <span class="powered-by">${entries.length} weeks uploaded, showing latest</span>` : ''}</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Category</th><th class="num">Nett sales</th><th class="num">Cost of sales</th><th class="num">Margin</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
    ${flags}
  </div>`;
}

function productMixHTML(entries, storeLabel) {
  if (!entries.length) return '';
  const week = latestWeek(entries);
  const rows = week.rows;
  const topSellers = rows.slice().sort((a, b) => b.nettTotal - a.nettTotal).slice(0, 12);
  const titleSuffix = storeLabel ? ` — ${storeLabel}` : '';

  // High-volume items (top 40 by qty) with weak margins — worth a pricing
  // look, as distinct from just-plain-slow sellers. $0-revenue rows are
  // free modifiers/instructions (e.g. "Medium Rare", "Free Text"), not
  // priced products, so they're excluded — a 0% margin on $0 isn't a
  // pricing signal.
  const byQty = rows.filter(r => r.nettTotal > 0).sort((a, b) => b.qty - a.qty).slice(0, 40);
  const weakMargin = byQty.filter(r => r.profitPct < 60).sort((a, b) => a.profitPct - b.profitPct).slice(0, 6);

  const sellerRows = topSellers.map(r => `
    <tr>
      <td>${r.name}</td>
      <td class="num">${r.qty % 1 === 0 ? r.qty : r.qty.toFixed(1)}</td>
      <td class="num">${cur(r.nettTotal)}</td>
      <td class="num">${r.profitPct.toFixed(0)}%</td>
    </tr>`).join('');

  const flags = weakMargin.length
    ? `<div class="flag warn"><span class="flag-icon">⚠</span><span>High-volume, lower-margin: ${weakMargin.map(r => `<strong>${r.name}</strong> (${r.profitPct.toFixed(0)}%)`).join(', ')} — worth a pricing review since these move a lot of stock</span></div>`
    : '';

  return `<div class="result-card">
    <div class="card-label">Top sellers${titleSuffix} — week of ${weekLabel(week)}${entries.length > 1 ? ` <span class="powered-by">${entries.length} weeks uploaded, showing latest</span>` : ''}</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Nett sales</th><th class="num">Margin</th></tr></thead>
      <tbody>${sellerRows}</tbody>
    </table></div>
    ${flags}
  </div>`;
}

function weekTrendHTML(current, previous, label) {
  if (previous === undefined || previous === null || previous === 0) return '';
  const pct = (current - previous) / previous * 100;
  if (Math.abs(pct) < 1) return '';
  const dir = pct > 0 ? 'up' : 'down';
  return ` <span class="powered-by">${dir} ${Math.abs(pct).toFixed(0)}% vs prior week's ${cur(previous)} ${label}</span>`;
}

function stockLossHTML(entries) {
  if (!entries.length) return '';
  const sorted = entries.slice().sort((a, b) => b.weekEnd - a.weekEnd);
  const week = sorted[0];
  const prior = sorted[1];
  const d = week.data;

  const tillRows = d.byTill.map(t => `
    <tr>
      <td>${t.till}</td>
      <td class="num">${t.count}</td>
      <td class="num">${cur(t.amount)}</td>
    </tr>`).join('');

  const eventRows = d.topEvents.map(e => `
    <tr>
      <td>${e.date.slice(0, 10)}</td>
      <td>${e.till}</td>
      <td>${e.comment || '—'}</td>
      <td class="num">${cur(e.amount)}</td>
    </tr>`).join('');

  return `<div class="result-card">
    <div class="card-label">Stock loss — week of ${weekLabel(week)}${entries.length > 1 ? ` <span class="powered-by">${entries.length} weeks uploaded, showing latest</span>` : ''}</div>
    <div class="metric-value">${cur(d.total)}</div>
    <div class="metric-sub">${d.count} loss event${d.count === 1 ? '' : 's'} across ${d.byTill.length} till${d.byTill.length === 1 ? '' : 's'}${prior ? weekTrendHTML(d.total, prior.data.total, 'total') : ''}</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Till</th><th class="num">Events</th><th class="num">$ lost</th></tr></thead>
      <tbody>${tillRows}</tbody>
    </table></div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Till</th><th>Reason</th><th class="num">$ lost</th></tr></thead>
      <tbody>${eventRows}</tbody>
    </table></div>
  </div>`;
}

function tableWriteoffsHTML(entries) {
  if (!entries.length) return '';
  const sorted = entries.slice().sort((a, b) => b.weekEnd - a.weekEnd);
  const week = sorted[0];
  const prior = sorted[1];
  const d = week.data;

  const reasonRows = d.byReason.map(r => `
    <tr>
      <td>${r.reason}</td>
      <td class="num">${r.count}</td>
      <td class="num">${cur(r.amount)}</td>
    </tr>`).join('');

  const eventRows = d.topEvents.map(e => `
    <tr>
      <td>${e.dateOpened.slice(0, 10)}</td>
      <td>${e.tableNumber}</td>
      <td>${e.name}</td>
      <td class="num">${cur(e.amount)}</td>
    </tr>`).join('');

  return `<div class="result-card">
    <div class="card-label">Comps &amp; write-offs — week of ${weekLabel(week)}${entries.length > 1 ? ` <span class="powered-by">${entries.length} weeks uploaded, showing latest</span>` : ''}</div>
    <div class="metric-value">${cur(d.total)}</div>
    <div class="metric-sub">${d.count} table${d.count === 1 ? '' : 's'} written off${prior ? weekTrendHTML(d.total, prior.data.total, 'total') : ''}</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Reason</th><th class="num">Tables</th><th class="num">$ written off</th></tr></thead>
      <tbody>${reasonRows}</tbody>
    </table></div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Table</th><th>Name / note</th><th class="num">$ written off</th></tr></thead>
      <tbody>${eventRows}</tbody>
    </table></div>
  </div>`;
}

function bulkBeerHTML(entries) {
  if (!entries.length) return '';
  const week = latestWeek(entries);
  const rows = week.rows.slice().sort((a, b) => b.litresSold - a.litresSold).slice(0, 12);
  const totalLitres = week.rows.reduce((s, r) => s + r.litresSold, 0);
  const totalNett = week.rows.reduce((s, r) => s + r.nettTotal, 0);
  const totalCost = week.rows.reduce((s, r) => s + r.costEx, 0);
  const overallMargin = totalNett > 0 ? (totalNett - totalCost) / totalNett * 100 : 0;

  const tableRows = rows.map(r => `
    <tr>
      <td>${r.name}</td>
      <td class="num">${r.litresSold.toFixed(1)}L</td>
      <td class="num">${cur(r.nettTotal)}</td>
      <td class="num">${r.profitPct.toFixed(0)}%</td>
    </tr>`).join('');

  return `<div class="result-card">
    <div class="card-label">Bulk beer — week of ${weekLabel(week)}${entries.length > 1 ? ` <span class="powered-by">${entries.length} weeks uploaded, showing latest</span>` : ''}</div>
    <div class="metric-value">${totalLitres.toFixed(0)}L</div>
    <div class="metric-sub">${cur(totalNett)} nett · ${overallMargin.toFixed(0)}% blended margin</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Product</th><th class="num">Litres sold</th><th class="num">Nett sales</th><th class="num">Margin</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
  </div>`;
}

/* ── Weekly ops totals (aggregated across every uploaded week) ─────────────── */
function weekRangeLabel(entries) {
  const sorted = entries.slice().sort((a, b) => a.weekStart - b.weekStart);
  const first = sorted[0], last = sorted[sorted.length - 1];
  return `${fmtDate(first.weekStart)} – ${fmtDate(last.weekEnd)}`;
}

// Sums nettTotal/profitAmt (plus whatever extra fields are asked for, e.g.
// transactions or qty) across every week's rows, grouped by name. profitPct
// is deliberately NOT averaged row-by-row — instead a blended margin is
// derived from the summed dollar figures at render time, same as the
// single-week cards above (see cogsHTML's overallProfitPct).
function aggregateRows(entries, extraFields) {
  const byName = new Map();
  entries.forEach(week => {
    week.rows.forEach(r => {
      const agg = byName.get(r.name) || { name: r.name, nettTotal: 0, profitAmt: 0, ...Object.fromEntries(extraFields.map(f => [f, 0])) };
      agg.nettTotal += r.nettTotal;
      agg.profitAmt += r.profitAmt;
      extraFields.forEach(f => { agg[f] += r[f] || 0; });
      byName.set(r.name, agg);
    });
  });
  return Array.from(byName.values());
}

function blendedProfitPct(r) {
  return r.nettTotal > 0 ? r.profitAmt / r.nettTotal * 100 : 0;
}

function staffTotalsHTML(entries) {
  if (entries.length < 2) return '';
  const weeks = entries.length;
  const rows = aggregateRows(entries, ['transactions']).sort((a, b) => b.nettTotal - a.nettTotal);

  const tableRows = rows.map(r => `
    <tr>
      <td>${r.name}</td>
      <td class="num">${r.transactions}</td>
      <td class="num">${cur(r.nettTotal)}</td>
      <td class="num">${cur(r.nettTotal / weeks)}</td>
      <td class="num">${blendedProfitPct(r).toFixed(0)}%</td>
    </tr>`).join('');

  return `<div class="result-card">
    <div class="card-label">Staff performance — ${weeks}-week total (${weekRangeLabel(entries)})</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Name</th><th class="num">Total txns</th><th class="num">Total nett</th><th class="num">Avg/week</th><th class="num">Profit %</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
  </div>`;
}

function cogsTotalsHTML(entries) {
  if (entries.length < 2) return '';
  const weeks = entries.length;
  const rows = aggregateRows(entries, []).sort((a, b) => b.nettTotal - a.nettTotal);

  const tableRows = rows.map(r => `
    <tr>
      <td>${r.name}</td>
      <td class="num">${cur(r.nettTotal)}</td>
      <td class="num">${cur(r.nettTotal / weeks)}</td>
      <td class="num">${blendedProfitPct(r).toFixed(0)}%</td>
    </tr>`).join('');

  return `<div class="result-card">
    <div class="card-label">Margin by category — ${weeks}-week total (${weekRangeLabel(entries)})</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Category</th><th class="num">Total nett</th><th class="num">Avg/week</th><th class="num">Margin</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
  </div>`;
}

function productTotalsHTML(entries, storeLabel) {
  if (entries.length < 2) return '';
  const weeks = entries.length;
  const rows = aggregateRows(entries, ['qty']);
  const topSellers = rows.slice().sort((a, b) => b.nettTotal - a.nettTotal).slice(0, 12);
  const titleSuffix = storeLabel ? ` — ${storeLabel}` : '';

  const tableRows = topSellers.map(r => `
    <tr>
      <td>${r.name}</td>
      <td class="num">${r.qty % 1 === 0 ? r.qty : r.qty.toFixed(1)}</td>
      <td class="num">${cur(r.nettTotal)}</td>
      <td class="num">${cur(r.nettTotal / weeks)}</td>
      <td class="num">${blendedProfitPct(r).toFixed(0)}%</td>
    </tr>`).join('');

  return `<div class="result-card">
    <div class="card-label">Top sellers${titleSuffix} — ${weeks}-week total (${weekRangeLabel(entries)})</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Product</th><th class="num">Total qty</th><th class="num">Total nett</th><th class="num">Avg/week</th><th class="num">Margin</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
  </div>`;
}

/* ── Daily Period Summary rendering ──────────────────────────────────────── */
// A till variance under $5 is normal float/rounding noise, not worth
// flagging — only genuine short/over discrepancies surface as a warning.
const TILL_VARIANCE_THRESHOLD = 5;

function periodSummaryHTML(storeEntry) {
  const days = Object.values(storeEntry.byDate).sort((a, b) => b.date - a.date);
  if (!days.length) return '';

  const fmtMoney = v => v === null || v === undefined ? '—' : cur(v);

  const tableRows = days.map(d => {
    const flagged = d.difference !== null && Math.abs(d.difference) >= TILL_VARIANCE_THRESHOLD;
    const varCell = d.difference === null ? '—' :
      `${cur(d.difference)}${flagged ? ' <span class="flag-icon" title="Counted ' + fmtMoney(d.drawerCounted) + ' vs theoretical ' + fmtMoney(d.drawerTheoretical) + '">⚠</span>' : ''}`;
    return `
    <tr>
      <td>${fmtDate(d.date)}</td>
      <td class="num">${fmtMoney(d.grossSales)}</td>
      <td class="num">${fmtMoney(d.nettTotal)}</td>
      <td class="num">${fmtMoney(d.costOfSales)}</td>
      <td class="num">${fmtMoney(d.profitAmt)}</td>
      <td class="num">${d.profitPct !== null ? d.profitPct.toFixed(0) + '%' : '—'}</td>
      <td class="num">${varCell}</td>
    </tr>`;
  }).join('');

  const flaggedDays = days.filter(d => d.difference !== null && Math.abs(d.difference) >= TILL_VARIANCE_THRESHOLD);
  const flags = flaggedDays.length
    ? `<div class="flag warn"><span class="flag-icon">⚠</span><span>${flaggedDays.length} day${flaggedDays.length === 1 ? '' : 's'} with a till variance of ${cur(TILL_VARIANCE_THRESHOLD)} or more: ${flaggedDays.map(d => `${fmtDate(d.date)} (${d.difference < 0 ? 'short' : 'over'} ${cur(Math.abs(d.difference))})`).join(', ')} — worth checking against the banking record</span></div>`
    : '';

  return `<div class="result-card">
    <div class="card-label">Daily sales &amp; margin — ${storeEntry.label}</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th class="num">Gross sales</th><th class="num">Nett sales</th><th class="num">Cost of sales</th><th class="num">Profit</th><th class="num">Margin</th><th class="num">Till variance</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
    ${flags}
  </div>`;
}

function discountBreakdownHTML(storeEntry) {
  const agg = aggregateDiscounts(Object.values(storeEntry.byDate));
  if (!agg) return ''; // no discount data available for this store this period (e.g. PDF Period Summaries)

  if (!agg.rows.length) {
    return `<div class="result-card">
    <div class="card-label">Discounts — ${storeEntry.label}</div>
    <div class="metric-sub">No discounts recorded this period.</div>
  </div>`;
  }

  const tableRows = agg.rows.map(r => `
    <tr>
      <td>${r.label}</td>
      <td class="num">${r.qty}</td>
      <td class="num">${cur(r.amount)}</td>
      <td class="num">${agg.total !== 0 ? (r.amount / agg.total * 100).toFixed(0) + '%' : '—'}</td>
    </tr>`).join('');

  return `<div class="result-card">
    <div class="card-label">Discounts — ${storeEntry.label}</div>
    <div class="metric-sub">${cur(Math.abs(agg.total))} given away over the period${agg.pctOfGross !== null ? ` — ${agg.pctOfGross.toFixed(1)}% of gross sales` : ''}</div>
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Reason</th><th class="num">Qty</th><th class="num">Amount</th><th class="num">% of total</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
  </div>`;
}

/* ── Venue narrative prompt ──────────────────────────────────────────────── */
function buildPrompt(venueName, primary, headlineLabel, categoryStats, subVenues, weekly, periodSummary, rosterByName = {}) {
  const catLines = categoryStats.map(c =>
    `- ${CATEGORY_LABELS[c.key] || c.key}: total ${cur(c.stats.total)} over ${c.stats.days.length} days, daily avg ${cur(c.stats.avg)}`
  ).join('\n');

  const subLines = subVenues.map(sv => {
    const s = computeStats(sv.byDate);
    return s ? `- ${sv.label} (${sv.category}): total ${cur(s.total)} over ${s.days.length} days, daily avg ${cur(s.avg)}` : '';
  }).filter(Boolean).join('\n');

  let dailySection = '';
  if (primary) {
    const headline = primary.stats;
    const peakByDow = DAYS.map((day, dw) => {
      const top = headline.avgByDow[dw].map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)[0];
      return top && top.v > 0 ? day + ' peaks at ' + HOUR_LABELS[top.i] + ' (avg ' + cur(top.v) + ')' : '';
    }).filter(Boolean).join(' | ');

    dailySection = `
Daily trading — revenue by category:
${catLines}
${subLines ? '\nSub-venues / satellite bars:\n' + subLines : ''}

Hourly pattern is based on ${headlineLabel}:
- Daily average: ${cur(headline.avg)} | Best day: ${headline.best ? fmtDate(headline.best.date)+' '+cur(headline.best.total) : 'n/a'} | Worst: ${headline.worst ? fmtDate(headline.worst.date)+' '+cur(headline.worst.total) : 'n/a'}
- Top 3 days: ${headline.topDays.map(d => fmtDate(d.date)+' '+cur(d.total)).join(', ')}
- Bottom 3 days: ${headline.botDays.map(d => fmtDate(d.date)+' '+cur(d.total)).join(', ')}
- Day of week averages: ${DAYS.map((d, i) => d+': '+cur(headline.avgDayTotal[i])+' ('+headline.countByDow[i]+'d)').join(' | ')}
- Peak trading hour: ${HOUR_LABELS[headline.peakIdx]} | Quietest active: ${headline.deadIdx >= 0 ? HOUR_LABELS[headline.deadIdx] : 'n/a'}
- Peak hour by day of week: ${peakByDow}`;
  }

  let weeklySection = '';
  const productMixStoreKeys = weekly ? Object.keys(weekly.productMix || {}) : [];
  if (weekly && (weekly.staffSales.length || weekly.cogs.length || productMixStoreKeys.length
      || weekly.stockLoss.length || weekly.tableWriteoffs.length || weekly.bulkBeer.length)) {
    const parts = [];
    if (weekly.staffSales.length) {
      const w = latestWeek(weekly.staffSales);
      const rows = w.rows.slice().sort((a, b) => b.nettTotal - a.nettTotal);
      const avgProfitPct = rows.reduce((s, r) => s + r.profitPct, 0) / rows.length;
      parts.push(`Staff performance, week of ${weekLabel(w)} (team avg profit margin ${avgProfitPct.toFixed(0)}%):\n` +
        rows.slice(0, 8).map(r => {
          const roster = matchRosterEntry(rosterByName, r.name, venueName);
          const tag = roster ? ` [${roster.role}${roster.department ? ', ' + roster.department : ''}]` : '';
          return `- ${r.name}${tag}: ${cur(r.nettTotal)} nett across ${r.transactions} transactions, ${r.profitPct.toFixed(0)}% profit margin`;
        }).join('\n'));
      if (weekly.staffSales.length > 1) {
        const weeks = weekly.staffSales.length;
        const totals = aggregateRows(weekly.staffSales, ['transactions']).sort((a, b) => b.nettTotal - a.nettTotal);
        parts.push(`Staff performance, ${weeks}-week total (${weekRangeLabel(weekly.staffSales)}):\n` +
          totals.slice(0, 8).map(r => `- ${r.name}: ${cur(r.nettTotal)} total nett (avg ${cur(r.nettTotal / weeks)}/week) across ${r.transactions} transactions, ${blendedProfitPct(r).toFixed(0)}% blended profit margin`).join('\n'));
      }
      // Revenue-per-labour-hour by department — only when a roster file with
      // Hours has actually joined to this week's leaderboard. NOT a labour
      // cost % (that needs pay rates, deliberately out of scope).
      const withHours = rows.map(r => ({ r, roster: matchRosterEntry(rosterByName, r.name, venueName) }))
        .filter(x => x.roster && x.roster.hours);
      if (withHours.length) {
        const byDept = new Map();
        withHours.forEach(({ r, roster }) => {
          const dept = roster.department || (isManagerRole(roster.role) ? 'Management / floating' : 'Unassigned department');
          const agg = byDept.get(dept) || { dept, revenue: 0, hours: 0 };
          agg.revenue += r.nettTotal;
          agg.hours += roster.hours;
          byDept.set(dept, agg);
        });
        const deptRows = Array.from(byDept.values())
          .map(d => ({ ...d, perHour: d.hours > 0 ? d.revenue / d.hours : 0 }))
          .sort((a, b) => b.perHour - a.perHour);
        parts.push(`Revenue per labour hour by department, week of ${weekLabel(w)} (from the uploaded roster/hours file, ${withHours.length} of ${rows.length} staff matched):\n` +
          deptRows.map(d => `- ${d.dept}: ${cur(d.perHour)}/hour (${cur(d.revenue)} nett over ${d.hours.toFixed(1)} hours)`).join('\n'));
      }
    }
    if (weekly.cogs.length) {
      const w = latestWeek(weekly.cogs);
      const rows = w.rows.slice().sort((a, b) => b.nettTotal - a.nettTotal);
      parts.push(`Margin by category, week of ${weekLabel(w)}:\n` +
        rows.map(r => `- ${r.name}: ${cur(r.nettTotal)} nett, ${r.profitPct.toFixed(0)}% margin`).join('\n'));
      if (weekly.cogs.length > 1) {
        const weeks = weekly.cogs.length;
        const totals = aggregateRows(weekly.cogs, []).sort((a, b) => b.nettTotal - a.nettTotal);
        parts.push(`Margin by category, ${weeks}-week total (${weekRangeLabel(weekly.cogs)}):\n` +
          totals.map(r => `- ${r.name}: ${cur(r.nettTotal)} total nett (avg ${cur(r.nettTotal / weeks)}/week), ${blendedProfitPct(r).toFixed(0)}% blended margin`).join('\n'));
      }
    }
    // productMix is keyed by store (see runAnalysis) — one store's report
    // per label, so multiple stores' weekly uploads for the same period
    // never get summed together as if they were multiple weeks of one
    // report.
    productMixStoreKeys.forEach(storeKey => {
      const entries = weekly.productMix[storeKey];
      const storeLabel = productMixStoreKeys.length > 1 ? ` — ${storeKey}` : '';
      const w = latestWeek(entries);
      const top = w.rows.slice().sort((a, b) => b.nettTotal - a.nettTotal).slice(0, 8);
      parts.push(`Top-selling products${storeLabel}, week of ${weekLabel(w)}:\n` +
        top.map(r => `- ${r.name}: ${cur(r.nettTotal)} (${r.qty} sold, ${r.profitPct.toFixed(0)}% margin)`).join('\n'));
      if (entries.length > 1) {
        const weeks = entries.length;
        const totals = aggregateRows(entries, ['qty']).sort((a, b) => b.nettTotal - a.nettTotal).slice(0, 8);
        parts.push(`Top-selling products${storeLabel}, ${weeks}-week total (${weekRangeLabel(entries)}):\n` +
          totals.map(r => `- ${r.name}: ${cur(r.nettTotal)} total (avg ${cur(r.nettTotal / weeks)}/week, ${r.qty} sold, ${blendedProfitPct(r).toFixed(0)}% blended margin)`).join('\n'));
      }
    });
    if (weekly.stockLoss.length) {
      const w = latestWeek(weekly.stockLoss);
      const d = w.data;
      parts.push(`Stock loss, week of ${weekLabel(w)}: ${cur(d.total)} across ${d.count} loss events — by till:\n` +
        d.byTill.slice(0, 6).map(t => `- ${t.till}: ${cur(t.amount)} (${t.count} events)`).join('\n'));
    }
    if (weekly.tableWriteoffs.length) {
      const w = latestWeek(weekly.tableWriteoffs);
      const d = w.data;
      parts.push(`Comps & write-offs, week of ${weekLabel(w)}: ${cur(d.total)} across ${d.count} tables — by reason:\n` +
        d.byReason.map(r => `- ${r.reason}: ${cur(r.amount)} (${r.count} tables)`).join('\n'));
    }
    if (weekly.bulkBeer.length) {
      const w = latestWeek(weekly.bulkBeer);
      const totalLitres = w.rows.reduce((s, r) => s + r.litresSold, 0);
      const totalNett = w.rows.reduce((s, r) => s + r.nettTotal, 0);
      const top = w.rows.slice().sort((a, b) => b.litresSold - a.litresSold).slice(0, 6);
      parts.push(`Bulk beer, week of ${weekLabel(w)}: ${totalLitres.toFixed(0)}L sold, ${cur(totalNett)} nett — top by litres:\n` +
        top.map(r => `- ${r.name}: ${r.litresSold.toFixed(0)}L, ${cur(r.nettTotal)}, ${r.profitPct.toFixed(0)}% margin`).join('\n'));
    }
    weeklySection = `\n\nWeekly performance data:\n${parts.join('\n\n')}`;
  }

  let periodSummarySection = '';
  const psStores = periodSummary ? Object.values(periodSummary) : [];
  if (psStores.length) {
    const parts = psStores.map(store => {
      const days = Object.values(store.byDate).sort((a, b) => b.date - a.date);
      if (!days.length) return '';
      const lines = days.slice(0, 7).map(d => {
        const bits = [];
        if (d.grossSales !== null) bits.push(`${cur(d.grossSales)} gross`);
        if (d.nettTotal !== null) bits.push(`${cur(d.nettTotal)} nett`);
        if (d.costOfSales !== null) bits.push(`${cur(d.costOfSales)} cost of sales`);
        if (d.profitAmt !== null && d.profitPct !== null) bits.push(`${cur(d.profitAmt)} profit (${d.profitPct.toFixed(0)}%)`);
        if (d.difference !== null && Math.abs(d.difference) >= TILL_VARIANCE_THRESHOLD) {
          bits.push(`till ${d.difference < 0 ? 'short' : 'over'} ${cur(Math.abs(d.difference))}`);
        }
        return `- ${fmtDate(d.date)}: ${bits.join(', ')}`;
      });
      let block = `Daily sales & margin, ${store.label}:\n${lines.join('\n')}`;

      const discAgg = aggregateDiscounts(days);
      if (discAgg && discAgg.rows.length) {
        const top = discAgg.rows.slice(0, 5).map(r => `${r.label} ${cur(r.amount)} (${r.qty}x)`).join(', ');
        block += `\nDiscounts, ${store.label}: ${cur(Math.abs(discAgg.total))} given away this period` +
          `${discAgg.pctOfGross !== null ? ` (${discAgg.pctOfGross.toFixed(1)}% of gross sales)` : ''} — top reasons: ${top}`;
      }
      return block;
    }).filter(Boolean);
    if (parts.length) periodSummarySection = `\n\nDaily Period Summary data:\n${parts.join('\n\n')}`;
  }

  return `You are a hospitality operations consultant writing an analysis for ${venueName}. Write ${primary && (weeklySection || periodSummarySection) ? '4-5' : '3-4'} direct paragraphs — no bullet points, no headers. Be specific with figures. This venue's POS reports revenue in separate categories that should NOT be added into one combined "total revenue" figure — do not invent or state a single grand total. Surface patterns a busy owner or manager might not notice themselves.
${dailySection}${weeklySection}${periodSummarySection}

Cover whichever of the following the data supports: what the hourly pattern reveals about staffing opportunities, which day-of-week patterns are structurally strong or weak and why, what the best vs worst days suggest about demand drivers, standout staff performance (high or low margin), which departments are getting the most/least revenue per labour hour and whether rostering matches demand, category or product margin issues worth a pricing review, daily margin or till-variance issues worth flagging, which discount reasons are giving away the most margin and whether that looks justified, and 2 specific operational recommendations. Reference the category breakdown where relevant instead of a combined total.`;
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
    if (!response.ok) {
      let detail = '';
      try {
        const errBody = await response.json();
        detail = errBody.error ? (typeof errBody.error === 'string' ? errBody.error : JSON.stringify(errBody.error)) : '';
      } catch (e) { /* body wasn't JSON */ }
      throw new Error(`API error ${response.status}${detail ? ' — ' + detail : ''}`);
    }

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
  // name.toLowerCase() -> [{name,role,department,hours,venue}], built from
  // any uploaded Staff Roster file(s) and joined onto Staff Sales by name at
  // render time (see matchRosterEntry) — not scoped to a venue while files
  // are still being read, since roster files carry no Bepoz Venue/Store info.
  const rosterByName = {};
  let rosterFilesParsed = 0;

  for (let i = 0; i < allFiles.length; i++) {
    const f = allFiles[i];
    const pct = Math.round((i / allFiles.length) * 82);
    setProgress(pct, `Reading file ${i + 1} of ${allFiles.length}`, f.name.slice(0, 50));
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0)); // keep UI responsive

    let text, xlsxWorkbook = null;
    try {
      if (f.name.toLowerCase().endsWith('.pdf')) {
        text = await extractPDFText(f);
      } else {
        const r = await extractXLSXText(f);
        text = r.text;
        xlsxWorkbook = r.workbook; // needed for parseDiscounts below, and for roster detection
      }
    } catch (e) {
      failed++;
      failureSamples.push(`${f.name}: could not read file (${e.message})`);
      continue;
    }

    // Staff Roster files don't fit Bepoz's Venue:/Store: Criteria-sheet
    // model at all, so they're detected and pulled out here — from the
    // workbook's own header row — before classifyReport ever sees them.
    if (xlsxWorkbook) {
      const rosterRows = parseRosterRows(xlsxWorkbook);
      if (rosterRows && rosterRows.length) {
        rosterRows.forEach(row => {
          const key = row.name.toLowerCase();
          (rosterByName[key] = rosterByName[key] || []).push(row);
        });
        rosterFilesParsed++;
        parsed++;
        continue;
      }
    }

    const info = classifyReport(text);
    if (!info) {
      failed++;
      failureSamples.push(`${f.name}: could not identify a venue or report type in the report`);
      continue;
    }

    const vKey = resolveVenueKey(venues, info.venue);
    // productMix is keyed by store (not a flat array like staffSales/cogs) —
    // Harbord Hotel's weekly Product Summary is exported as one file PER
    // STORE (Bombies/Bottleshop/Hotel/...), all landing in the same week, so
    // a flat array would treat five different stores' reports as if they
    // were five different WEEKS of one report — wrong "N weeks uploaded"
    // label, only one store's data ever shown, and multi-week totals that
    // silently sum different stores together as if summing weeks.
    venues[vKey] = venues[vKey] || { categories: {}, subVenues: {}, weekly: { staffSales: [], cogs: [], productMix: {}, stockLoss: [], tableWriteoffs: [], bulkBeer: [] }, periodSummary: {}, periodSummaryCount: 0, unsupportedWeeklyCount: 0 };
    const v = venues[vKey];

    if (info.category === 'period_summary') {
      const psDate = extractShiftDate(text) || extractDateFromFilename(f.name);
      const psData = parsePeriodSummary(text);
      if (!psDate || !psData) {
        periodSummarySkipped++;
        v.periodSummaryCount++;
        failureSamples.push(`${f.name}: recognised as a Period Summary but couldn't find its sales figures or date`);
        continue;
      }
      const discounts = parseDiscounts(xlsxWorkbook); // null for PDF Period Summaries
      const storeKey = (info.store || 'All Stores').trim();
      v.periodSummary[storeKey] = v.periodSummary[storeKey] || { label: storeKey, byDate: {} };
      v.periodSummary[storeKey].byDate[dateKey(psDate)] = { date: psDate, ...psData, discounts };
      parsed++;
      continue;
    }

    if (info.category === 'account_summary' || info.category === 'unsupported_weekly') {
      // Recognised so they don't show up as parse failures, but no UI built
      // for them yet — Account Summary, plus any weekly-shaped report that
      // doesn't match a known sub-type at all.
      v.unsupportedWeeklyCount++;
      continue;
    }

    if (info.category === 'stock_loss' || info.category === 'table_writeoffs' || info.category === 'bulk_beer') {
      const range = extractShiftDateRange(text);
      if (!range) {
        failed++;
        failureSamples.push(`${f.name}: recognised as "${info.title}" but no week date range found`);
        continue;
      }
      if (!xlsxWorkbook) {
        // No PDF exemplar seen for these three report types yet — only the
        // XLSX workbook-reading parsers exist.
        v.unsupportedWeeklyCount++;
        continue;
      }
      if (info.category === 'bulk_beer') {
        const rows = parseBulkBeerRows(xlsxWorkbook);
        if (!rows || !rows.length) {
          failed++;
          failureSamples.push(`${f.name}: recognised as "${info.title}" but couldn't parse any rows`);
          continue;
        }
        v.weekly.bulkBeer.push({ weekStart: range.from, weekEnd: range.to, rows });
        parsed++;
        continue;
      }
      const data = info.category === 'stock_loss' ? parseStockLossRows(xlsxWorkbook) : parseTableWriteoffRows(xlsxWorkbook);
      if (!data) {
        failed++;
        failureSamples.push(`${f.name}: recognised as "${info.title}" but couldn't parse any rows`);
        continue;
      }
      const bucket = info.category === 'stock_loss' ? v.weekly.stockLoss : v.weekly.tableWriteoffs;
      bucket.push({ weekStart: range.from, weekEnd: range.to, data });
      parsed++;
      continue;
    }

    if (info.category === 'staff_sales' || info.category === 'cogs' || info.category === 'product_mix') {
      const range = extractShiftDateRange(text);
      if (!range) {
        failed++;
        failureSamples.push(`${f.name}: recognised as "${info.title}" but no week date range found`);
        continue;
      }
      // Prefer reading the workbook's cells directly for XLSX weekly reports
      // — Bepoz's individual product/staff rows there are raw unformatted
      // numbers, not "$X.XX" display strings, which the text-regex parsers
      // below can't reliably match (see parseWeeklyProductRows' comment).
      // Falls back to the text-regex parsers for PDF weekly reports, which
      // Bepoz always renders with formatted figures.
      let rows;
      if (xlsxWorkbook) {
        rows = info.category === 'staff_sales' ? parseWeeklyStaffSalesRows(xlsxWorkbook) : parseWeeklyProductRows(xlsxWorkbook);
      } else {
        rows = info.category === 'staff_sales' ? parseStaffSalesRows(text) : parseSizedRows(text);
      }
      if (!rows || !rows.length) {
        failed++;
        failureSamples.push(`${f.name}: recognised as "${info.title}" but couldn't parse any rows`);
        continue;
      }
      const entry = { weekStart: range.from, weekEnd: range.to, rows };
      if (info.category === 'staff_sales') {
        v.weekly.staffSales.push(entry);
      } else if (info.category === 'cogs') {
        v.weekly.cogs.push(entry);
      } else {
        // A store can have more than one weekly Product Summary report
        // family — Harbord Hotel runs a "Food" product summary (different
        // column layout entirely, see parseWeeklyProductRows) alongside its
        // general Product Summary for the same store (e.g. "HH BombieFood
        // Prod Sum" and "HH Prod Summ Weekly Bombies" are both for "HH
        // Bombies"). Keying on store alone would bucket those two distinct
        // report series together and mislabel them as two different WEEKS
        // of the same report — the same conflation bug this store-keying
        // was built to avoid, one level down. Tagged onto the key using the
        // same "food" signal classifyReport already uses for daily reports.
        const store = (info.store || info.venue || 'All Stores').trim();
        const storeKey = /food/i.test(info.title) ? `${store} (Food)` : store;
        v.weekly.productMix[storeKey] = v.weekly.productMix[storeKey] || [];
        v.weekly.productMix[storeKey].push(entry);
      }
      parsed++;
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

  // Roster names never seen in ANY uploaded Staff Sales report (any venue,
  // any week) — surfaced as a count rather than silently dropped, same as
  // every other unmatched/unparseable case in this loop.
  let rosterUnmatchedCount = 0;
  if (rosterFilesParsed > 0) {
    const allStaffNames = new Set();
    Object.values(venues).forEach(v => {
      v.weekly.staffSales.forEach(week => week.rows.forEach(r => allStaffNames.add(r.name.toLowerCase().trim())));
    });
    rosterUnmatchedCount = Object.keys(rosterByName).filter(k => !allStaffNames.has(k)).length;
  }

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
    (periodSummarySkipped > 0 ? ` · ${periodSummarySkipped} period summary file${periodSummarySkipped === 1 ? '' : 's'} seen (not yet charted)` : '') +
    (rosterFilesParsed > 0 ? ` · ${rosterFilesParsed} roster file${rosterFilesParsed === 1 ? '' : 's'} loaded (${Object.keys(rosterByName).length} staff${rosterUnmatchedCount ? `, ${rosterUnmatchedCount} not found in any Staff Sales report` : ''})` : '');

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

    const productMixStores = Object.keys(v.weekly.productMix);
    const hasWeekly = v.weekly.staffSales.length || v.weekly.cogs.length || productMixStores.length
      || v.weekly.stockLoss.length || v.weekly.tableWriteoffs.length || v.weekly.bulkBeer.length;

    const metricsHTML = catStats.length ? catStats.map(c => `
      <div class="metric-card">
        <div class="metric-label">${CATEGORY_LABELS[c.key] || c.key}</div>
        <div class="metric-value">${cur(c.stats.total)}</div>
        <div class="metric-sub">${c.stats.days.length} days · avg ${cur(c.stats.avg)}/day</div>
      </div>`).join('')
      : hasWeekly
        ? `<div class="metric-card"><div class="metric-label">No daily Time Break reports</div><div class="metric-sub">Weekly performance data is below.</div></div>`
        : `<div class="metric-card"><div class="metric-label">No Time Break reports</div><div class="metric-sub">Only Period Summary files were provided for this venue — those aren't charted yet.</div></div>`;

    const subVenueList = Object.values(v.subVenues);
    const subVenueHTML = subVenueList.map(subVenueCardHTML).join('');

    const primary = catStats[0]; // headline category for the AI narrative's hourly deep-dive, by HEADLINE_PRIORITY order
    const vslug = slug(venueName);

    // Every category with data gets its own day-of-week chart + hourly heatmap
    // + flags, not just the headline one — a venue's main bar is just as
    // operationally relevant as its food, and burying it in a metric card
    // with no chart hid that. Rendered in the same priority order as before
    // (dept, food, bar_bev, bshop, then anything else).
    const chartSection = catStats.map(c => {
      const label = CATEGORY_LABELS[c.key] || c.key;
      return `
        <div class="result-card">
          <div class="card-label">Revenue by day of week — ${label}</div>
          <div>${dowChartHTML(c.stats)}</div>
        </div>
        <div class="result-card">
          <div class="card-label">Hourly heatmap — ${label}</div>
          <div class="heatmap-wrap">${heatmapHTML(c.stats)}</div>
          <div class="heatmap-legend">Darker teal = higher average revenue &nbsp;·&nbsp; Hover cells for exact figures</div>
        </div>
        <div class="result-card">
          <div class="card-label">Key flags — ${label}</div>
          <div>${flagsHTML(c.stats, label)}</div>
        </div>`;
    }).join('');

    // Venue-level date range spans every category, not just the headline one,
    // since categories can cover slightly different periods.
    const allDays = catStats.flatMap(c => c.stats.days);
    const dateRange = allDays.length
      ? `${fmtDate(allDays.reduce((a, b) => a.date < b.date ? a : b).date)} – ${fmtDate(allDays.reduce((a, b) => a.date > b.date ? a : b).date)}`
      : '';

    // Product Mix is keyed by store — one card pair per store that actually
    // uploaded a weekly report, labelled only when there's more than one
    // (a single-store venue's cards read the same as before this change).
    const productMixSection = productMixStores.map(storeKey => {
      const entries = v.weekly.productMix[storeKey];
      const label = productMixStores.length > 1 ? storeKey : null;
      return productMixHTML(entries, label) + productTotalsHTML(entries, label);
    }).join('');

    const weeklySection = hasWeekly ? `
      ${staffLeaderboardHTML(v.weekly.staffSales, rosterByName, venueName)}
      ${staffProductivityHTML(v.weekly.staffSales, rosterByName, venueName)}
      ${staffTotalsHTML(v.weekly.staffSales)}
      ${cogsHTML(v.weekly.cogs)}
      ${cogsTotalsHTML(v.weekly.cogs)}
      ${productMixSection}
      ${stockLossHTML(v.weekly.stockLoss)}
      ${tableWriteoffsHTML(v.weekly.tableWriteoffs)}
      ${bulkBeerHTML(v.weekly.bulkBeer)}` : '';

    const periodSummaryList = Object.values(v.periodSummary || {});
    const hasPeriodSummary = periodSummaryList.length > 0;
    const periodSummarySection = periodSummaryList
      .map(store => periodSummaryHTML(store) + discountBreakdownHTML(store))
      .join('');

    const section = document.createElement('div');
    section.className = 'venue-section';
    section.innerHTML = `
      <div class="venue-header">
        <h3>${venueName}</h3>
        <p class="results-meta">${dateRange}${v.periodSummaryCount ? ` · ${v.periodSummaryCount} period summary file${v.periodSummaryCount === 1 ? '' : 's'} not charted` : ''}${v.unsupportedWeeklyCount ? ` · ${v.unsupportedWeeklyCount} weekly report file${v.unsupportedWeeklyCount === 1 ? '' : 's'} recognised but not charted yet (account summary, or another type without a dashboard yet)` : ''}</p>
      </div>
      <div class="metrics-grid">${metricsHTML}</div>
      ${subVenueList.length ? `<div class="result-card"><div class="card-label">Sub-venues / satellite bars</div><div class="metrics-grid">${subVenueHTML}</div></div>` : ''}
      ${chartSection}
      ${weeklySection}
      ${periodSummarySection}
      <div class="result-card brief-card">
        <div class="card-label">
          <span>AI ops narrative</span>
          <span class="powered-by">Powered by Claude</span>
        </div>
        <div class="brief-text" id="brief-${vslug}"></div>
      </div>`;
    container.appendChild(section);

    if (primary || hasWeekly || hasPeriodSummary) {
      const prompt = buildPrompt(venueName, primary, primary ? (CATEGORY_LABELS[primary.key] || primary.key) : null, catStats, subVenueList, v.weekly, v.periodSummary, rosterByName);
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
