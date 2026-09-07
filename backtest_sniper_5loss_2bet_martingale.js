#!/usr/bin/env node
/**
 * BACKTEST: Sniper RGRG — 3 Virtual Loss → 2-Bet Martingale (₹20/60/150/350)
 * Uses exported colorDB data
 */

const fs = require('fs');

const BET_LADDER = [20, 60, 150, 350];
const WIN_MULTIPLIER = 0.96;
const VIRTUAL_LOSSES_NEEDED = 3;
const MAX_BETS_PER_LEVEL = 2;
const MAX_LEVELS = 2; // Lv0 = (20,60), Lv1 = (150,350)

// Try multiple file paths
function loadData() {
  const paths = [
    '/Users/abhishek/Downloads/backtest_data.json',
    '/Users/abhishek/Desktop/backtest_data.json'
  ];
  let raw;
  for (const p of paths) {
    try { raw = fs.readFileSync(p, 'utf8'); break; } catch(e) { continue; }
  }
  if (!raw) throw new Error('No backtest_data.json found');
  const data = JSON.parse(raw);
  const byCategory = {};
  const fields = data.recordFields;
  const catIdx = fields.indexOf('category'), periodIdx = fields.indexOf('period');
  const colorIdx = fields.indexOf('color'), isGreenIdx = fields.indexOf('isGreen');

  for (const rec of data.records) {
    const cat = Array.isArray(rec) ? rec[catIdx] : rec.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({
      period: Array.isArray(rec) ? rec[periodIdx] : rec.period,
      is_green: Array.isArray(rec) ? rec[isGreenIdx] : rec.isGreen,
      color: Array.isArray(rec) ? rec[colorIdx] : rec.color
    });
  }
  for (const cat of Object.keys(byCategory)) byCategory[cat].sort((a, b) => a.period - b.period);
  return { byCategory, meta: data };
}

function gc(p) { return (p.is_green || p.color === 'G') ? 'G' : 'R'; }
function cn(c) { return c === 'G' ? '🟢' : '🔴'; }
function alt(c) { for(let i=1;i<c.length;i++) if(c[i]===c[i-1]) return false; return true; }

function runBacktest(periods) {
  let state = 'HUNTING', vLoss = 0, level = 0, betInLevel = 0;
  let activeBet = null, waitWin = false;
  let pnl = 0, peak = 0, worst = 0, maxDD = 0, wipeouts = 0;
  const trades = [];

  for (let i = 0; i < periods.length; i++) {
    const cc = gc(periods[i]), pc = i > 0 ? gc(periods[i-1]) : null;

    if (activeBet && activeBet.idx === i) {
      const won = cc === activeBet.color;

      if (activeBet.virt) {
        if (won) { waitWin = false; vLoss = 0; state = 'HUNTING'; }
        else { vLoss++; state = 'WAIT_BREAK'; }
        activeBet = null; continue;
      }

      const amt = activeBet.amt;
      const p = won ? amt * WIN_MULTIPLIER : -amt;
      pnl += p;
      if (pnl > peak) peak = pnl;
      if (pnl < worst) worst = pnl;
      if (peak - pnl > maxDD) maxDD = peak - pnl;

      trades.push({
        period: periods[i].period, betColor: activeBet.color, actual: cc,
        won, amt, bn: activeBet.bn, lv: activeBet.lv, p, pnl, vl: activeBet.vl
      });

      if (won) {
        vLoss = 0; level = 0; betInLevel = 0; waitWin = false; state = 'HUNTING';
      } else {
        betInLevel++;
        if (betInLevel >= MAX_BETS_PER_LEVEL) {
          betInLevel = 0; level++;
          if (level >= MAX_LEVELS) { wipeouts++; level = 0; }
          waitWin = true; vLoss = 0; state = 'WAIT_BREAK';
        } else {
          state = 'WAIT_BREAK';
        }
      }
      activeBet = null; continue;
    }
    if (activeBet) continue;

    if (state === 'WAIT_BREAK') {
      if (pc && cc === pc) state = 'HUNTING';
      continue;
    }

    if (state === 'HUNTING' && i >= 3) {
      const c4 = [gc(periods[i-3]), gc(periods[i-2]), gc(periods[i-1]), cc];
      if (alt(c4) && i + 1 < periods.length) {
        if (waitWin) {
          activeBet = { color: cc, idx: i+1, virt: true };
        } else if (vLoss >= VIRTUAL_LOSSES_NEEDED) {
          const bn = betInLevel === 1 ? 2 : 1;
          const li = level * MAX_BETS_PER_LEVEL + (bn - 1);
          const amt = BET_LADDER[Math.min(li, BET_LADDER.length - 1)];
          activeBet = { color: cc, idx: i+1, virt: false, amt, bn, lv: level, vl: vLoss };
        } else {
          activeBet = { color: cc, idx: i+1, virt: true };
        }
      }
    }
  }
  return { trades, pnl, peak, worst, maxDD, wipeouts };
}

