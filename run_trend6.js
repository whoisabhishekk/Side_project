const fs = require('fs');

const WX = 0.96;
const LADDER = [80, 240];
const MAX_DAILY_LOSSES = 8;
const START_BALANCE = 1600;

const raw = fs.readFileSync('/Users/abhishek/Desktop/Color_prediction/backtest_data.json', 'utf8');
const data = JSON.parse(raw);
const f = data.recordFields;
const byCategory = {};

for (const rec of data.records) {
  const cat = rec[f.indexOf('category')];
  if (!byCategory[cat]) byCategory[cat] = [];
  byCategory[cat].push({
    period: rec[f.indexOf('period')],
    is_green: rec[f.indexOf('isGreen')],
    color: rec[f.indexOf('color')]
  });
}
for (const c of Object.keys(byCategory)) byCategory[c].sort((a, b) => a.period - b.period);

function gc(p) { return (p.is_green || p.color === 'G') ? 'G' : 'R'; }

function trendFollow(periods, streakLen, ladder, maxDL) {
  const maxLvl = ladder.length;
  let bet = null, lvl = 0;
  const trades = [];
  let dl = {};

  for (let i = 0; i < periods.length; i++) {
    const cc = gc(periods[i]);
    const dateStr = String(periods[i].period).substring(0, 8);

    if (bet && bet.idx === i) {
      const won = cc === bet.color;
      const amt = bet.amt;
      const p = won ? amt * WX : -amt;
      trades.push({ won, amt, p, lvl: bet.lvl, date: dateStr, period: periods[i].period });

      if (won) { lvl = 0; }
      else {
        lvl++;
        if (lvl >= maxLvl) lvl = 0;
        dl[dateStr] = (dl[dateStr] || 0) + 1;
      }
      bet = null;
      continue;
    }
    if (bet) continue;

    if (maxDL) {
      if ((dl[dateStr] || 0) >= maxDL) continue;
    }

    if (i >= streakLen) {
      let allSame = true;
      const sc = gc(periods[i]);
      for (let j = i - streakLen + 1; j <= i; j++) {
        if (gc(periods[j]) !== sc) { allSame = false; break; }
      }
      if (allSame && i + 1 < periods.length) {
        bet = { color: sc, idx: i + 1, amt: ladder[Math.min(lvl, maxLvl - 1)], lvl };
      }
    }
  }
  return trades;
}

// Run for S+B+E
const allTrades = [];
for (const sec of ['S', 'B', 'E']) {
  const t = trendFollow(byCategory[sec], 6, LADDER, MAX_DAILY_LOSSES);
  t.forEach(tr => { tr.sec = sec; allTrades.push(tr); });
}

// Daily PNL
const dailyPnl = {};
for (const t of allTrades) {
  dailyPnl[t.date] = (dailyPnl[t.date] || 0) + t.p;
}

const tw = allTrades.filter(t => t.won).length;
const tl = allTrades.length - tw;
const wr = (tw / allTrades.length * 100).toFixed(1);
const totalProfit = allTrades.reduce((s, t) => s + t.p, 0);

console.log('=== TREND6 FOLLOW BACKTEST (New Data) ===');
console.log('Sections: S + B + E | Ladder: 80 -> 240 | Max Loss/Day: 8');
console.log('-------------------------------------------');

let balance = START_BALANCE;
const dates = Object.keys(dailyPnl).sort();
for (const d of dates) {
  const pnl = dailyPnl[d];
  balance += pnl;
  const emoji = pnl >= 0 ? '🟢' : '🔴';
  const dateFormatted = d.substring(0, 4) + '-' + d.substring(4, 6) + '-' + d.substring(6, 8);
  console.log(`${emoji} ${dateFormatted} | PNL: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)} | Balance: ₹${balance.toFixed(0)}`);
}

console.log('-------------------------------------------');
console.log(`Total Trades: ${allTrades.length} (${tw}W / ${tl}L)`);
console.log(`Win Rate: ${wr}%`);
console.log(`Total Profit: ${totalProfit >= 0 ? '+' : ''}₹${totalProfit.toFixed(0)}`);
console.log(`Final Balance: ₹${balance.toFixed(0)}`);

// Also test Flat 100
console.log('\n\n=== COMPARISON: FLAT ₹100 (No Recovery) ===');
const allTradesFlat = [];
for (const sec of ['S', 'B', 'E']) {
  const t = trendFollow(byCategory[sec], 6, [100], MAX_DAILY_LOSSES);
  t.forEach(tr => { tr.sec = sec; allTradesFlat.push(tr); });
}
const dailyPnlFlat = {};
for (const t of allTradesFlat) {
  dailyPnlFlat[t.date] = (dailyPnlFlat[t.date] || 0) + t.p;
}
const twF = allTradesFlat.filter(t => t.won).length;
const tlF = allTradesFlat.length - twF;
const wrF = (twF / allTradesFlat.length * 100).toFixed(1);
const totalProfitF = allTradesFlat.reduce((s, t) => s + t.p, 0);

let balF = START_BALANCE;
const datesF = Object.keys(dailyPnlFlat).sort();
for (const d of datesF) {
  const pnl = dailyPnlFlat[d];
  balF += pnl;
  const emoji = pnl >= 0 ? '🟢' : '🔴';
  const dateFormatted = d.substring(0, 4) + '-' + d.substring(4, 6) + '-' + d.substring(6, 8);
  console.log(`${emoji} ${dateFormatted} | PNL: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)} | Balance: ₹${balF.toFixed(0)}`);
}
console.log('-------------------------------------------');
console.log(`Total Trades: ${allTradesFlat.length} (${twF}W / ${tlF}L)`);
console.log(`Win Rate: ${wrF}%`);
console.log(`Total Profit: ${totalProfitF >= 0 ? '+' : ''}₹${totalProfitF.toFixed(0)}`);
console.log(`Final Balance: ₹${balF.toFixed(0)}`);
