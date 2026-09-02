#!/usr/bin/env node
/**
 * BACKTEST: 2-Loss Triggered RG/GR Pattern Strategy
 * 
 * Strategy Flow:
 * ══════════════════════════════════════════════════════════════
 * Phase 1 (RGRG_VIRTUAL):
 *   - Run RGRG/GRGR 4-length alternating pattern detection virtually
 *   - Bet same as last color (expecting alternation break)
 *   - Track virtually, count consecutive LOSSES
 *   - After 2 consecutive virtual LOSSES → activate sub-strategy
 * 
 * Phase 2 (WAIT_RG_GR):
 *   - After 2nd virtual loss, watch for RG or GR pattern
 *   - Skip RR/GG (same color pairs)
 * 
 * Phase 3 (BET_1):
 *   - RG found → Bet G (last color)
 *   - GR found → Bet R (last color)
 *   - If WIN → reset to Phase 1
 *   - If LOSS → go to Phase 4
 * 
 * Phase 4 (BET_2):
 *   - Bet OPPOSITE of Bet 1 color
 *   - RG→G lost → now bet R
 *   - GR→R lost → now bet G
 *   - WIN or LOSS → reset to Phase 1
 * ══════════════════════════════════════════════════════════════
 * 
 * Data Source: backtest_data.json (IndexedDB export)
 * Payout: 1.96x (0.96 profit per ₹1 bet, 4% platform fee)
 */

const fs = require('fs');
const path = require('path');

// ─── Constants ───────────────────────────────────────────────
const BET1_AMOUNT = 100;       // Bet 1 amount
const BET2_AMOUNT = 300;       // Bet 2 amount (recovery)
const WIN_MULTIPLIER = 0.96;   // profit on win = bet * 0.96
const PATTERN_LENGTH = 4;      // RGRG alternating detection length
const VIRTUAL_LOSS_THRESHOLD = 2; // activate after 2 consecutive virtual losses

// ─── Data Loading ────────────────────────────────────────────
function loadData() {
  const dataPath = path.join(__dirname, 'backtest_data.json');
  let rawData;
  try {
    rawData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  } catch (e) {
    console.error('❌ Could not load backtest_data.json. Ensure it exists in the same directory.');
    console.error(e.message);
    process.exit(1);
  }

  const fields = rawData.recordFields;
  const categoryData = { P: [], S: [], B: [], E: [] };

  for (const rec of rawData.records) {
    const obj = {};
    for (let i = 0; i < fields.length; i++) {
      obj[fields[i]] = rec[i];
    }
    if (categoryData[obj.category]) {
      categoryData[obj.category].push(obj);
    }
  }

  for (const cat of Object.keys(categoryData)) {
    categoryData[cat].sort((a, b) => a.period - b.period);
  }

  return { categoryData, meta: { totalRecords: rawData.totalRecords, dateRange: rawData.dateRange } };
}

// ─── Helpers ─────────────────────────────────────────────────
function isAlternating(colors) {
  for (let i = 1; i < colors.length; i++) {
    if (colors[i] === colors[i - 1]) return false;
  }
  return true;
}

function oppositeColor(c) {
  return c === 'R' ? 'G' : 'R';
}

