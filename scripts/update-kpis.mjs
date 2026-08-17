/* =====================================================================
   update-kpis.mjs — the data fetcher for The Morning Board
   ---------------------------------------------------------------------
   Runs on GitHub Actions (Node 20+), NOT in the browser.
   Writes data/kpis.json, which the Action then commits to the repo.
   GitHub Pages serves that file; index.html reads it.

   Needs NO API keys and NO accounts. Nothing to sign up for.

   Macro data comes from FRED's public chart-download endpoint
   (fredgraph.csv), which is the same data as the FRED API but needs no
   key. Market quotes try Yahoo first (intraday, plus the real ICE dollar
   index) and fall back to Stooq. Each series records which source
   answered; anything that fails lands in `problems` rather than
   silently disappearing.
   ===================================================================== */

import { writeFile, mkdir } from 'node:fs/promises';

const HISTORY_POINTS = 30;
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const UA = 'Mozilla/5.0 (compatible; MorningBoard/1.0)';

/* How far back to ask for, per cadence. Enough for a 30-point sparkline,
   plus 12 extra periods for the year-over-year series. */
const LOOKBACK_DAYS = { daily: 200, weekly: 1100, monthly: 2000, quarterly: 5500 };

/* ---------- macro series, from FRED --------------------------------- */
const FRED_SERIES = {
  unemployment: { id:'UNRATE',       mode:'level', cadence:'monthly',   note:'BLS household survey' },
  claims:       { id:'ICSA',         mode:'level', cadence:'weekly',    note:'Initial claims, SA' },
  cpi:          { id:'CPIAUCNS',     mode:'yoy',   cadence:'monthly',   note:'CPI-U, all items' },
  corepce:      { id:'PCEPILFE',     mode:'yoy',   cadence:'monthly',   note:"Fed's preferred gauge" },
  fedfunds:     { id:'DFF',          mode:'level', cadence:'daily',     note:'Effective fed funds' },
  ust10:        { id:'DGS10',        mode:'level', cadence:'daily',     note:'10-yr constant maturity' },
  mortgage30:   { id:'MORTGAGE30US', mode:'level', cadence:'weekly',    note:'Freddie Mac PMMS' },
  debtgdp:      { id:'GFDEGDQ188S',  mode:'level', cadence:'quarterly', note:'Federal debt / GDP' }
};

/* ---------- market quotes -------------------------------------------
   invert: Yahoo gives EUR/USD and GBP/USD as dollars-per-unit; the board
   shows foreign currency per 1 USD, so those two get flipped.
------------------------------------------------------------------- */
const MARKETS = {
  dow:    { yahoo:'^DJI',      stooq:'^dji',    note:'' },
  nasdaq: { yahoo:'^IXIC',     stooq:'^ndq',    note:'' },
  sp500:  { yahoo:'^GSPC',     stooq:'^spx',    note:'' },
  vix:    { yahoo:'^VIX',      stooq:null,      note:'CBOE volatility index' },
  oil:    { yahoo:'CL=F',      stooq:'cl.f',    note:'WTI front-month' },
  brent:  { yahoo:'BZ=F',      stooq:'cb.f',    note:'Brent front-month' },
  gold:   { yahoo:'GC=F',      stooq:'xauusd',  note:'Front-month futures' },
  silver: { yahoo:'SI=F',      stooq:'xagusd',  note:'Front-month futures' },
  dxy:    { yahoo:'DX-Y.NYB',  stooq:null,      note:'ICE US dollar index' },
  eur:    { yahoo:'EURUSD=X',  stooq:'usdeur',  note:'', invert:true },
  gbp:    { yahoo:'GBPUSD=X',  stooq:'usdgbp',  note:'', invert:true },
  mxn:    { yahoo:'MXN=X',     stooq:'usdmxn',  note:'' },
  cad:    { yahoo:'CAD=X',     stooq:'usdcad',  note:'' },
  /* Asia + Russia. These quote as units per USD already, so no invert. */
  jpy:    { yahoo:'JPY=X',     stooq:'usdjpy',  note:'' },
  cny:    { yahoo:'CNY=X',     stooq:'usdcny',  note:'Onshore yuan' },
  inr:    { yahoo:'INR=X',     stooq:'usdinr',  note:'' },
  php:    { yahoo:'PHP=X',     stooq:'usdphp',  note:'' },
  rub:    { yahoo:'RUB=X',     stooq:'usdrub',  note:'Thin post-2022 quoting' }
};

const round = (n, dp = 4) => +n.toFixed(dp);

