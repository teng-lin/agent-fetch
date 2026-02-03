import initSqlJs from 'sql.js';
import fs from 'fs';

const SQL = await initSqlJs();
const buf = fs.readFileSync('/Users/blackmyth/src/lynxget/lynxget-e2e.db');
const db = new SQL.Database(buf);

// Get all fetch runs
const fetchRuns = db.exec(`
  SELECT run_id, substr(git_commit,1,7) as git_hash, started_at
  FROM test_runs
  WHERE ended_at IS NOT NULL AND run_type = 'fetch'
  ORDER BY started_at
`);

if (!fetchRuns[0] || fetchRuns[0].values.length === 0) {
  console.log('No fetch runs found');
  process.exit(1);
}

const runIds = fetchRuns[0].values.map(r => r[0]);
const runLabels = fetchRuns[0].values.map((r, i) => `R${i+1}`);
const runNotes = ['home', 'home', 'home', 'home', 'home', 'home+retry', 'home+retry', 'starbucks', 'starbucks', 'starbucks2', 'cell'];

// Get all site data
const siteData = db.exec(`
  SELECT e.site, tr.run_id, e.success, e.word_count, e.latency_ms, e.extraction_method, e.error_message, e.status_code
  FROM test_runs tr
  JOIN e2e_runs e ON tr.run_id = e.run_id
  WHERE tr.ended_at IS NOT NULL AND tr.run_type = 'fetch'
  ORDER BY e.site, tr.started_at
`);

const siteMap = new Map();
siteData[0]?.values.forEach(r => {
  const site = r[0];
  const runId = r[1];
  if (!siteMap.has(site)) siteMap.set(site, new Map());
  siteMap.get(site).set(runId, { success: r[2], words: r[3], latency: r[4], method: r[5], error: r[6], status: r[7] });
});

const colW = 9;
const siteW = 28;
const sites = [...siteMap.keys()].sort();

function cellVal(d) {
  if (!d) return '-';
  if (!d.success) {
    if (d.error?.includes('dns_rebinding')) return 'dns_reb';
    if (d.error?.includes('timeout')) return 'timeout';
    if (d.error?.includes('DNS resolution')) return 'dns_to';
    if (d.status === 403) return '403';
    if (d.status === 304) return '304';
    if (d.status === 202) return '202stub';
    return (d.error || '?').substring(0, 7);
  }
  return String(d.words || 0);
}

// === WORD COUNT TABLE ===
console.log('=== SITE-BY-SITE: WORD COUNT (number=words, else=error) ===\n');

let hdr = 'Site'.padEnd(siteW);
runLabels.forEach((l, i) => { hdr += l.padStart(colW); });
console.log(hdr);

let noteHdr = ''.padEnd(siteW);
runNotes.slice(0, runLabels.length).forEach(n => { noteHdr += n.substring(0, colW).padStart(colW); });
console.log(noteHdr);
console.log('-'.repeat(hdr.length));

for (const site of sites) {
  const data = siteMap.get(site);
  let line = site.substring(0, siteW - 1).padEnd(siteW);
  runIds.forEach(rid => {
    line += cellVal(data.get(rid)).padStart(colW);
  });
  console.log(line);
}

// === LATENCY TABLE ===
console.log('\n\n=== SITE-BY-SITE: LATENCY in ms (successful fetches only) ===\n');

hdr = 'Site'.padEnd(siteW);
runLabels.forEach(l => { hdr += l.padStart(colW); });
console.log(hdr);
noteHdr = ''.padEnd(siteW);
runNotes.slice(0, runLabels.length).forEach(n => { noteHdr += n.substring(0, colW).padStart(colW); });
console.log(noteHdr);
console.log('-'.repeat(hdr.length));

for (const site of sites) {
  const data = siteMap.get(site);
  let line = site.substring(0, siteW - 1).padEnd(siteW);
  runIds.forEach(rid => {
    const d = data.get(rid);
    if (!d || !d.success) { line += '-'.padStart(colW); return; }
    line += String(d.latency || 0).padStart(colW);
  });
  console.log(line);
}

// === STATUS CHANGES ===
console.log('\n\n=== STATUS CHANGES: HOME BEST (R7) vs STARBUCKS (R9) vs CELL (R11) ===\n');

const r7 = runIds[6];
const r9 = runIds[8];
const r11 = runIds[runIds.length - 1];

console.log('Site'.padEnd(siteW) + 'R7 Home'.padStart(12) + 'R9 Starbux'.padStart(12) + 'R11 Cell'.padStart(12) + '  Notes');
console.log('-'.repeat(siteW + 36 + 12));

for (const site of sites) {
  const data = siteMap.get(site);
  const d7 = data.get(r7);
  const d9 = data.get(r9);
  const d11 = data.get(r11);

  const v7 = cellVal(d7);
  const v9 = cellVal(d9);
  const v11 = cellVal(d11);

  // Skip if all same
  if (v7 === v9 && v9 === v11) continue;

  let note = '';
  const ok7 = d7?.success && d7.words >= 200;
  const ok9 = d9?.success && d9.words >= 200;
  const ok11 = d11?.success && d11.words >= 200;

  if (ok7 && !ok11) note = 'cell regression';
  else if (!ok7 && ok11) note = 'cell improvement';
  else if (ok7 && !ok9) note = 'starbucks issue';
  else if (ok9 !== ok11 || v9 !== v11) note = 'network-dependent';

  console.log(site.padEnd(siteW) + v7.padStart(12) + v9.padStart(12) + v11.padStart(12) + '  ' + note);
}

db.close();