// ─── Core Backtest Engine ────────────────────────────────────
function runBacktest(periods) {
  const RGRG_VIRTUAL = 'RGRG_VIRTUAL';
  const WAIT_RG_GR = 'WAIT_RG_GR';
  const BET_1 = 'BET_1';
  const BET_2 = 'BET_2';

  let state = RGRG_VIRTUAL;

  // RGRG virtual tracking
  let rgrgVirtualSignals = 0;
  let rgrgVirtualWins = 0;
  let rgrgVirtualLosses = 0;
  let consecutiveVirtualLosses = 0;  // track consecutive losses
  let pendingVirtualBet = null;

  // Sub-strategy tracking
  let lossTriggers = 0;              // how many times 2-loss triggered sub-strategy
  let rgGrPatternsFound = 0;
  let bet1Color = null;
  let pendingLiveBet = null;

  // Results
  const liveTrades = [];
  let totalPNL = 0;
  let bet1Wins = 0, bet1Losses = 0;
  let bet2Wins = 0, bet2Losses = 0;
  let maxConsecutiveLiveLosses = 0;
  let currentConsecutiveLiveLosses = 0;
  let maxDrawdown = 0;
  let peakBalance = 0;

  // Full cycle loss tracking (Bet1 + Bet2 both lose = 1 cycle loss)
  let maxConsecutiveCycleLosses = 0;
  let currentConsecutiveCycleLosses = 0;
  let totalCycleWins = 0;
  let totalCycleLosses = 0;

  const colorHistory = [];

  for (let i = 0; i < periods.length; i++) {
    const currentColor = periods[i].color;
    colorHistory.push(currentColor);

    // ═══ Resolve pending LIVE bet ═══
    if (pendingLiveBet && periods[i].period === pendingLiveBet.period) {
      const won = currentColor === pendingLiveBet.color;
      const betAmt = pendingLiveBet.betNumber === 1 ? BET1_AMOUNT : BET2_AMOUNT;
      const pnl = won ? betAmt * WIN_MULTIPLIER : -betAmt;
      totalPNL += pnl;

      if (totalPNL > peakBalance) peakBalance = totalPNL;
      const drawdown = peakBalance - totalPNL;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      if (won) {
        currentConsecutiveLiveLosses = 0;
      } else {
        currentConsecutiveLiveLosses++;
        if (currentConsecutiveLiveLosses > maxConsecutiveLiveLosses) {
          maxConsecutiveLiveLosses = currentConsecutiveLiveLosses;
        }
      }

      liveTrades.push({
        period: periods[i].period,
        betColor: pendingLiveBet.color,
        actualColor: currentColor,
        betNumber: pendingLiveBet.betNumber,
        trigger: pendingLiveBet.trigger,
        betAmount: betAmt,
        won,
        pnl,
        runningPNL: totalPNL
      });

      if (pendingLiveBet.betNumber === 1) {
        if (won) {
          bet1Wins++;
          state = RGRG_VIRTUAL;
          pendingVirtualBet = null;
          consecutiveVirtualLosses = 0;
          // Cycle WIN (Bet 1 won)
          totalCycleWins++;
          currentConsecutiveCycleLosses = 0;
        } else {
          bet1Losses++;
          state = BET_2;
        }
      } else if (pendingLiveBet.betNumber === 2) {
        if (won) {
          bet2Wins++;
          // Cycle WIN (Bet 2 recovered)
          totalCycleWins++;
          currentConsecutiveCycleLosses = 0;
        } else {
          bet2Losses++;
          // Cycle LOSS (both Bet 1 and Bet 2 lost = full bust)
          totalCycleLosses++;
          currentConsecutiveCycleLosses++;
          if (currentConsecutiveCycleLosses > maxConsecutiveCycleLosses) {
            maxConsecutiveCycleLosses = currentConsecutiveCycleLosses;
          }
        }
        state = RGRG_VIRTUAL;
        pendingVirtualBet = null;
        consecutiveVirtualLosses = 0;
      }

      pendingLiveBet = null;
      continue;
    }

    // ═══ Resolve pending VIRTUAL bet ═══
    if (pendingVirtualBet && periods[i].period === pendingVirtualBet.period) {
      const won = currentColor === pendingVirtualBet.color;
      rgrgVirtualSignals++;

      if (won) {
        rgrgVirtualWins++;
        consecutiveVirtualLosses = 0;  // reset consecutive loss counter
      } else {
        rgrgVirtualLosses++;
        consecutiveVirtualLosses++;

        // Check if we hit the loss threshold → activate sub-strategy!
        if (consecutiveVirtualLosses >= VIRTUAL_LOSS_THRESHOLD) {
          lossTriggers++;
          state = WAIT_RG_GR;
          consecutiveVirtualLosses = 0;  // reset for next cycle
        }
      }

      pendingVirtualBet = null;
    }

    if (pendingLiveBet || pendingVirtualBet) continue;

    // ═══ State Machine Logic ═══

    if (state === RGRG_VIRTUAL) {
      if (colorHistory.length < PATTERN_LENGTH) continue;

      const last4 = colorHistory.slice(-PATTERN_LENGTH);
      if (!isAlternating(last4)) continue;

      if (i + 1 >= periods.length) continue;

      const betColor = last4[last4.length - 1];
      pendingVirtualBet = {
        color: betColor,
        period: periods[i + 1].period
      };

    } else if (state === WAIT_RG_GR) {
      if (colorHistory.length < 2) continue;

      const prev = colorHistory[colorHistory.length - 2];
      const curr = colorHistory[colorHistory.length - 1];

      if (prev === curr) continue; // RR or GG → skip

      // RG or GR found!
      rgGrPatternsFound++;

      if (i + 1 >= periods.length) continue;

      bet1Color = curr;
      const trigger = `${prev}${curr}→${curr}`;

      pendingLiveBet = {
        color: curr,
        period: periods[i + 1].period,
        betNumber: 1,
        trigger
      };
      state = BET_1;

    } else if (state === BET_2) {
      if (i + 1 >= periods.length) {
        state = RGRG_VIRTUAL;
        continue;
      }

      const oppColor = oppositeColor(bet1Color);
      const trigger = `${bet1Color} LOSS→${oppColor}`;

      pendingLiveBet = {
        color: oppColor,
        period: periods[i + 1].period,
        betNumber: 2,
        trigger
      };
    }
  }

  return {
    rgrgVirtualSignals,
    rgrgVirtualWins,
    rgrgVirtualLosses,
    lossTriggers,
    rgGrPatternsFound,
    bet1Wins,
    bet1Losses,
    bet2Wins,
    bet2Losses,
    liveTrades,
    totalPNL,
    maxConsecutiveLiveLosses,
    maxDrawdown,
    peakBalance,
    totalPeriods: periods.length,
    // Cycle stats
    totalCycleWins,
    totalCycleLosses,
    maxConsecutiveCycleLosses
  };
}