/* ---------- FRED, keyless ------------------------------------------
   fredgraph.csv is the endpoint behind the "download CSV" button on every
   FRED chart page. Public, no key, no account. Returns oldest-first:

     observation_date,UNRATE
     2026-05-01,4.3
     2026-06-01,4.2

   Older responses use "DATE" as the first header instead of
   "observation_date", so the column names are never relied on — the first
   field is the date and the last is the value. Missing values are ".".
------------------------------------------------------------------- */
export function parseFredCsv(text){
  const clean = text.replace(/^\uFEFF/, '').trim();
  if(/^\s*</.test(clean)) throw new Error('got HTML instead of CSV (bad series id, or FRED is blocking)');
  const lines = clean.split(/\r?\n/);
  if(lines.length < 2) throw new Error('CSV had no data rows');

  const rows = [];
  for(const line of lines.slice(1)){
    const cells = line.split(',');
    if(cells.length < 2) continue;
    const date = cells[0].trim();
    const raw = cells[cells.length - 1].trim();
    if(raw === '.' || raw === '') continue;      // FRED's missing-value marker
    const value = parseFloat(raw);
    if(!isFinite(value)) continue;
    rows.push({ date, value });
  }
  if(!rows.length) throw new Error('no usable observations in CSV');
  return rows;                                   // ascending, oldest first
}

export async function fetchFred(spec, fetchImpl = fetch){
  const days = LOOKBACK_DAYS[spec.cadence] ?? 2000;
  const cosd = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const url = `${FRED_CSV}?id=${encodeURIComponent(spec.id)}&cosd=${cosd}`;

  const r = await fetchImpl(url, { headers:{ 'user-agent': UA } });
  if(!r.ok) throw new Error(`FRED CSV ${r.status}`);
  const rows = parseFredCsv(await r.text());

  if(spec.mode === 'yoy'){
    if(rows.length < 13) throw new Error('not enough history for a YoY calculation');
    const yoy = [];
    for(let i = 12; i < rows.length; i++){
      yoy.push(round((rows[i].value / rows[i - 12].value - 1) * 100, 2));
    }
    const latest = rows[rows.length - 1];
    return {
      value: yoy[yoy.length - 1],
      prev: yoy.length > 1 ? yoy[yoy.length - 2] : null,
      history: yoy.slice(-HISTORY_POINTS),
      asOf: `${latest.date} · ${spec.cadence}`,
      note: spec.note,
      source: `FRED ${spec.id}`
    };
  }

  const latest = rows[rows.length - 1];
  const prior = rows[rows.length - 2];
  return {
    value: latest.value,
    prev: prior ? prior.value : null,
    history: rows.slice(-HISTORY_POINTS).map(o => o.value),
    asOf: `${latest.date} · ${spec.cadence}`,
    note: spec.note,
    source: `FRED ${spec.id}`
  };
}

/* ---------- Yahoo --------------------------------------------------- */
export async function fetchYahoo(spec, fetchImpl = fetch){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/`
            + `${encodeURIComponent(spec.yahoo)}?range=3mo&interval=1d`;
  const r = await fetchImpl(url, { headers:{ 'user-agent': UA } });
  if(!r.ok) throw new Error(`Yahoo ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if(!res) throw new Error(j?.chart?.error?.description || 'Yahoo returned no result');

  const meta = res.meta || {};
  const stamps = res.timestamp || [];
  const bars = (res.indicators?.quote?.[0]?.close || [])
    .map((c, i) => ({ t: stamps[i], c }))
    .filter(b => typeof b.c === 'number');
  if(!bars.length) throw new Error('Yahoo returned no closing prices');
  const closes = bars.map(b => b.c);

  /* Live-ish price if the market is trading, else the last daily close. */
  let value = typeof meta.regularMarketPrice === 'number'
    ? meta.regularMarketPrice : closes[closes.length - 1];

  /* PRIOR SESSION CLOSE — the field names here are a trap.
     meta.chartPreviousClose is the close BEFORE THE START OF THE REQUESTED
     RANGE (3 months ago), not yesterday. Using it makes every daily change
     read as a quarterly change. meta.previousClose is the correct field.
     If it's absent, fall back to the daily bars: the last bar is today's
     (partial while the market is open), so yesterday is the one before it —
     unless no bar exists for today yet, in which case the last bar IS the
     prior close. */
  const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
  const lastBarDay = bars[bars.length - 1].t ? dayOf(bars[bars.length - 1].t * 1000) : null;
  const quoteDay = meta.regularMarketTime ? dayOf(meta.regularMarketTime * 1000) : null;
  const lastBarIsCurrent = lastBarDay && quoteDay && lastBarDay === quoteDay;
  const barPrev = lastBarIsCurrent
    ? (closes[closes.length - 2] ?? null)
    : closes[closes.length - 1];

  let prev = barPrev;
  let prevNote = '';
  if(typeof meta.previousClose === 'number'){
    prev = meta.previousClose;
    /* Cross-check against the daily bars. A wrong-field bug (e.g. reading
       chartPreviousClose, which is the close before the range start) shows up
       as a large gap here even when the resulting percentage looks ordinary.
       Trust the bars when they disagree badly. */
    if(barPrev && Math.abs((prev - barPrev) / barPrev) > 0.05){
      prevNote = `meta.previousClose (${prev}) disagrees with the prior daily bar `
               + `(${barPrev}) by more than 5% — used the bar`;
      prev = barPrev;
    }
  }

  let history = closes.slice(-HISTORY_POINTS);

  if(spec.invert){
    value = 1 / value;
    prev = prev ? 1 / prev : null;
    history = history.map(v => 1 / v);
  }

  /* ^TNX quotes the 10-yr yield multiplied by 10 (46.8 means 4.68%). */
  if(spec.divide){
    value = value / spec.divide;
    prev = prev === null ? null : prev / spec.divide;
    history = history.map(v => v / spec.divide);
  }

  const dp = spec.invert ? 6 : 4;
  const when = meta.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0,10) : 'latest';
  return {
    value: round(value, dp),
    prev: prev === null ? null : round(prev, dp),
    history: history.map(v => round(v, dp)),
    asOf: `${when} · ${meta.marketState === 'REGULAR' ? 'intraday' : 'last close'}`,
    note: spec.note,
    warn: prevNote || undefined,
    source: `Yahoo ${spec.yahoo}`
  };
}

