/* ===========================================================================
   Groww MTF accumulator  v2
   Each filter/sort view renders a DIFFERENT 100 rows. This harvests whatever
   is on screen and merges it into localStorage, so you sweep views and the
   total keeps climbing. Survives reloads and navigation.

   USE
     1. Paste once on  https://groww.in/stocks/mtf/list   -> arms it
     2. Change a filter or sort, wait for the table to redraw, then run:  G()
        (or just let autoharvest do it - it polls every 3s)
     3. Watch the running total in the console
     4. When it stops climbing, run:  GD()   -> downloads groww_mtf_full.csv
        GC()  clears the store and starts over
        GS()  prints how many are stored right now

   SWEEP PLAN (each combination is a fresh 100)
     - Sort by Market price   ASC and DESC
     - Sort by 1D price change ASC and DESC
     - Sort by 1D volume      ASC and DESC
     - Sort by Market cap     ASC and DESC   (enable the column if hidden)
     - Sort by Required %     ASC and DESC   (this is the MTF haircut column)
     - Then repeat the above with Market Cap filter set to Largecap only,
       then Midcap only, then Smallcap only, then Microcap only
     - Then repeat with each sector selected in the filter panel
   Roughly 40-60 views gets you to the full ~1,300.
   =========================================================================== */

(() => {
  const KEY = 'groww_mtf_store';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = o => localStorage.setItem(KEY, JSON.stringify(o));

  function harvest(quiet) {
    const H = document.documentElement.innerHTML
      .replace(/\\"/g, '"').replace(/\\u0026/g, '&');
    const store = load();
    const before = Object.keys(store).length;
    const re = /"nseScriptCode":"([A-Za-z0-9&._\-]+)"/g;
    let m;
    while ((m = re.exec(H)) !== null) {
      const w = H.slice(m.index, m.index + 1400);
      const g = (k, q) => {
        const r = new RegExp('"' + k + '":' + (q ? '"([^"]*)"' : '([-0-9.]+)'));
        const x = w.match(r);
        return x ? x[1] : '';
      };
      const sym = m[1];
      const hc = g('mtfHaircut');
      if (!hc) continue;                       // skip rows with no margin
      if (store[sym] && store[sym].mtfHaircut) continue;
      store[sym] = {
        nseScriptCode: sym, bseScriptCode: g('bseScriptCode', 1),
        shortName: g('shortName', 1), mtfHaircut: hc,
        ltp: g('ltp'), close: g('close'), marketCap: g('marketCap'),
        gsin: g('gsin', 1), searchId: g('searchId', 1)
      };
    }
    save(store);
    const after = Object.keys(store).length;
    if (!quiet || after > before) {
      const style = after > before ? 'color:#0a0;font-weight:bold' : 'color:#888';
      console.log(`%cstored ${after}  (+${after - before} new)`, style);
    }
    return after;
  }

  window.G = () => harvest(false);
  window.GS = () => { const n = Object.keys(load()).length; console.log(`stored: ${n}`); return n; };
  window.GC = () => { localStorage.removeItem(KEY); console.log('store cleared'); };
  window.GD = () => {
    const o = Object.values(load());
    if (!o.length) return console.warn('store is empty');
    const c = ['nseScriptCode', 'bseScriptCode', 'shortName', 'mtfHaircut',
               'ltp', 'close', 'marketCap', 'gsin', 'searchId'];
    const e = v => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [c.join(',')].concat(o.map(r => c.map(k => e(r[k])).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    a.download = 'groww_mtf_full.csv';
    a.click();
    console.log(`%cdownloaded groww_mtf_full.csv with ${o.length} scrips`,
                'color:#0a0;font-size:15px;font-weight:bold');
  };

  harvest(false);
  if (window.__growwPoll) clearInterval(window.__growwPoll);
  window.__growwPoll = setInterval(() => harvest(true), 3000);

  console.log('%cAccumulator armed — autoharvest every 3s.',
              'color:#00f;font-size:14px;font-weight:bold');
  console.log('Change a filter or sort and the total climbs on its own. ' +
              'G()=harvest now  GS()=count  GD()=download CSV  GC()=clear');
})();