// ─── Pretty Print Results ────────────────────────────────────
function printCategoryResult(catName, catCode, result) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${catName} (${catCode}) — ${result.totalPeriods} periods`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const vWinRate = result.rgrgVirtualSignals > 0
    ? (result.rgrgVirtualWins / result.rgrgVirtualSignals * 100).toFixed(1)
    : '0.0';
  console.log(`\n  👁️  Phase 1 — RGRG Virtual Tracking:`);
  console.log(`     Signals: ${result.rgrgVirtualSignals}  (${result.rgrgVirtualWins}W / ${result.rgrgVirtualLosses}L → ${vWinRate}%)`);
  console.log(`     2-Loss Triggers (→ activated sub-strategy): ${result.lossTriggers}`);

  const totalLiveTrades = result.bet1Wins + result.bet1Losses + result.bet2Wins + result.bet2Losses;
  const totalLiveWins = result.bet1Wins + result.bet2Wins;
  const totalLiveLosses = result.bet1Losses + result.bet2Losses;
  const lWinRate = totalLiveTrades > 0
    ? (totalLiveWins / totalLiveTrades * 100).toFixed(1) : '0.0';

  console.log(`\n  🎯 Phase 2-4 — Live Trading:`);
  console.log(`     RG/GR patterns found: ${result.rgGrPatternsFound}`);
  console.log(`     Bet 1 (last color):     ${result.bet1Wins}W / ${result.bet1Losses}L`);
  console.log(`     Bet 2 (opposite color): ${result.bet2Wins}W / ${result.bet2Losses}L`);
  console.log(`     Total live trades: ${totalLiveTrades}  (${totalLiveWins}W / ${totalLiveLosses}L → ${lWinRate}%)`);

  const pnlStr = result.totalPNL >= 0
    ? `+₹${result.totalPNL.toFixed(1)}`
    : `-₹${Math.abs(result.totalPNL).toFixed(1)}`;
  console.log(`\n  💰 P&L: ${pnlStr}`);
  console.log(`     Peak balance: +₹${result.peakBalance.toFixed(1)}`);
  console.log(`     Max drawdown: -₹${result.maxDrawdown.toFixed(1)}`);
  console.log(`     Max consecutive live losses: ${result.maxConsecutiveLiveLosses}`);

  // Cycle stats (Bet1+Bet2 = 1 entry)
  const cycleLossAmt = BET1_AMOUNT + BET2_AMOUNT;
  console.log(`\n  🔄 Entry Cycles (₹${BET1_AMOUNT}+₹${BET2_AMOUNT} = ₹${cycleLossAmt}/cycle):`);
  console.log(`     Cycle Wins: ${result.totalCycleWins}  |  Cycle Losses: ${result.totalCycleLosses}`);
  console.log(`     ⚠️  Max consecutive FULL losses (both bets lose): ${result.maxConsecutiveCycleLosses}`);
  if (result.maxConsecutiveCycleLosses > 0) {
    console.log(`     💸 Worst streak cost: -₹${(result.maxConsecutiveCycleLosses * cycleLossAmt).toFixed(0)}`);
  }

  if (result.liveTrades.length > 0) {
    console.log(`\n  📋 Trade Log:`);
    result.liveTrades.forEach((t, idx) => {
      const icon = t.won ? '✅' : '❌';
      const betLabel = t.betNumber === 1 ? 'B1' : 'B2';
      const pnlStr = t.pnl >= 0 ? `+₹${t.pnl.toFixed(1)}` : `-₹${Math.abs(t.pnl).toFixed(1)}`;
      const runStr = t.runningPNL >= 0
        ? `+₹${t.runningPNL.toFixed(1)}`
        : `-₹${Math.abs(t.runningPNL).toFixed(1)}`;
      console.log(`     ${icon} #${String(idx + 1).padStart(3)}  [${betLabel}]  ${t.trigger.padEnd(14)}  Bet ${t.betColor} → ${t.actualColor}  ₹${t.betAmount}  ${pnlStr.padStart(8)}  (Run: ${runStr})`);
    });
  }
}

