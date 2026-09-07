const fs = require('fs');
const data = JSON.parse(fs.readFileSync('backtest_data.json', 'utf8'));
const records = data.records;
const VIRTUAL_LOSS_TARGET = 10;
const sections = ['P', 'S', 'B', 'E'];

for (const cat of sections) {
  const catRecords = records.filter(r => r[1] === cat).sort((a, b) => a[2] - b[2]); // Sort by period
  
  let virtualLossCount = 0;
  let strategyState = 'HUNTING';
  let targetHits = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let pendingBet = null;

  for (let i = 0; i < catRecords.length; i++) {
    const record = catRecords[i];
    const actualColor = record[3]; // 'R' or 'G'

    if (pendingBet) {
      const won = actualColor === pendingBet.color;
      if (pendingBet.isVirtual) {
        if (won) {
          virtualLossCount = 0;
          strategyState = 'HUNTING';
        } else {
          virtualLossCount = Math.min(10, virtualLossCount + 1);
          strategyState = 'WAITING_FOR_TREND_BREAK';
          if (virtualLossCount >= VIRTUAL_LOSS_TARGET) targetHits++;
        }
      } else {
        trades++;
        if (won) wins++; else losses++;
        virtualLossCount = 0;
        strategyState = 'HUNTING';
      }
      pendingBet = null;
    }

    if (strategyState === 'WAITING_FOR_TREND_BREAK') {
      if (i > 0 && catRecords[i-1][3] === actualColor) {
        if (virtualLossCount >= VIRTUAL_LOSS_TARGET) strategyState = 'READY_FOR_LIVE';
        else strategyState = 'HUNTING';
      }
    }

    if (!pendingBet && (strategyState === 'HUNTING' || strategyState === 'READY_FOR_LIVE')) {
      if (i >= 3) {
        const pColors = catRecords.slice(i-3, i+1).map(r => r[3]);
        const isAlternating = pColors.every((c, idx) => idx === 0 || c !== pColors[idx - 1]);
        if (isAlternating) {
          const betColor = pColors[3];
          if (strategyState === 'READY_FOR_LIVE') {
            pendingBet = { color: betColor, isVirtual: false };
            strategyState = 'SIGNAL_ACTIVE';
          } else {
            pendingBet = { color: betColor, isVirtual: true };
          }
        }
      }
    }
  }
  console.log(`[${cat}] 10-Virtual-Loss Triggers: ${targetHits} | Live Trades: ${trades} | Wins: ${wins} | Losses: ${losses}`);
}
