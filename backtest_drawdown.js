const fs = require('fs');
const data = JSON.parse(fs.readFileSync('backtest_data.json', 'utf8'));

let allPeriods = [];
data.records.forEach(p => {
  let cat = p[1];
  if (cat === 'B') cat = 'Bcone';
  if (cat === 'S') cat = 'Sapre';
  if (cat === 'P') cat = 'Parity';
  if (cat === 'E') cat = 'Emerd';

  allPeriods.push({
    category: cat,
    period: p[2],
    color: p[3],
    timestamp: new Date(p[7]).getTime()
  });
});

allPeriods.sort((a, b) => a.timestamp - b.timestamp);

const state = {
  Bcone: { phase: 'VIRTUAL', vLosses: 0, bet1Color: null },
  Sapre: { phase: 'VIRTUAL', vLosses: 0, bet1Color: null },
  Parity: { phase: 'VIRTUAL', vLosses: 0, bet1Color: null },
  Emerd: { phase: 'VIRTUAL', vLosses: 0, bet1Color: null }
};

function testDrawdown(initialBalance) {
  let balance = initialBalance;
  let minBalance = initialBalance;
  let maxBalance = initialBalance;
  let isBusted = false;
  
  Object.keys(state).forEach(k => {
    state[k] = { phase: 'VIRTUAL', vLosses: 0, bet1Color: null };
  });

  const history = { Bcone: [], Sapre: [], Parity: [], Emerd: [] };
  
  const isAlternating = (last4) => {
    if(last4.length < 4) return false;
    return last4[0] !== last4[1] && last4[1] !== last4[2] && last4[2] !== last4[3] && last4[0] === last4[2];
  }
  const opp = (c) => c === 'G' ? 'R' : 'G';
  
  for (const p of allPeriods) {
    if (isBusted) break;
    
    const cat = p.category;
    if (!history[cat]) continue;
    
    history[cat].push(p.color);
    const s = state[cat];
    const hist = history[cat];
    
    if (s.phase === 'VIRTUAL') {
      if (hist.length >= 4 && isAlternating(hist.slice(-4))) {
        s.vLosses++;
        if (s.vLosses >= 2) {
          s.phase = 'WAIT_RG_GR';
        }
      }
    } else if (s.phase === 'WAIT_RG_GR') {
      if (hist.length >= 2) {
        const prev = hist[hist.length-2];
        const curr = hist[hist.length-1];
        if (prev !== curr) { 
          s.phase = 'BET_1';
          s.bet1Color = curr; 
        }
      }
    } else if (s.phase === 'BET_1') {
      balance -= 30; // ⚠️ BET 1 = 30
      if (balance < 0) { isBusted = true; break; }
      
      if (p.color === s.bet1Color) {
        balance += 30 * 1.96; // Win
        s.phase = 'VIRTUAL';
        s.vLosses = 0;
      } else {
        s.phase = 'BET_2';
      }
    } else if (s.phase === 'BET_2') {
      const bet2Color = opp(s.bet1Color);
      balance -= 90; // ⚠️ BET 2 = 90
      if (balance < 0) { isBusted = true; break; }
      
      if (p.color === bet2Color) {
        balance += 90 * 1.96; // Win
      }
      s.phase = 'VIRTUAL';
      s.vLosses = 0;
    }
    
    if (balance < minBalance) minBalance = balance;
    if (balance > maxBalance) maxBalance = balance;
  }
  return { minBalance, maxBalance, finalBalance: balance, isBusted };
}

const res3000 = testDrawdown(3000);
console.log(`Initial: ₹3000 | Lowest: ₹${res3000.minBalance.toFixed(2)} | Final: ₹${res3000.finalBalance.toFixed(2)} | Busted? ${res3000.isBusted ? 'YES 💀' : 'NO ✅'}`);