// ─── Main ────────────────────────────────────────────────────
function main() {
  const { categoryData, meta } = loadData();
  const categoryNames = { P: 'Parity', S: 'Sapre', B: 'Bcone', E: 'Emerd' };
  const categories = ['P', 'S', 'B', 'E'];

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  📊 BACKTEST: 2-Loss Triggered RG/GR Pattern Strategy');
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  Phase 1: RGRG virtual → count consecutive losses');
  console.log(`  Trigger: After ${VIRTUAL_LOSS_THRESHOLD} consecutive virtual LOSSES → activate`);
  console.log('  Phase 2: Wait for RG/GR pattern');
  console.log('  Phase 3: Bet 1 = last color (RG→G, GR→R)');
  console.log('  Phase 4: Bet 2 = opposite (G→R, R→G)');
  console.log(`  Bet 1: ₹${BET1_AMOUNT} | Bet 2: ₹${BET2_AMOUNT} | Payout: 1.96x | Max 2 bets/entry`);
  console.log(`  Data: ${meta.totalRecords} records | ${meta.dateRange.from.split('T')[0]} → ${meta.dateRange.to.split('T')[0]}`);
  console.log('═══════════════════════════════════════════════════════════════════');

  let grandPNL = 0;
  let grandVirtualSignals = 0, grandVirtualWins = 0, grandVirtualLosses = 0;
  let grandLossTriggers = 0, grandRgGrPatterns = 0;
  let grandBet1W = 0, grandBet1L = 0, grandBet2W = 0, grandBet2L = 0;
  let grandMaxConsecLoss = 0;

  for (const cat of categories) {
    const periods = categoryData[cat];
    if (!periods || periods.length === 0) {
      console.log(`\n  ⚠️  ${categoryNames[cat]} (${cat}): No data`);
      continue;
    }

    const result = runBacktest(periods);
    printCategoryResult(categoryNames[cat], cat, result);

    grandPNL += result.totalPNL;
    grandVirtualSignals += result.rgrgVirtualSignals;
    grandVirtualWins += result.rgrgVirtualWins;
    grandVirtualLosses += result.rgrgVirtualLosses;
    grandLossTriggers += result.lossTriggers;
    grandRgGrPatterns += result.rgGrPatternsFound;
    grandBet1W += result.bet1Wins;
    grandBet1L += result.bet1Losses;
    grandBet2W += result.bet2Wins;
    grandBet2L += result.bet2Losses;
    if (result.maxConsecutiveLiveLosses > grandMaxConsecLoss) {
      grandMaxConsecLoss = result.maxConsecutiveLiveLosses;
    }
  }

  // ═══ OVERALL SUMMARY ═══
  const totalLive = grandBet1W + grandBet1L + grandBet2W + grandBet2L;
  const totalWins = grandBet1W + grandBet2W;
  const totalLosses = grandBet1L + grandBet2L;

  console.log('\n\n═══════════════════════════════════════════════════════════════════');
  console.log('  📊 OVERALL SUMMARY (All 4 Sections)');
  console.log('═══════════════════════════════════════════════════════════════════');

  const overallVWR = grandVirtualSignals > 0
    ? (grandVirtualWins / grandVirtualSignals * 100).toFixed(1) : '0.0';
  console.log(`\n  👁️  Virtual RGRG: ${grandVirtualSignals} signals  (${grandVirtualWins}W / ${grandVirtualLosses}L → ${overallVWR}%)`);
  console.log(`  🎯 2-Loss Triggers: ${grandLossTriggers}`);
  console.log(`  🔄 RG/GR Patterns: ${grandRgGrPatterns}`);

  console.log(`\n  📊 Live Trades: ${totalLive}`);
  console.log(`     Bet 1 (last color):     ${grandBet1W}W / ${grandBet1L}L → ${(grandBet1W + grandBet1L) > 0 ? (grandBet1W / (grandBet1W + grandBet1L) * 100).toFixed(1) : '0.0'}%`);
  console.log(`     Bet 2 (opposite color): ${grandBet2W}W / ${grandBet2L}L → ${(grandBet2W + grandBet2L) > 0 ? (grandBet2W / (grandBet2W + grandBet2L) * 100).toFixed(1) : '0.0'}%`);

  const overallWR = totalLive > 0 ? (totalWins / totalLive * 100).toFixed(1) : '0.0';
  console.log(`     Combined: ${totalWins}W / ${totalLosses}L → ${overallWR}%`);

  const grandPNLStr = grandPNL >= 0
    ? `+₹${grandPNL.toFixed(1)}`
    : `-₹${Math.abs(grandPNL).toFixed(1)}`;
  console.log(`\n  💰 TOTAL P&L: ${grandPNLStr}`);

  if (totalLive > 0) {
    const avgPNL = grandPNL / totalLive;
    console.log(`  📈 Avg P&L per trade: ${avgPNL >= 0 ? '+' : ''}₹${avgPNL.toFixed(2)}`);
  }
  console.log(`  🔥 Max consecutive live losses: ${grandMaxConsecLoss}`);

  console.log(`\n  📋 Strategy Recap:`);
  console.log(`     Phase 1: RGRG/GRGR (4-len alternating) → virtual bet last color`);
  console.log(`     Trigger: ${VIRTUAL_LOSS_THRESHOLD} consecutive virtual LOSSES → activate`);
  console.log(`     Phase 2: Wait for RG or GR`);
  console.log(`     Phase 3: Bet 1 = last color (RG→G, GR→R)`);
  console.log(`     Phase 4: Bet 2 = opposite (G→R, R→G)`);
  console.log(`     Reset after Bet 1 WIN or Bet 2 (any result)`);

  console.log('\n═══════════════════════════════════════════════════════════════════\n');
}

main();