function main() {
  const { byCategory, meta } = loadData();
  const names = { P: 'Parity', S: 'Sapre', B: 'Bcone', E: 'Emerd' };

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 BACKTEST: 3 V-Loss → ₹20/60/150/350 Martingale (2+2)               ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  📁 Data: ${meta.totalRecords} records | ${meta.dateRange.from.split('T')[0]} → ${meta.dateRange.to.split('T')[0]}`);
  console.log('  📐 Strategy: 3 virtual losses → Lv0(₹20,₹60) → Lv1(₹150,₹350)');
  console.log('  🎰 Payout: 1.96x | Max risk/cycle: ₹580');
  console.log('');

  let gp = 0, gw = 0, gl = 0, gt = 0, gwipe = 0;
  const all = [];

  for (const cat of ['P', 'S', 'B', 'E']) {
    const periods = byCategory[cat];
    if (!periods || !periods.length) { console.log(`  ⚠️ No data for ${names[cat]}`); continue; }

    const r = runBacktest(periods);
    const w = r.trades.filter(t => t.won).length;
    const l = r.trades.filter(t => !t.won).length;
    const wr = r.trades.length > 0 ? (w / r.trades.length * 100).toFixed(1) : '0.0';

    all.push({ cat, name: names[cat], n: periods.length, r, w, l });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  📌 ${names[cat]} (${cat}) — ${periods.length} periods`);
    console.log(`  🎯 Trades: ${r.trades.length} (${w}W/${l}L → ${wr}%)`);
    console.log(`  💰 P&L: ${r.pnl >= 0 ? '+' : ''}₹${r.pnl.toFixed(1)}`);
    console.log(`  📉 Max DD: ₹${r.maxDD.toFixed(0)} | Peak: ₹${r.peak.toFixed(0)} | Wipeouts: ${r.wipeouts}`);

    // Bet breakdown
    const b1l0 = r.trades.filter(t => t.bn===1 && t.lv===0);
    const b2l0 = r.trades.filter(t => t.bn===2 && t.lv===0);
    const b1l1 = r.trades.filter(t => t.bn===1 && t.lv===1);
    const b2l1 = r.trades.filter(t => t.bn===2 && t.lv===1);
    console.log('  📊 Breakdown:');
    for (const [label, arr] of [['Lv0 ₹20', b1l0], ['Lv0 ₹60', b2l0], ['Lv1 ₹150', b1l1], ['Lv1 ₹350', b2l1]]) {
      if (arr.length > 0) {
        const aw = arr.filter(t => t.won).length;
        const ap = arr.reduce((s, t) => s + t.p, 0);
        console.log(`     ${label}: ${arr.length} trades (${aw}W/${arr.length-aw}L → ${(aw/arr.length*100).toFixed(0)}%) P&L: ${ap >= 0 ? '+' : ''}₹${ap.toFixed(1)}`);
      }
    }

    if (r.trades.length > 0) {
      console.log('  📋 Trade Log:');
      r.trades.forEach((t, i) => {
        const icon = t.won ? '✅' : '❌';
        const ps = t.p >= 0 ? `+₹${t.p.toFixed(1)}` : `-₹${Math.abs(t.p).toFixed(1)}`;
        const rs = t.pnl >= 0 ? `+₹${t.pnl.toFixed(1)}` : `-₹${Math.abs(t.pnl).toFixed(1)}`;
        console.log(`     ${icon} #${i+1} Lv${t.lv}B${t.bn}(₹${t.amt}) ${cn(t.betColor)}→${cn(t.actual)} ${ps} (Total: ${rs})`);
      });
    }
    console.log('');
    gp += r.pnl; gw += w; gl += l; gt += r.trades.length; gwipe += r.wipeouts;
  }

  // Summary
  console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 OVERALL SUMMARY                                                     ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════╝');
  console.log('');
  const owr = gt > 0 ? (gw / gt * 100).toFixed(1) : '0.0';
  console.log(`  📊 Trades: ${gt} (${gw}W/${gl}L → ${owr}%)`);
  console.log(`  💰 TOTAL P&L: ${gp >= 0 ? '+' : ''}₹${gp.toFixed(1)}`);
  console.log(`  🔄 Total Wipeouts: ${gwipe}`);
  if (gt > 0) console.log(`  📈 Avg per trade: ${(gp/gt) >= 0 ? '+' : ''}₹${(gp/gt).toFixed(2)}`);
  console.log('');

  console.log('  ┌────────────┬─────────┬────────┬──────┬───────┬──────────┬────────────┐');
  console.log('  │ Section    │ Periods │ Trades │ Wins │ Losses│ Win Rate │    P&L     │');
  console.log('  ├────────────┼─────────┼────────┼──────┼───────┼──────────┼────────────┤');
  for (const a of all) {
    const wr = a.r.trades.length > 0 ? (a.w / a.r.trades.length * 100).toFixed(1) : '0.0';
    const ps = (a.r.pnl >= 0 ? '+' : '') + '₹' + a.r.pnl.toFixed(1);
    console.log(`  │ ${a.name.padEnd(10)} │ ${String(a.n).padStart(7)} │ ${String(a.r.trades.length).padStart(6)} │ ${String(a.w).padStart(4)} │ ${String(a.l).padStart(5)} │ ${(wr+'%').padStart(8)} │ ${ps.padStart(10)} │`);
  }
  console.log('  └────────────┴─────────┴────────┴──────┴───────┴──────────┴────────────┘');

  console.log('');
  if (gp > 0) console.log(`  ✅ VERDICT: PROFITABLE! +₹${gp.toFixed(1)}`);
  else console.log(`  ❌ VERDICT: NOT PROFITABLE. -₹${Math.abs(gp).toFixed(1)}`);
  console.log('');
}

main();
