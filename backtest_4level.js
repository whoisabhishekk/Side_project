// BACKTEST: 2 Virtual Losses + 4-Level Martingale + RR/GG Reset
// VIOLET RULE: Win on violet = 1.5x payout, Win on pure color = 2x (1.96x after 2% fee)
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('backtest_data.json', 'utf-8'));
const fields = raw.recordFields;
const records = raw.records.map(r => {
  const obj = {};
  fields.forEach((f, i) => obj[f] = r[i]);
  return obj;
});

const sections = { P: [], S: [], B: [], E: [] };
records.forEach(r => sections[r.category].push(r));
const catNames = { P: 'Parity', S: 'Sapre', B: 'Bcone', E: 'Emerd' };

function isAlternating(arr) {
  for (let i = 1; i < arr.length; i++) if (arr[i] === arr[i-1]) return false;
  return true;
}

const BET_AMOUNTS = [10, 30, 90, 270];
let grandPNL = 0, grandWipeouts = 0, grandTrades = 0;
const allResults = {};

for (const [cat, periods] of Object.entries(sections)) {
  let state = 'RGRG_VIRTUAL';
  let pnl = 0, wipeouts = 0, totalTrades = 0;
  let consecVLosses = 0;
  let vSignals = 0, vWins = 0, vLosses = 0;
  let levelWins = [0,0,0,0], levelLosses = [0,0,0,0];
  let rgrgCount = 0, rgGrCount = 0, rrGgResets = 0, lossTriggers = 0;
  let violetWins = 0, pureWins = 0;
  
  let pendingVBet = null;
  let pendingBet = null;
  
  const colors = [];
  let peakPNL = 0, maxDD = 0, maxConsecWipe = 0, curConsecWipe = 0;

  for (let i = 0; i < periods.length; i++) {
    const curr = periods[i].color;
    const isViolet = periods[i].isViolet;
    colors.push(curr);

    // ═══ 1. Resolve pending LIVE bet ═══
    if (pendingBet) {
      const won = curr === pendingBet.color;
      totalTrades++;
      if (won) {
        // VIOLET: 1.5x total return → 0.5x profit
        // PURE COLOR: ~1.96x total return → 0.96x profit (after 2% fee)
        const multiplier = isViolet ? 0.5 : 0.96;
        const winAmount = pendingBet.amount * multiplier;
        pnl += winAmount;
        levelWins[pendingBet.phase]++;
        if (isViolet) violetWins++;
        else pureWins++;
        curConsecWipe = 0;
        state = 'RGRG_VIRTUAL';
        pendingBet = null;
        consecVLosses = 0;
        pendingVBet = null;
      } else {
        pnl -= pendingBet.amount;
        levelLosses[pendingBet.phase]++;
        if (pendingBet.phase < 3) {
          pendingBet = { color: curr, amount: BET_AMOUNTS[pendingBet.phase + 1], phase: pendingBet.phase + 1 };
        } else {
          wipeouts++;
          curConsecWipe++;
          if (curConsecWipe > maxConsecWipe) maxConsecWipe = curConsecWipe;
          state = 'RGRG_VIRTUAL';
          pendingBet = null;
          consecVLosses = 0;
          pendingVBet = null;
        }
      }
      if (pnl > peakPNL) peakPNL = pnl;
      if (peakPNL - pnl > maxDD) maxDD = peakPNL - pnl;
      if (pendingBet) continue;
      continue;
    }

    // ═══ 2. Resolve pending VIRTUAL bet ═══
    if (pendingVBet && i === pendingVBet.resolveIdx) {
      const won = curr === pendingVBet.color;
      vSignals++;
      if (won) {
        vWins++;
        consecVLosses = 0;
      } else {
        vLosses++;
        consecVLosses++;
        if (consecVLosses >= 2) {
          lossTriggers++;
          state = 'WAIT_RG_GR';
          consecVLosses = 0;
        }
      }
      pendingVBet = null;
    }

    if (pendingBet || pendingVBet) continue;

    // ═══ 3. State machine ═══
    if (state === 'RGRG_VIRTUAL') {
      if (colors.length >= 4) {
        const last4 = colors.slice(-4);
        if (isAlternating(last4) && i + 1 < periods.length) {
          rgrgCount++;
          pendingVBet = { color: last4[3], resolveIdx: i + 1 };
        }
      }
    } else if (state === 'WAIT_RG_GR') {
      if (colors.length >= 2) {
        const prev = colors[colors.length - 2];
        if (curr === prev) {
          rrGgResets++;
          state = 'RGRG_VIRTUAL';
        } else {
          rgGrCount++;
          pendingBet = { color: curr, amount: 10, phase: 0 };
        }
      }
    }
  }

  allResults[cat] = { pnl, wipeouts, totalTrades, levelWins, levelLosses,
    rgrgCount, vSignals, vWins, vLosses, lossTriggers, rgGrCount, rrGgResets,
    peakPNL, maxDD, maxConsecWipe, violetWins, pureWins };
  grandPNL += pnl;
  grandWipeouts += wipeouts;
  grandTrades += totalTrades;

  const p = pnl >= 0 ? `+₹${pnl.toFixed(1)}` : `-₹${Math.abs(pnl).toFixed(1)}`;
  console.log(`\n━━━ ${catNames[cat]} (${cat}) — ${periods.length} periods ━━━`);
  console.log(`  RGRG: ${rgrgCount} | Virtual: ${vSignals} (${vWins}W/${vLosses}L) | 2-Loss Triggers: ${lossTriggers}`);
  console.log(`  RG/GR Found: ${rgGrCount} | RR/GG Resets: ${rrGgResets}`);
  console.log(`  Trades: ${totalTrades} | Wipeouts: ${wipeouts} (max consec: ${maxConsecWipe})`);
  console.log(`  Wins: ${levelWins.reduce((a,b)=>a+b,0)} (Pure 1.96x: ${pureWins} | Violet 1.5x: ${violetWins})`);
  for (let l = 0; l < 4; l++) {
    const w = levelWins[l], lo = levelLosses[l], t = w+lo;
    if (t > 0) console.log(`    L${l+1} ₹${BET_AMOUNTS[l]}: ${w}W/${lo}L → ${(w/t*100).toFixed(1)}%`);
  }
  console.log(`  💰 PNL: ${p} | Peak: +₹${peakPNL.toFixed(1)} | Max DD: -₹${maxDD.toFixed(1)}`);
}

const p = grandPNL >= 0 ? `+₹${grandPNL.toFixed(1)}` : `-₹${Math.abs(grandPNL).toFixed(1)}`;
console.log(`\n═══════════════════════════════════════════`);
console.log(`  💰 TOTAL PNL: ${p}`);
console.log(`  💀 Wipeouts: ${grandWipeouts} | Trades: ${grandTrades}`);
const totalVW = Object.values(allResults).reduce((s,r) => s + r.violetWins, 0);
const totalPW = Object.values(allResults).reduce((s,r) => s + r.pureWins, 0);
console.log(`  🟣 Violet Wins: ${totalVW} (1.5x) | 🔴🟢 Pure Wins: ${totalPW} (1.96x)`);
for (const [cat, r] of Object.entries(allResults)) {
  const pp = r.pnl >= 0 ? `+₹${r.pnl.toFixed(1)}` : `-₹${Math.abs(r.pnl).toFixed(1)}`;
  console.log(`     ${catNames[cat]}: ${pp} (${r.wipeouts} wipeouts, ${r.violetWins} violet wins)`);
}
console.log(`═══════════════════════════════════════════\n`);