/* ---------- Stooq fallback ------------------------------------------ */
export async function fetchStooq(spec, fetchImpl = fetch){
  if(!spec.stooq) throw new Error('no Stooq symbol configured');
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(spec.stooq)}&i=d`;
  const r = await fetchImpl(url, { headers:{ 'user-agent': UA } });
  if(!r.ok) throw new Error(`Stooq ${r.status}`);
  const text = await r.text();
  if(!/^Date,/i.test(text.trim())) throw new Error('Stooq did not return CSV (blocked or bad symbol)');

  const rows = text.trim().split('\n').slice(1);
  const closes = rows
    .map(row => { const c = row.split(','); return { date:c[0], close: parseFloat(c[4]) }; })
    .filter(o => isFinite(o.close));
  if(!closes.length) throw new Error(`no parseable closes for "${spec.stooq}"`);

  const last = closes[closes.length - 1], prior = closes[closes.length - 2];
  return {
    value: round(last.close, 6),
    prev: prior ? round(prior.close, 6) : null,
    history: closes.slice(-HISTORY_POINTS).map(o => round(o.close, 6)),
    asOf: `${last.date} · prior close`,
    note: spec.note,
    source: `Stooq ${spec.stooq}`
  };
}

/* ---------- assemble ------------------------------------------------ */
/* If FRED is unreachable, a couple of series have market equivalents. */
const FRED_BACKUPS = {
  ust10: { yahoo:'^TNX', divide:10, note:'10-yr yield via ^TNX' }
};

export async function build({ fetchImpl = fetch } = {}){
  const series = {};
  const problems = [];
  const jobs = [];

  for(const [key, spec] of Object.entries(FRED_SERIES)){
    jobs.push((async () => {
      try{
        series[key] = await fetchFred(spec, fetchImpl);
      }catch(e1){
        const backup = FRED_BACKUPS[key];
        if(backup){
          try{
            series[key] = await fetchYahoo(backup, fetchImpl);
            problems.push(`${key}: FRED failed (${e1.message}), used ${backup.yahoo} instead`);
            return;
          }catch(e2){
            problems.push(`${key}: FRED failed (${e1.message}); backup failed (${e2.message})`);
            return;
          }
        }
        problems.push(`${key} (FRED ${spec.id}): ${e1.message}`);
      }
    })());
  }

  for(const [key, spec] of Object.entries(MARKETS)){
    jobs.push((async () => {
      try{
        series[key] = await fetchYahoo(spec, fetchImpl);
        const d = series[key];
        if(d.warn) problems.push(`${key}: ${d.warn}`);
        if(typeof d.prev === 'number' && d.prev !== 0){
          const pct = Math.abs((d.value - d.prev) / d.prev) * 100;
          if(pct > 20) problems.push(
            `${key}: daily change of ${pct.toFixed(1)}% is unusually large — worth an eyeball`);
        }
      }catch(e1){
        try{
          series[key] = await fetchStooq(spec, fetchImpl);
          problems.push(`${key}: Yahoo failed (${e1.message}), used Stooq instead`);
        }catch(e2){
          problems.push(`${key}: Yahoo failed (${e1.message}); Stooq failed (${e2.message})`);
        }
      }
    })());
  }

  await Promise.all(jobs);
  return { updated: new Date().toISOString(), mode:'live', problems, series };
}

/* ---------- run ----------------------------------------------------- */
const isMain = import.meta.url === `file://${process.argv[1]}`;
if(isMain){
  const payload = await build();
  await mkdir('data', { recursive:true });
  await writeFile('data/kpis.json', JSON.stringify(payload, null, 2) + '\n');

  const got = Object.keys(payload.series).length;
  console.log(`\nWrote data/kpis.json — ${got} series populated.`);
  for(const [k, v] of Object.entries(payload.series)){
    console.log(`  ok   ${k.padEnd(13)} ${String(v.value).padStart(12)}   ${v.source}`);
  }
  if(payload.problems.length){
    console.log('\nProblems:');
    payload.problems.forEach(p => console.log('  !!   ' + p));
  }
  /* A totally empty payload means something systemic broke. Fail loudly so
     the Actions run shows a red X instead of committing an empty file. */
  if(got === 0){
    console.error('\nNo series could be fetched at all — not writing a useless file.');
    process.exit(1);
  }
}
