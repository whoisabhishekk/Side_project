const fs = require('fs');
let content = fs.readFileSync('app.js', 'utf8');

const targetStr = `    } else {
      scanHistoryForSection(section);
      addLog(\`\${section.emoji} [\${section.name}] Loaded \${newPeriods.length} periods | State: \${section.strategyState}\`, 'info');
      if (!section.pendingBet && !isRgrgSectionLocked(section, activeStrategy)) {
        armBetFromCurrentPattern(key, newNextPeriod);
      }
    }`;

const replaceStr = `    } else {
      if (savedLastKnown > 0) {
        let catchupIdx = newPeriods.findIndex(p => p.period > savedLastKnown);
        if (section.pendingBet) {
          const betIdx = newPeriods.findIndex(p => p.period === section.pendingBet.period);
          if (betIdx !== -1 && (catchupIdx === -1 || betIdx < catchupIdx)) {
            catchupIdx = betIdx;
          }
        }
        
        if (catchupIdx !== -1) {
          addLog(\`🔄 [\${section.name}] Offline catch-up starting from period #\${formatPeriod(newPeriods[catchupIdx].period)}...\`, 'info');
          const catchupPeriods = newPeriods.slice(catchupIdx);
          section.periods = newPeriods.slice(0, catchupIdx);
          
          for (const period of catchupPeriods) {
            section.periods.push(period);
            section.lastKnownPeriod = period.period;
            section.nextPeriod = period.period + 1;
            
            if (section.pendingBet && period.period === section.pendingBet.period) {
              const resolvedBet = section.pendingBet;
              section.pendingBet = null;
              const actualColor = getColor(period);
              const won = actualColor === resolvedBet.color;
              
              if (resolvedBet.isVirtual) {
                if (won) {
                  section.virtualLossCount = 0;
                  section.strategyState = 'HUNTING';
                } else {
                  section.virtualLossCount = Math.min(4, section.virtualLossCount + 1);
                  section.strategyState = 'WAITING_FOR_TREND_BREAK';
                  section.rgrgLiveLoss = false;
                }
              } else {
                section.betHistory.push({ period: period.period, betColor: resolvedBet.color, actualColor, won });
                if (won) {
                  section.totalWins++;
                  section.virtualLossCount = 0;
                  section.lockLossCount = 0;
                } else {
                  section.totalLosses++;
                  section.virtualLossCount = 0;
                  section.lockLossCount = 0;
                }
              }
            }
            
            if (section.strategyState === 'WAITING_FOR_TREND_BREAK') {
              const pLen = section.periods.length;
              if (pLen >= 2 && getColor(section.periods[pLen-2]) === getColor(section.periods[pLen-1])) {
                if (section.virtualLossCount >= 4) {
                  section.strategyState = 'READY_FOR_LIVE';
                } else {
                  section.strategyState = 'HUNTING';
                }
              }
            }
            
            if (!section.pendingBet && (section.strategyState === 'HUNTING' || section.strategyState === 'READY_FOR_LIVE')) {
              armBetFromCurrentPattern(key, section.nextPeriod);
            }
          }
        }
      } else {
        scanHistoryForSection(section);
      }
      
      addLog(\`\${section.emoji} [\${section.name}] Loaded \${newPeriods.length} periods | State: \${section.strategyState}\`, 'info');
      if (!section.pendingBet && !isRgrgSectionLocked(section, activeStrategy)) {
        armBetFromCurrentPattern(key, newNextPeriod);
      }
    }`;

if (content.includes(targetStr)) {
  content = content.replace(targetStr, replaceStr);
  fs.writeFileSync('app.js', content);
  console.log("Offline catchup for old strategies replaced successfully!");
} else {
  console.log("Target string not found.");
}
