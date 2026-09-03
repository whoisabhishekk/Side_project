/**
 * User's Custom Money Management Strategy Backtest
 * 
 * Strategy Rules:
 * 1. Wait for 1st Virtual Loss on signal.
 * 2. TIER 0: Bet 30 -> 90
 *    - If win: Reset to wait for 1st loss.
 *    - If loss: Move to TIER 1.
 * 3. TIER 1: Wait for a WIN, then wait for 1st LOSS, then Bet 90 -> 270
 *    - If win: Reset to wait for 1st loss (Tier 0).
 *    - If loss: Move to TIER 2.
 * 4. TIER 2: Wait for a WIN, then wait for 1st LOSS, then Bet 270 -> 810
 *    - If win: Reset to wait for 1st loss (Tier 0).
 *    - If loss: FULL BUST. Reset to wait for 1st loss (Tier 0).
 */

const fs = require('fs');

// We load the dataset (replace this path if needed)
const dataPath = '/Users/abhishek/.gemini/antigravity/brain/eca64f1e-8400-4abe-b4fb-1d190eb1d67d/scratch/data.json';
let rawData;
try {
  rawData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
} catch (e) {
  console.error("Could not load data.json. Ensure it exists.");
  process.exit(1);
}

const records = rawData.data;
records.sort((a, b) => a.period - b.period);

const WIN_MULTIPLIER = 0.96;
const TIERS = [
  [30, 90],
  [90, 270],
  [270, 810]
];

// DUMMY SIGNAL LOGIC: Modify this to your actual signal (e.g., RGR, Last Color, etc.)
function getSignal(history) {
  if (history.length === 0) return null;
  return history[history.length - 1]; // Play last color
}

const categories = ['P_color', 'B_color', 'E_color', 'S_color'];

for (const cat of categories) {
  console.log(`\n========== BACKTEST: ${cat} ==========`);
  
  let balance = 0;
  let maxBalance = 0;
  let minBalance = 0;
  let history = [];
  
  let state = 'WAIT_1ST_LOSS';
  let currentTier = 0;
  let betStep = 0;
  
  let wins = 0;
  let losses = 0;
  let busts = 0;

  for (const record of records) {
    const actual = record[cat];
    const signal = getSignal(history);
    history.push(actual);
    
    if (!signal) continue;
    
    const isWin = (signal === actual);
    
    if (state === 'WAIT_1ST_LOSS') {
      if (!isWin) {
        state = 'BET';
        betStep = 0;
      }
    } else if (state === 'BET') {
      const betAmt = TIERS[currentTier][betStep];
      
      if (isWin) {
        balance += betAmt * WIN_MULTIPLIER;
        wins++;
        // Reset to normal
        currentTier = 0;
        state = 'WAIT_1ST_LOSS';
      } else {
        balance -= betAmt;
        losses++;
        betStep++;
        
        if (betStep >= TIERS[currentTier].length) {
          // Tier Failed!
          currentTier++;
          if (currentTier >= TIERS.length) {
            busts++;
            currentTier = 0; // Reset after full bust
          }
          state = 'WAIT_WIN';
        }
      }
      
      if (balance > maxBalance) maxBalance = balance;
      if (balance < minBalance) minBalance = balance;
      
    } else if (state === 'WAIT_WIN') {
      if (isWin) {
        state = 'WAIT_1ST_LOSS';
      }
    }
  }
  
  console.log(`Final Balance:  ₹${balance.toFixed(2)}`);
  console.log(`Max Balance:    ₹${maxBalance.toFixed(2)}`);
  console.log(`Min Balance:    ₹${minBalance.toFixed(2)}`);
  console.log(`Total Wins:     ${wins}`);
  console.log(`Total Losses:   ${losses}`);
  console.log(`Full Busts:     ${busts}`);
}
