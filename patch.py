import re

with open('app.js', 'r') as f:
    content = f.read()

# Replace in showTradeSignal
old_notif = """  } else if (strategy === 'STREAK_5_CONTINUE') {
    const betAmt = STREAK5_CONFIG.BET_LADDER[section.streak5Level || 0];
    notifTitle = `🔥 5-Streak: ${section.name}`;
    notifBody = `Bet ${betColor} ₹${betAmt} (Lv${(section.streak5Level || 0) + 1}) on #${periodStr}!`;
  }"""

new_notif = """  } else if (strategy === 'STREAK_5_CONTINUE') {
    const betAmt = STREAK5_CONFIG.BET_LADDER[section.streak5Level || 0];
    notifTitle = `🔥 5-Streak: ${section.name}`;
    notifBody = `Bet ${betColor} ₹${betAmt} (Lv${(section.streak5Level || 0) + 1}) on #${periodStr}!`;
  } else if (strategy === 'RGRG_LOCK_RESET') {
    const betAmt = section.liveRecovery ? 90 : 30;
    const betLabel = section.liveRecovery ? 'Recovery' : 'LIVE';
    notifTitle = `🎯 ${betLabel}: ${section.name}`;
    notifBody = `Bet ${betColor} ₹${betAmt} on Period #${periodStr}!`;
  }"""
content = content.replace(old_notif, new_notif)

# Replace UI string
old_ui = """    } else if (strategy === 'RGRG_LOCK_RESET') {
      const betLabel = section.liveRecovery ? '🔄 Recovery' : '🎯 LIVE';
      colorEl.textContent = `${betLabel}: ${betColorLabel} pe lagao!`;"""

new_ui = """    } else if (strategy === 'RGRG_LOCK_RESET') {
      const betAmt = section.liveRecovery ? 90 : 30;
      const betLabel = section.liveRecovery ? '🔄 Recovery' : '🎯 LIVE';
      colorEl.textContent = `${betLabel}: ₹${betAmt} ${betColorLabel} pe lagao!`;"""
content = content.replace(old_ui, new_ui)

with open('app.js', 'w') as f:
    f.write(content)
