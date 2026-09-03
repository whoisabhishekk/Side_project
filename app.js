/* ==============================================
   WINGO STRATEGY DASHBOARD - Application Logic
   Pattern Detection | Signal System | Live Data
   ============================================== */

// ============ CONFIGURATION ============
const CONFIG = {
  // Local proxy handles CORS — requests go to /api/win/... → proxied to cooe02.in
  API_BASE: '/api',
  FRESH_SIGNAL_STORAGE_KEY: 'wingo-fresh-signal-state',
  RGRG_LOCK_STORAGE_KEY: 'wingo-rgrg-virtual-lock-state-v2',
  SAAS_ID: 1,
  REFRESH_INTERVAL: 10000,       // 10 seconds (safety-net background poll)
  PERIOD_DURATION_MS: 180000,    // 3 minutes = 180 seconds per color period
  PATTERN_LENGTH: 4,             // RGRG or GRGR (4-length for higher accuracy)
  MAX_LOG_ENTRIES: 80,
  MAX_DOTS_DISPLAY: 30,
  SECTIONS: {
    P: { name: 'Parity', emoji: '🎯' },
    S: { name: 'Sapre',  emoji: '⚡' },
    B: { name: 'Bcone',  emoji: '🔥' },
    E: { name: 'Emerd',  emoji: '💎' }
  }
};

const DEFAULT_STRATEGY = 'RGRG_LOCK_RESET';
const HIDDEN_STRATEGIES = new Set(['STREAK_5_CONTINUE']);

function getInitialStrategy() {
  localStorage.setItem('wingo-selected-strategy', DEFAULT_STRATEGY);
  return DEFAULT_STRATEGY;
}

// ============ APPLICATION STATE ============
const state = {
  sections: {},
  logs: [],
  refreshTimer: null,
  refreshProgress: 0,
  progressTimer: null,
  initialized: false,
  lastSignalSoundTime: 0,
  lastNotifiedPeriod: 0,   // Prevents spamming duplicate alerts for the same period
  nextBoundaryTimer: null,   // setTimeout ID for the next 3-min boundary fetch
  boundaryFollowUp1: null,   // Follow-up fetch 3s after boundary
  boundaryFollowUp2: null,   // Follow-up fetch 8s after boundary
  countdownInterval: null,   // setInterval for live countdown display
  lastBoundaryFetch: 0,      // Timestamp of last boundary-triggered fetch
  selectedStrategy: getInitialStrategy(),
  isInitialLoad: true  // Suppress popups during first data load
};

// Initialize section states
for (const [key, info] of Object.entries(CONFIG.SECTIONS)) {
  state.sections[key] = {
    name: info.name,
    emoji: info.emoji,
    periods: [],
    lastKnownPeriod: 0,
    nextPeriod: 0,
    pendingBet: null,          // { color: 'R'|'G', period: number, isVirtual: boolean }
    totalWins: 0,
    totalLosses: 0,
    betHistory: [],            // [{ period, betColor, actualColor, won }]
    patternDetected: false,
    patternColors: null,
    freshStartArmed: false,
    freshStartAnchorPeriod: 0,
    strategyState: 'HUNTING',   // 'HUNTING' | 'SIGNAL_ACTIVE' | 'WAITING_FOR_TREND_BREAK' | 'READY_FOR_LIVE'
    lastNotifiedPeriod: 0,
    disabled: false,
    virtualLossCount: 0,
    recoveryAttempt: 0,
    // RGRG virtual 7-loss state
    lockLossCount: 0,             // Kept in sync with virtualLossCount for legacy UI state.
    rgrgLocked: false,
    rgrgLiveLoss: false,
    // Anti-Martingale state
    amConsecutiveWins: 0,
    amCurrentBet: 10,
    amTotalPNL: 0,
    amStopped: false,
    amStopReason: '',
    // Streak 5 Continue state
    streak5Level: 0,
    streak5TotalPNL: 0,
    profitLocked: false,
    // 4-Consecutive RGRG strategy state (RGRG_LOCK_RESET)
    cycleCount: 0,            // consecutive RGRG/GRGR patterns detected (0 to 4)
    cyclePhase: 'HUNTING',    // 'HUNTING' | 'WAITING_TREND_BREAK' | 'POST_BREAK_HUNTING' | 'WAITING_CONFIRM' | 'BET_ACTIVE'
    altDetected: false,        // was alternating pattern detected in recent colors?
    streakColor: null,         // color of current streak (legacy, kept for compat)
    liveRecovery: false,       // is next bet a recovery (opposite)?
    liveBetsUsed: 0,           // total live bets used in current super-cycle
    breakColor: null,          // color that caused trend break (R for RR, G for GG)
    confirmColor: null,        // opposite of breakColor — the color we wait for before betting
    // LOSS_2_RG_GR strategy state
    loss2Phase: 'RGRG_VIRTUAL',  // 'RGRG_VIRTUAL' | 'WAIT_RG_GR' | 'BET_1' | 'BET_2'
    loss2ConsecLosses: 0,        // consecutive virtual RGRG losses (need 2)
    loss2Bet1Color: null         // color of Bet 1 (for opposite calc in Bet 2)
  };
}

// ============ UTILITY FUNCTIONS ============

/** Get simplified color from period data */
function getColor(period) {
  return period.is_green ? 'G' : 'R';
}

/** Get display color name */
function colorName(c) {
  return c === 'G' ? 'GREEN' : 'RED';
}

/** Check if colors form an alternating pattern */
function isAlternating(colors) {
  if (colors.length < 2) return false;
  for (let i = 1; i < colors.length; i++) {
    if (colors[i] === colors[i - 1]) return false;
  }
  return true;
}

// ============ ANTI-MARTINGALE CONFIG ============
const AM_CONFIG = {
  BET_LADDER: [10, 20, 40, 50],
  STOP_LOSS: -60,
  TAKE_PROFIT: 200,
  STARTING_CAPITAL: 150,
  ALLOWED_SECTIONS: ['B', 'E'],
  WIN_MULTIPLIER: 0.96
};

// ============ STREAK 5 CONTINUE CONFIG ============
const STREAK5_CONFIG = {
  STREAK_LENGTH: 5,
  BET_LADDER: [10, 20, 40, 80],
  ALLOWED_SECTIONS: ['B', 'E'],
  WIN_MULTIPLIER: 0.96
};

const VIRTUAL_LOSS_TARGET = 4;
const VIRTUAL_LOSS_DOTS_MAX = 4;
const CONTRARIAN_VIRTUAL_LOSS_TARGET = 4;

function getVirtualLossTarget(strategy) {
  if (strategy === 'CONTRARIAN_DOUBLE') return CONTRARIAN_VIRTUAL_LOSS_TARGET;
  return VIRTUAL_LOSS_TARGET;
}

function getAMBetAmount(consecutiveWins) {
  const idx = Math.min(consecutiveWins, AM_CONFIG.BET_LADDER.length - 1);
  return AM_CONFIG.BET_LADDER[idx];
}

/** Get opposite color */
function opposite(c) {
  return c === 'G' ? 'R' : 'G';
}

function getStrategyPatternLength(strategy) {
  if (strategy === 'RGRG_TREND_BREAK' || strategy === 'SNIPER_3_LOSS_RGRG' || strategy === 'RECOVERY_3_CHANCE' || strategy === 'ANTI_MARTINGALE_SELECT' || strategy === 'RGRG_LOCK_RESET' || strategy === 'LOSS_2_RG_GR') {
    return 4;
  } else if (strategy === 'BREAK_OPPOSITE' || strategy === 'STREAK_BREAK_3' || strategy === 'CONTRARIAN_DOUBLE' || strategy === 'RGR_GRG_3') {
    return 3;
  } else if (strategy === 'STREAK_5_CONTINUE') {
    return 5;
  }
  return 4;
}

function getLatestAlternatingColors(periods, len = 4) {
  if (periods.length < len) return null;

  const colors = periods
    .slice(-len)
    .map(period => getColor(period));

  return isAlternating(colors) ? colors : null;
}

function hasTrendBreakSince(periods, sincePeriod) {
  for (let i = 1; i < periods.length; i++) {
    if (periods[i].period > sincePeriod) {
      if (getColor(periods[i]) === getColor(periods[i - 1])) {
        return true;
      }
    }
  }
  return false;
}

/** Format current time as HH:MM:SS */
function formatTime(date) {
  if (!date) date = new Date();
  return date.toLocaleTimeString('en-IN', { hour12: false });
}

/** Format period number for display */
function formatPeriod(period) {
  const str = String(period);
  return str.length > 6 ? str.slice(-3) : str;
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (e) {
    // Ignore storage failures in restricted browsers.
  }
}

function removeStorage(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (e) {
    // Ignore storage failures in restricted browsers.
  }
}

function persistDisabledSections() {
  const disabledSections = {};

  for (const [key, section] of Object.entries(state.sections)) {
    if (section.disabled) {
      disabledSections[key] = section.profitLocked ? { reason: 'profit' } : true;
    }
  }

  writeStorage('wingo-disabled-sections', JSON.stringify(disabledSections));
}

function isRgrgLockStrategy(strategy = state.selectedStrategy) {
  return strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3' || strategy === 'LOSS_2_RG_GR';
}

function isRgrgSectionLocked(section, strategy = state.selectedStrategy) { return false; }

function clearRgrgSectionLock(section) {
  section.virtualLossCount = 0;
  section.lockLossCount = 0;
  section.rgrgLocked = false;
}

function syncRgrgSectionLocks() {}
function selectRgrgSection(key) {
  return true;
}

function resetRgrgCycle() {}

function persistRgrgLockState() {
  const sections = {};
  let hasState = false;

  for (const [key, section] of Object.entries(state.sections)) {
    const count = Math.max(0, Number(section.virtualLossCount) || 0);
    const hasLoss2State = section.loss2Phase !== 'RGRG_VIRTUAL' || section.loss2ConsecLosses > 0;
    if (!count && !section.pendingBet && !hasLoss2State) continue;
    
    hasState = true;
    sections[key] = {
      virtualLossCount: count,
      strategyState: section.strategyState,
      pendingBet: section.pendingBet,
      totalLosses: section.totalLosses || 0,
      rgrgLiveLoss: section.rgrgLiveLoss || false,
      cycleCount: section.cycleCount || 0,
      cyclePhase: section.cyclePhase || 'HUNTING',
      altDetected: section.altDetected || false,
      streakColor: section.streakColor || null,
      liveRecovery: section.liveRecovery || false,
      liveBetsUsed: section.liveBetsUsed || 0,
      breakColor: section.breakColor || null,
      confirmColor: section.confirmColor || null,
      loss2Phase: section.loss2Phase || 'RGRG_VIRTUAL',
      loss2ConsecLosses: section.loss2ConsecLosses || 0,
      loss2Bet1Color: section.loss2Bet1Color || null
    };
  }

  if (!hasState) {
    removeStorage(CONFIG.RGRG_LOCK_STORAGE_KEY);
    return;
  }

  writeStorage(
    CONFIG.RGRG_LOCK_STORAGE_KEY,
    JSON.stringify({ version: 4, sections })
  );
}

function restoreRgrgLockState() {
  const raw = readStorage(CONFIG.RGRG_LOCK_STORAGE_KEY);
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    if (![2, 3, 4].includes(parsed.version)) {
      removeStorage(CONFIG.RGRG_LOCK_STORAGE_KEY);
      return;
    }

    const savedSections = parsed.sections || {};

    for (const [key, saved] of Object.entries(savedSections)) {
      const section = state.sections[key];
      if (!section) continue;

      const target = getVirtualLossTarget(state.selectedStrategy);
      section.virtualLossCount = Math.min(VIRTUAL_LOSS_DOTS_MAX, Math.max(0, Number(saved.virtualLossCount) || 0));
      section.lockLossCount = section.virtualLossCount;
      section.pendingBet = saved.pendingBet || null;
      // Restore saved state, or infer from virtualLossCount
      section.strategyState = saved.strategyState || (section.virtualLossCount >= target ? 'READY_FOR_LIVE' : 'HUNTING');
      section.totalLosses = saved.totalLosses || 0;
      section.rgrgLiveLoss = saved.rgrgLiveLoss || false;
      // Restore cycle strategy state
      section.cycleCount = saved.cycleCount || 0;
      section.cyclePhase = saved.cyclePhase || 'HUNTING';
      section.altDetected = saved.altDetected || false;
      section.streakColor = saved.streakColor || null;
      section.liveRecovery = saved.liveRecovery || false;
      section.liveBetsUsed = saved.liveBetsUsed || 0;
      section.breakColor = saved.breakColor || null;
      section.confirmColor = saved.confirmColor || null;
      section.loss2Phase = saved.loss2Phase || 'RGRG_VIRTUAL';
      section.loss2ConsecLosses = saved.loss2ConsecLosses || 0;
      section.loss2Bet1Color = saved.loss2Bet1Color || null;
    }
    syncRgrgSectionLocks();
  } catch (e) {
    removeStorage(CONFIG.RGRG_LOCK_STORAGE_KEY);
  }
}

function hasFreshSignalState(section) {
  return Boolean(section.freshStartArmed || section.freshStartAnchorPeriod);
}

// ============ SOUND SYSTEM ============
let audioCtx = null;

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Unlock AudioContext on first user interaction (required by browsers)
['click', 'touchstart', 'touchend'].forEach(evt => {
  document.addEventListener(evt, function unlockAudio() {
    ensureAudioCtx();
    document.removeEventListener(evt, unlockAudio);
  }, { once: true });
});

/** Premium alert sound — ascending chime with harmonics */
function playAlertSound() {
  const now = Date.now();
  if (now - state.lastSignalSoundTime < 3000) return;
  state.lastSignalSoundTime = now;

  try {
    const ctx = ensureAudioCtx();
    const t = ctx.currentTime;

    // Ascending chime notes (C5, E5, G5, C6)
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, i) => {
      const delay = i * 0.12;
      // Main tone
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + delay);
      gain.gain.linearRampToValueAtTime(0.22, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.4);

      // Harmonic shimmer (octave above, quieter)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.value = freq * 2;
      gain2.gain.setValueAtTime(0, t + delay);
      gain2.gain.linearRampToValueAtTime(0.06, t + delay + 0.02);
      gain2.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.25);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(t + delay);
      osc2.stop(t + delay + 0.25);
    });

    // Sub-bass impact
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(80, t);
    sub.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    subGain.gain.setValueAtTime(0.3, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    sub.connect(subGain);
    subGain.connect(ctx.destination);
    sub.start(t);
    sub.stop(t + 0.3);

  } catch (e) {
    console.warn('Sound unavailable:', e);
  }
}

/** Siren alert sound for signal after 2+ losses */
function play2LossAlertSound() {
  try {
    const ctx = ensureAudioCtx();
    const t = ctx.currentTime;

    // Siren sweep: low → high → low
    const siren = ctx.createOscillator();
    const sirenGain = ctx.createGain();
    siren.type = 'sawtooth';
    siren.frequency.setValueAtTime(600, t);
    siren.frequency.linearRampToValueAtTime(1400, t + 0.3);
    siren.frequency.linearRampToValueAtTime(600, t + 0.6);
    siren.frequency.linearRampToValueAtTime(1400, t + 0.9);
    siren.frequency.linearRampToValueAtTime(600, t + 1.2);
    sirenGain.gain.setValueAtTime(0.35, t);
    sirenGain.gain.setValueAtTime(0.35, t + 1.0);
    sirenGain.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    siren.connect(sirenGain);
    sirenGain.connect(ctx.destination);
    siren.start(t);
    siren.stop(t + 1.3);

    // Sub-bass impact
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(100, t);
    sub.frequency.exponentialRampToValueAtTime(35, t + 0.4);
    subGain.gain.setValueAtTime(0.45, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    sub.connect(subGain);
    subGain.connect(ctx.destination);
    sub.start(t);
    sub.stop(t + 0.4);
  } catch (e) {
    console.warn('Sound unavailable:', e);
  }
}



/**
 * TRADE READY SOUND — Loud, attention-grabbing alert
 * Plays a powerful "cash register ka-ching + siren + victory fanfare" combo
 * This is the MAIN sound that plays when a trade signal arrives
 */
function playTradeReadySound() {
  try {
    const ctx = ensureAudioCtx();
    const t = ctx.currentTime;

    // ── LOUD ALARM: single alert beep ──
    {
      const offset = 0;
      // Main alarm tone (loud siren sweep)
      const siren = ctx.createOscillator();
      const sirenGain = ctx.createGain();
      siren.type = 'sawtooth';
      siren.frequency.setValueAtTime(800, t + offset);
      siren.frequency.linearRampToValueAtTime(1400, t + offset + 0.15);
      siren.frequency.linearRampToValueAtTime(800, t + offset + 0.3);
      sirenGain.gain.setValueAtTime(0.4, t + offset);
      sirenGain.gain.setValueAtTime(0.4, t + offset + 0.25);
      sirenGain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.35);
      siren.connect(sirenGain);
      sirenGain.connect(ctx.destination);
      siren.start(t + offset);
      siren.stop(t + offset + 0.35);

      // High-pitched alert beep
      const beep = ctx.createOscillator();
      const beepGain = ctx.createGain();
      beep.type = 'square';
      beep.frequency.value = 1800;
      beepGain.gain.setValueAtTime(0.25, t + offset);
      beepGain.gain.setValueAtTime(0.25, t + offset + 0.2);
      beepGain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.3);
      beep.connect(beepGain);
      beepGain.connect(ctx.destination);
      beep.start(t + offset);
      beep.stop(t + offset + 0.3);
    }

    // ── Victory fanfare after beep ──
    const fanfareDelay = 0.6;
    const fanfareNotes = [
      { freq: 523.25, time: 0, dur: 0.4 },
      { freq: 659.25, time: 0.1, dur: 0.35 },
      { freq: 783.99, time: 0.2, dur: 0.3 },
      { freq: 1046.50, time: 0.3, dur: 0.5 },
    ];

    fanfareNotes.forEach(note => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.freq;
      const start = t + fanfareDelay + note.time;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
      gain.gain.setValueAtTime(0.3, start + note.dur * 0.6);
      gain.gain.exponentialRampToValueAtTime(0.001, start + note.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + note.dur);
    });

    // ── Sub-bass boom ──
    const boom = ctx.createOscillator();
    const boomGain = ctx.createGain();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(100, t);
    boom.frequency.exponentialRampToValueAtTime(30, t + 0.5);
    boomGain.gain.setValueAtTime(0.5, t);
    boomGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    boom.connect(boomGain);
    boomGain.connect(ctx.destination);
    boom.start(t);
    boom.stop(t + 0.5);

  } catch (e) {
    console.warn('Trade sound unavailable:', e);
  }
}

// ============ NOTIFICATION SYSTEM ============

function updateNotificationStatus() {
  const statusEl = document.getElementById('notification-status');
  if (!statusEl) return;

  if (!('Notification' in window)) {
    statusEl.textContent = '🔇 NO NOTIF';
    statusEl.className = 'status-badge watching';
    return;
  }

  if (Notification.permission === 'granted') {
    statusEl.textContent = '🔔 ALERTS ON';
    statusEl.className = 'status-badge watching';
    statusEl.style.backgroundColor = 'var(--color-green)';
    statusEl.style.color = '#fff';
  } else if (Notification.permission === 'denied') {
    statusEl.textContent = '🔇 BLOCKED';
    statusEl.className = 'status-badge paused';
    statusEl.style.backgroundColor = 'var(--color-red)';
    statusEl.style.color = '#fff';
  } else {
    statusEl.textContent = '🔔 ENABLE ALERTS';
    statusEl.className = 'status-badge watching';
    statusEl.style.backgroundColor = '#f1c40f';
    statusEl.style.color = '#000';
  }
}

function requestNotificationPermission() {
  if (!('Notification' in window)) {
    alert('Browser notifications are not supported on this device.');
    return;
  }

  Notification.requestPermission().then(permission => {
    updateNotificationStatus();
    if (permission === 'granted') {
      sendSystemNotification('🎰 Wingo Strategy', 'Notifications successfully enabled!');
    }
  });
}

function sendSystemNotification(title, message) {
  console.log(`[Notification] ${title}: ${message}`);

  // 1. Native Android Bridge (if running in custom Android App)
  if (window.AndroidBridge && typeof window.AndroidBridge.showNotification === 'function') {
    try {
      window.AndroidBridge.showNotification(title, message);
      return;
    } catch (e) {
      console.error('AndroidBridge notification failed:', e);
    }
  }

  // 2. Standard Browser PWA Notification
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(registration => {
          registration.showNotification(title, {
            body: message,
            icon: './icon.png',
            vibrate: [200, 100, 200],
            tag: 'wingo-signal',
            renotify: true
          });
        });
      } else {
        new Notification(title, {
          body: message,
          icon: './icon.png'
        });
      }
    } catch (e) {
      console.warn('Web notification failed:', e);
    }
  }
}

// Expose functions globally for HTML event attributes
window.requestNotificationPermission = requestNotificationPermission;
window.updateNotificationStatus = updateNotificationStatus;
window.startFreshSignalsNow = startFreshSignalsNow;
window.changeStrategy = changeStrategy;
window.toggleSection = toggleSection;

// ============ LOGGING ============

function addLog(message, type = 'info') {
  const entry = {
    time: formatTime(),
    message,
    type  // 'info' | 'pattern' | 'win' | 'loss' | 'signal' | 'reset'
  };

  state.logs.unshift(entry);
  if (state.logs.length > CONFIG.MAX_LOG_ENTRIES) state.logs.pop();

  renderLog(entry);
}

function sectionHasLiveAlternatingPattern(section) {
  const strategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';
  const len = getStrategyPatternLength(strategy);
  if (section.periods.length < len) return false;

  const colors = section.periods
    .slice(-len)
    .map(period => getColor(period));

  if (strategy === 'RGRG_TREND_BREAK' || strategy === 'SNIPER_3_LOSS_RGRG' || strategy === 'RECOVERY_3_CHANCE' || strategy === 'ANTI_MARTINGALE_SELECT' || strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3' || strategy === 'LOSS_2_RG_GR') {
    return isAlternating(colors);
  } else if (strategy === 'CONTRARIAN_DOUBLE') {
    return colors[0] !== colors[1] && colors[1] === colors[2];
  } else if (strategy === 'BREAK_OPPOSITE') {
    return colors[0] !== colors[1] && colors[1] === colors[2];
  } else if (strategy === 'STREAK_BREAK_3') {
    return colors[0] === colors[1] && colors[1] === colors[2];
  } else if (strategy === 'STREAK_5_CONTINUE') {
    return colors.every(c => c === colors[0]);
  }
  return false;
}

function getEligiblePeriodsForSignals(section) {
  if (!section.freshStartAnchorPeriod) {
    return section.periods;
  }

  return section.periods.filter(period => period.period > section.freshStartAnchorPeriod);
}

function persistFreshSignalState() {
  const sections = {};
  let hasFreshState = false;

  for (const [key, section] of Object.entries(state.sections)) {
    if (!section.freshStartAnchorPeriod && !section.freshStartArmed) continue;

    hasFreshState = true;
    sections[key] = {
      freshStartAnchorPeriod: section.freshStartAnchorPeriod || 0,
      freshStartArmed: section.freshStartArmed
    };
  }

  if (!hasFreshState) {
    removeStorage(CONFIG.FRESH_SIGNAL_STORAGE_KEY);
    return;
  }

  writeStorage(
    CONFIG.FRESH_SIGNAL_STORAGE_KEY,
    JSON.stringify({ sections })
  );
}

function restoreFreshSignalState() {
  const raw = readStorage(CONFIG.FRESH_SIGNAL_STORAGE_KEY);
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    const savedSections = parsed.sections || {};

    for (const [key, saved] of Object.entries(savedSections)) {
      const section = state.sections[key];
      if (!section) continue;

      section.freshStartAnchorPeriod = Number(saved.freshStartAnchorPeriod) || 0;
      section.freshStartArmed = Boolean(saved.freshStartArmed);
    }
  } catch (e) {
    removeStorage(CONFIG.FRESH_SIGNAL_STORAGE_KEY);
  }
}

/**
 * Show a live trade signal — direct bet on pattern's last same color.
 */
function showTradeSignal(key) {
  const section = state.sections[key];
  if (!section.pendingBet) return;

  const betColor = colorName(section.pendingBet.color);
  const periodStr = formatPeriod(section.pendingBet.period);
  const strategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';

  // Show signal banner at top
  showSignalBanner(key);

  // Play the trade ready sound (no popup)
  playTradeReadySound();

  // Send push notification with recovery info
  let notifTitle = `🎯 TRADE: ${section.name}`;
  let notifBody = `Bet ${betColor} on Period #${periodStr}!`;
  if (strategy === 'RECOVERY_3_CHANCE') {
    const attemptNum = section.recoveryAttempt + 1;
    const attemptLabel = attemptNum === 1 ? 'Signal #1' : attemptNum === 2 ? 'Recovery #2' : 'LAST Chance #3';
    notifTitle = `🎯 ${attemptLabel}: ${section.name}`;
    notifBody = `Bet ${betColor} on Period #${periodStr}! (Attempt ${attemptNum}/3)`;
  } else if (strategy === 'STREAK_5_CONTINUE') {
    const betAmt = STREAK5_CONFIG.BET_LADDER[section.streak5Level || 0];
    notifTitle = `🔥 5-Streak: ${section.name}`;
    notifBody = `Bet ${betColor} ₹${betAmt} (Lv${(section.streak5Level || 0) + 1}) on #${periodStr}!`;
  }
  sendSystemNotification(notifTitle, notifBody);

  addLog(
    `🚨 [${section.name}] TRADE SIGNAL! Bet ${betColor} on #${periodStr}`,
    'signal'
  );
}

function armBetFromCurrentPattern(key, nextPeriod) {
  const section = state.sections[key];
  const strategy = state.selectedStrategy || 'RGRG_LOCK_RESET';
  if (section.disabled || isRgrgSectionLocked(section, strategy)) return false;
  if (strategy === 'ANTI_MARTINGALE_SELECT' && !AM_CONFIG.ALLOWED_SECTIONS.includes(key)) return false;
  if (strategy === 'ANTI_MARTINGALE_SELECT' && section.amStopped) return false;
  if (strategy === 'STREAK_5_CONTINUE' && !STREAK5_CONFIG.ALLOWED_SECTIONS.includes(key)) return false;
  if (section.pendingBet || (section.strategyState !== 'HUNTING' && section.strategyState !== 'READY_FOR_LIVE')) return false;

  checkCurrentPattern(section);
  if (!section.patternDetected || !section.patternColors) return false;

  let betColor = null;

  if (strategy === 'RGRG_TREND_BREAK' || strategy === 'SNIPER_3_LOSS_RGRG' || strategy === 'RECOVERY_3_CHANCE' || strategy === 'ANTI_MARTINGALE_SELECT' || strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3' || strategy === 'LOSS_2_RG_GR') {
    betColor = section.patternColors[section.patternColors.length - 1];
  } else if (strategy === 'CONTRARIAN_DOUBLE') {
    betColor = section.patternColors[0];  // RGG→R, GRR→G (bet same as first = opposite of pair)
  } else if (strategy === 'BREAK_OPPOSITE') {
    betColor = opposite(section.patternColors[section.patternColors.length - 1]);
  } else if (strategy === 'STREAK_BREAK_3') {
    betColor = opposite(section.patternColors[section.patternColors.length - 1]);
  } else if (strategy === 'STREAK_5_CONTINUE') {
    betColor = section.patternColors[section.patternColors.length - 1];
  }

  const vLossTarget = getVirtualLossTarget(strategy);

  if (strategy === 'SNIPER_3_LOSS_RGRG') {
    if (section.strategyState === 'READY_FOR_LIVE') {
      // Sniper is ready, make a LIVE bet
      section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: false };
      section.strategyState = 'SIGNAL_ACTIVE';
      showTradeSignal(key);
      addLog(
        `🎯 [${section.name}] Sniper ARMED! Pattern ${section.patternColors.join('')} → LIVE Bet ${colorName(betColor)} on #${formatPeriod(nextPeriod)}`,
        'pattern'
      );
    } else {
      // Virtual bet to count virtual losses
      section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: true };
      addLog(
        `👁️ [${section.name}] Sniper Hunt: Pattern ${section.patternColors.join('')} → Virtual Bet ${colorName(betColor)} on #${formatPeriod(nextPeriod)} (Virtual Losses: ${section.virtualLossCount}/${VIRTUAL_LOSS_TARGET})`,
        'info'
      );
      // Alert after 2+ losses on next signal
      if (section.virtualLossCount >= 2 && !state.isInitialLoad) {
        play2LossAlertSound();
        showToast(`🔔 ${section.name} — Signal #${section.virtualLossCount + 1} (${colorName(betColor)})`, 'info');
      }
    }
  } else if (strategy === 'RECOVERY_3_CHANCE') {
    // Recovery 3-Chance: ALL bets are LIVE, max 3 per trend cycle
    const attemptNum = section.recoveryAttempt + 1; // 1st, 2nd, or 3rd attempt
    const attemptLabel = attemptNum === 1 ? '🎯 Signal #1' : attemptNum === 2 ? '🔄 Recovery #2' : '⚠️ LAST Chance #3';
    section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: false };
    section.strategyState = 'SIGNAL_ACTIVE';
    showTradeSignal(key);
    addLog(
      `${attemptLabel} [${section.name}] Pattern ${section.patternColors.join('')} → LIVE Bet ${colorName(betColor)} on #${formatPeriod(nextPeriod)} (Attempt ${attemptNum}/3)`,
      'signal'
    );
  } else if (strategy === 'STREAK_5_CONTINUE') {
    const betAmt = STREAK5_CONFIG.BET_LADDER[section.streak5Level];
    section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: false, streak5BetAmount: betAmt };
    section.strategyState = 'SIGNAL_ACTIVE';
    showTradeSignal(key);
    addLog(
      `🔥 [${section.name}] 5-Streak! ${section.patternColors.join('')} → Bet ${colorName(betColor)} ₹${betAmt} (Lv${section.streak5Level + 1}) on #${formatPeriod(nextPeriod)}`,
      'signal'
    );
  } else if (strategy === 'RGRG_LOCK_RESET') {
    if (section.virtualLossCount >= VIRTUAL_LOSS_TARGET) {
      section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: false };
      section.strategyState = 'SIGNAL_ACTIVE';
      persistRgrgLockState();
      showTradeSignal(key);
      addLog(
        `🎯 [${section.name}] ${VIRTUAL_LOSS_TARGET + 1}th BET LIVE! RGRG ${section.patternColors.join('')} → ${colorName(betColor)} on #${formatPeriod(nextPeriod)}.`,
        'signal'
      );
    } else {
      section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: true };
      section.strategyState = 'HUNTING';
      persistRgrgLockState();
      addLog(
        `👁️ [${section.name}] Virtual Bet ${section.virtualLossCount + 1}/${VIRTUAL_LOSS_TARGET}: ${colorName(betColor)} on #${formatPeriod(nextPeriod)}.`,
        'info'
      );
      // Alert after 2+ losses on next signal
      if (section.virtualLossCount >= 2 && !state.isInitialLoad) {
        play2LossAlertSound();
        showToast(`🔔 ${section.name} — Signal #${section.virtualLossCount + 1} (${colorName(betColor)})`, 'info');
      }
    }
  } else if (strategy === 'RGR_GRG_3') {
    if (section.virtualLossCount >= VIRTUAL_LOSS_TARGET) {
      section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: false };
      section.strategyState = 'SIGNAL_ACTIVE';
      persistRgrgLockState();
      showTradeSignal(key);
      addLog(
        `🎯 [${section.name}] ${VIRTUAL_LOSS_TARGET + 1}th BET LIVE! RGR/GRG ${section.patternColors.join('')} → ${colorName(betColor)} on #${formatPeriod(nextPeriod)}.`,
        'signal'
      );
    } else {
      section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: true };
      section.strategyState = 'HUNTING';
      persistRgrgLockState();
      addLog(
        `👁️ [${section.name}] Virtual Bet ${section.virtualLossCount + 1}/${VIRTUAL_LOSS_TARGET}: ${colorName(betColor)} on #${formatPeriod(nextPeriod)}.`,
        'info'
      );
      // Sound on EVERY signal from #1 for RGR_GRG_3
      if (!state.isInitialLoad) {
        play2LossAlertSound();
        showToast(`🔔 ${section.name} — Signal #${section.virtualLossCount + 1} (${colorName(betColor)})`, 'info');
      }
    }
  } else if (strategy === 'CONTRARIAN_DOUBLE') {
    if (section.virtualLossCount >= vLossTarget) {
      section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: false };
      section.strategyState = 'SIGNAL_ACTIVE';
      persistRgrgLockState();
      showTradeSignal(key);
      addLog(
        `🎯 [${section.name}] ${vLossTarget} V-Losses done! LIVE BET: ${section.patternColors.join('')}→${colorName(betColor)} on #${formatPeriod(nextPeriod)}.`,
        'signal'
      );
    } else {
      section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: true };
      section.strategyState = 'HUNTING';
      persistRgrgLockState();
      addLog(
        `👁️ [${section.name}] Virtual Bet ${section.virtualLossCount + 1}/${vLossTarget}: ${section.patternColors.join('')}→${colorName(betColor)} on #${formatPeriod(nextPeriod)}.`,
        'info'
      );
      // Alert after 2+ losses on next signal
      if (section.virtualLossCount >= 2 && !state.isInitialLoad) {
        play2LossAlertSound();
        showToast(`🔔 ${section.name} — Signal #${section.virtualLossCount + 1} (${colorName(betColor)})`, 'info');
      }
    }
  } else {
    // Standard direct live bet
    section.pendingBet = { color: betColor, period: nextPeriod, isVirtual: false };
    section.strategyState = 'SIGNAL_ACTIVE';
    showTradeSignal(key);
    addLog(
      `🎯 [${section.name}] Pattern ${section.patternColors.join('')} → LIVE Bet ${colorName(betColor)} on #${formatPeriod(nextPeriod)}`,
      'signal'
    );
  }

  return true;
}

function resolveRgrgBet(key, period) {
  const section = state.sections[key];
  const resolvedBet = section.pendingBet;
  if (!resolvedBet || resolvedBet.period !== period.period) return false;

  section.pendingBet = null;
  const actualColor = getColor(period);
  const won = actualColor === resolvedBet.color;

  const vTarget = getVirtualLossTarget(state.selectedStrategy);

  if (resolvedBet.isVirtual) {
    if (won) {
      section.virtualLossCount = 0;
      section.lockLossCount = 0;
      section.strategyState = 'HUNTING';
      addLog(
        `👁️ [${section.name}] Virtual WIN on #${formatPeriod(period.period)}. Counter reset to 0/${vTarget}.`,
        'info'
      );
    } else {
      section.virtualLossCount = Math.min(VIRTUAL_LOSS_DOTS_MAX, section.virtualLossCount + 1);
      section.lockLossCount = section.virtualLossCount;
      section.strategyState = 'WAITING_FOR_TREND_BREAK';
      section.rgrgLiveLoss = false;
      addLog(
        `👁️ [${section.name}] Virtual LOSS on #${formatPeriod(period.period)}. ${section.virtualLossCount}/${vTarget} complete.`,
        'info'
      );
    }
    persistRgrgLockState();
    return true;
  }

  section.betHistory.push({
    period: period.period,
    betColor: resolvedBet.color,
    actualColor,
    won
  });
  hideSignalBanner();

  if (won) {
    section.totalWins++;
    // Full reset — start fresh
    section.virtualLossCount = 0;
    section.lockLossCount = 0;
    section.rgrgLiveLoss = false;
    section.strategyState = 'HUNTING';
    section.pendingBet = null;
    section.patternDetected = false;
    section.patternColors = null;
    // Reset cycle strategy state
    section.cycleCount = 0;
    section.cyclePhase = 'HUNTING';
    section.altDetected = false;
    section.streakColor = null;
    section.liveRecovery = false;
    section.liveBetsUsed = 0;
    section.breakColor = null;
    section.confirmColor = null;
    addLog(
      `✅ [${section.name}] PROFIT! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)} (#${formatPeriod(period.period)}). Fresh start!`,
      'win'
    );
    playAlertSound();
    showToast(`✅ ${section.name} PROFIT! Fresh start.`, 'success');
    persistRgrgLockState();

  } else {
    section.totalLosses++;
    if (state.selectedStrategy === 'CONTRARIAN_DOUBLE') {
      section.virtualLossCount = 0;
      section.lockLossCount = 0;
      section.strategyState = 'HUNTING';
      addLog(
        `❌ [${section.name}] LIVE LOSS! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)}. Counter reset — re-counting ${vTarget} virtual losses.`,
        'loss'
      );
    } else if (state.selectedStrategy === 'RGRG_LOCK_RESET') {
      // 4-consecutive RGRG strategy: recovery mechanism (max 2 bets)
      section.liveBetsUsed++;
      if (section.liveBetsUsed >= 2) {
        // 2 bets used — full reset, wait for 4 new consecutive RGRG losses
        section.cycleCount = 0;
        section.cyclePhase = 'HUNTING';
        section.altDetected = false;
        section.streakColor = null;
        section.liveRecovery = false;
        section.liveBetsUsed = 0;
        section.virtualLossCount = 0;
        section.lockLossCount = 0;
        section.breakColor = null;
        section.confirmColor = null;
        section.strategyState = 'HUNTING';
        addLog(
          `❌ [${section.name}] Both bets LOST! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)}. Full reset — waiting 4 new RGRG losses.`,
          'loss'
        );
      } else if (!section.liveRecovery) {
        // First bet lost — arm immediate recovery (opposite color)
        section.liveRecovery = true;
        const recoveryColor = opposite(resolvedBet.color);
        section.pendingBet = { color: recoveryColor, period: section.nextPeriod || (period.period + 1), isVirtual: false };
        section.cyclePhase = 'BET_ACTIVE';
        section.strategyState = 'SIGNAL_ACTIVE';
        showTradeSignal(key);
        addLog(
          `🔄 [${section.name}] LOSS! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)}. Recovery → ${colorName(recoveryColor)} on #${formatPeriod(section.nextPeriod || (period.period + 1))}`,
          'loss'
        );
      } else {
        // Recovery also lost — full reset
        section.cycleCount = 0;
        section.cyclePhase = 'HUNTING';
        section.altDetected = false;
        section.streakColor = null;
        section.liveRecovery = false;
        section.liveBetsUsed = 0;
        section.virtualLossCount = 0;
        section.lockLossCount = 0;
        section.breakColor = null;
        section.confirmColor = null;
        section.strategyState = 'HUNTING';
        addLog(
          `❌ [${section.name}] Recovery LOSS! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)}. Full reset — waiting 4 new RGRG losses.`,
          'loss'
        );
      }
    } else {
      // Other strategies: wait for trend break
      section.strategyState = 'WAITING_FOR_TREND_BREAK';
      addLog(
        `❌ [${section.name}] LIVE LOSS! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)}. Waiting for trend break.`,
        'loss'
      );
    }
    showToast(`❌ ${section.name} loss.`, 'error');
    persistRgrgLockState();
  }

  return true;
}

// ============ 4-CONSECUTIVE RGRG STRATEGY (RGRG_LOCK_RESET) ============
// Detects RGRG/GRGR = 1 loss. Need 4 consecutive.
// Between: wait for trend break (RR/GG) → if consecutive before next pattern → RESET.
// After 4 losses + break: wait confirm color → bet → recovery if loss.

/**
 * Full reset helper — resets all cycle state to initial
 */
function fullCycleReset(section) {
  section.cycleCount = 0;
  section.cyclePhase = 'HUNTING';
  section.altDetected = false;
  section.streakColor = null;
  section.liveRecovery = false;
  section.liveBetsUsed = 0;
  section.virtualLossCount = 0;
  section.lockLossCount = 0;
  section.breakColor = null;
  section.confirmColor = null;
  section.strategyState = 'HUNTING';
  section.pendingBet = null;
}

function scanHistoryForCycleStrategy(key) {
  const section = state.sections[key];
  if (section.disabled) return;
  
  const allPeriods = section.periods;
  if (allPeriods.length < 5) return;

  // Reset to clean slate (keep wins/losses/history intact)
  fullCycleReset(section);
  
  for (let i = 3; i < allPeriods.length; i++) {
    const currentPeriod = allPeriods[i];
    const currentColor = getColor(currentPeriod);
    const prevColor = i > 0 ? getColor(allPeriods[i - 1]) : null;
    
    // 1. Resolve pending bet if any
    if (section.pendingBet) {
      if (section.pendingBet.period === currentPeriod.period) {
        const resolvedBet = section.pendingBet;
        section.pendingBet = null;
        const actualColor = getColor(currentPeriod);
        const won = actualColor === resolvedBet.color;
        
        if (won) {
          fullCycleReset(section);
        } else {
          section.liveBetsUsed++;
          if (section.liveBetsUsed >= 2) {
            fullCycleReset(section);
          } else if (!section.liveRecovery) {
            section.liveRecovery = true;
            const recoveryColor = opposite(resolvedBet.color);
            section.pendingBet = { color: recoveryColor, period: currentPeriod.period + 1, isVirtual: false };
            section.cyclePhase = 'BET_ACTIVE';
            section.strategyState = 'SIGNAL_ACTIVE';
          } else {
            fullCycleReset(section);
          }
        }
      }
      continue;
    }

    // 2. State machine for pattern detection
    
    // -- WAITING_TREND_BREAK --
    if (section.cyclePhase === 'WAITING_TREND_BREAK') {
      if (prevColor && currentColor === prevColor) {
        section.breakColor = currentColor;
        if (section.cycleCount >= 4) {
          section.confirmColor = currentColor === 'R' ? 'G' : 'R';
          section.cyclePhase = 'WAITING_CONFIRM';
        } else {
          section.cyclePhase = 'POST_BREAK_HUNTING';
          section.initialStreakBroken = false;
        }
      }
      continue;
    }
    
    // -- WAITING_CONFIRM --
    if (section.cyclePhase === 'WAITING_CONFIRM') {
      if (currentColor === section.confirmColor) {
        if (i + 1 < allPeriods.length) {
          section.pendingBet = { color: section.confirmColor, period: allPeriods[i + 1].period, isVirtual: false };
          section.cyclePhase = 'BET_ACTIVE';
          section.strategyState = 'SIGNAL_ACTIVE';
          section.liveBetsUsed = 0;
          section.liveRecovery = false;
        }
      }
      continue;
    }
    
    // -- POST_BREAK_HUNTING: reset if new consecutive streak found --
    if (section.cyclePhase === 'POST_BREAK_HUNTING') {
      if (currentColor !== section.breakColor) {
        section.initialStreakBroken = true;
      }
      if (prevColor && currentColor === prevColor) {
        const isInitialStreak = (currentColor === section.breakColor) && !section.initialStreakBroken;
        if (!isInitialStreak) {
          fullCycleReset(section);
        }
      }
    }
    
    // -- HUNTING / POST_BREAK_HUNTING: detect RGRG/GRGR --
    if (section.cyclePhase === 'HUNTING' || section.cyclePhase === 'POST_BREAK_HUNTING') {
      if (i < 3) continue;
      
      const c1 = getColor(allPeriods[i - 3]);
      const c2 = getColor(allPeriods[i - 2]);
      const c3 = getColor(allPeriods[i - 1]);
      const c4 = getColor(allPeriods[i]);
      
      if (isAlternating([c1, c2, c3, c4])) {
        section.cycleCount++;
        section.virtualLossCount = section.cycleCount;
        section.lockLossCount = section.cycleCount;
        section.cyclePhase = 'WAITING_TREND_BREAK';
        section.altDetected = true;
      }
    }
  }
}

function processCycleStrategy(key) {
  const section = state.sections[key];
  if (section.disabled) return;
  if (section.pendingBet) return;

  const periods = section.periods;
  if (periods.length < 5) return;

  const len = periods.length;
  const currentColor = getColor(periods[len - 1]);
  const prevColor = getColor(periods[len - 2]);

  // ---- Phase: WAITING_TREND_BREAK ----
  if (section.cyclePhase === 'WAITING_TREND_BREAK') {
    if (currentColor === prevColor) {
      // Trend broken!
      section.breakColor = currentColor;

      if (section.cycleCount >= 4) {
        // 4 losses done! Wait for confirm color
        section.confirmColor = currentColor === 'R' ? 'G' : 'R';
        section.cyclePhase = 'WAITING_CONFIRM';
        section.strategyState = 'READY_FOR_LIVE';
        persistRgrgLockState();
        addLog(
          `🎯 [${section.name}] 4 RGRG losses done! ${colorName(currentColor)}${colorName(currentColor)} break. Waiting for ${colorName(section.confirmColor)} to confirm...`,
          'signal'
        );
        if (!state.isInitialLoad) {
          play2LossAlertSound();
          showToast(`🎯 ${section.name} — 4 losses done! Waiting for ${colorName(section.confirmColor)}...`, 'info');
        }
      } else {
        section.cyclePhase = 'POST_BREAK_HUNTING';
        section.initialStreakBroken = false;
        persistRgrgLockState();
        addLog(
          `🔄 [${section.name}] RGRG #${section.cycleCount}/4 → ${colorName(currentColor)}${colorName(currentColor)} break. Hunting next RGRG...`,
          'info'
        );
      }
    }
    return;
  }

  // ---- Phase: WAITING_CONFIRM ----
  if (section.cyclePhase === 'WAITING_CONFIRM') {
    if (currentColor === section.confirmColor) {
      // Confirm color appeared! Bet on it for NEXT period
      section.liveBetsUsed = 0;
      section.liveRecovery = false;
      section.pendingBet = { color: section.confirmColor, period: section.nextPeriod, isVirtual: false };
      section.cyclePhase = 'BET_ACTIVE';
      section.strategyState = 'SIGNAL_ACTIVE';
      persistRgrgLockState();
      showTradeSignal(key);
      addLog(
        `🎯 [${section.name}] LIVE BET! ${colorName(section.confirmColor)} confirmed → Bet ${colorName(section.confirmColor)} on #${formatPeriod(section.nextPeriod)}`,
        'signal'
      );
      if (!state.isInitialLoad) {
        playAlertSound();
        showToast(`🎯 ${section.name} — LIVE BET ${colorName(section.confirmColor)}!`, 'info');
      }
    }
    return;
  }

  // ---- Phase: POST_BREAK_HUNTING ----
  if (section.cyclePhase === 'POST_BREAK_HUNTING') {
    if (currentColor !== section.breakColor) {
      section.initialStreakBroken = true;
    }

    if (currentColor === prevColor) {
      const isInitialStreak = (currentColor === section.breakColor) && !section.initialStreakBroken;
      
      if (!isInitialStreak) {
        const oldCount = section.cycleCount;
        fullCycleReset(section);
        persistRgrgLockState();
        addLog(
          `🔄 [${section.name}] RESET! New streak ${colorName(currentColor)}${colorName(currentColor)} found before next RGRG (was ${oldCount}/4). Starting over.`,
          'info'
        );
      }
    }
  }

  // ---- Phase: HUNTING / POST_BREAK_HUNTING ----
  if (section.cyclePhase === 'HUNTING' || section.cyclePhase === 'POST_BREAK_HUNTING') {
    if (len < 4) return;

    const last4 = [
      getColor(periods[len - 4]),
      getColor(periods[len - 3]),
      getColor(periods[len - 2]),
      getColor(periods[len - 1])
    ];

    if (isAlternating(last4)) {
      // RGRG/GRGR detected = 1 loss!
      section.cycleCount++;
      section.virtualLossCount = section.cycleCount;
      section.lockLossCount = section.cycleCount;
      section.cyclePhase = 'WAITING_TREND_BREAK';
      section.altDetected = true;
      persistRgrgLockState();

      addLog(
        `👁️ [${section.name}] RGRG #${section.cycleCount}/4 detected: ${last4.join('')}. Waiting for trend break...`,
        'info'
      );

      if (section.cycleCount >= 3 && !state.isInitialLoad) {
        play2LossAlertSound();
        showToast(`🔔 ${section.name} — RGRG #${section.cycleCount}/4`, 'info');
      }
    }
  }
}


// ============ LOSS_2_RG_GR: COMPLETE SELF-CONTAINED STRATEGY ============
// Phase 1 (RGRG_VIRTUAL): Detect RGRG/GRGR → virtual bet → count losses
// Phase 2 (WAIT_RG_GR): After 2 virtual losses → scan for RG/GR
// Phase 3 (BET_1): Live bet ₹30 on last color
// Phase 4 (BET_2): If Bet 1 lost → Live bet ₹90 on opposite color
// Reset after Bet 1 WIN or Bet 2 (any result)

function processLoss2Strategy(key) {
  const section = state.sections[key];
  if (section.disabled) return;

  const periods = section.periods;
  if (periods.length < 4) return;

  const len = periods.length;

  // ──── If there's a pending bet, don't do anything (wait for resolution) ────
  if (section.pendingBet) return;

  // ──── Phase: RGRG_VIRTUAL — hunt for RGRG patterns ────
  if (section.loss2Phase === 'RGRG_VIRTUAL') {
    // Check last 4 colors for alternating pattern
    const last4 = [
      getColor(periods[len - 4]),
      getColor(periods[len - 3]),
      getColor(periods[len - 2]),
      getColor(periods[len - 1])
    ];

    if (!isAlternating(last4)) return;

    // RGRG detected! Place virtual bet (expect last color to continue = break)
    const betColor = last4[last4.length - 1]; // last color
    section.patternDetected = true;
    section.patternColors = last4;
    section.pendingBet = {
      color: betColor,
      period: section.nextPeriod,
      isVirtual: true
    };
    section.strategyState = 'HUNTING';
    persistRgrgLockState();
    addLog(
      `👁️ [${section.name}] RGRG ${last4.join('')} → Virtual ${colorName(betColor)} on #${formatPeriod(section.nextPeriod)}. V-Losses: ${section.loss2ConsecLosses}/2`,
      'info'
    );
    return;
  }

  // ──── Phase: WAIT_RG_GR — scan for RG or GR pattern ────
  if (section.loss2Phase === 'WAIT_RG_GR') {
    const curr = getColor(periods[len - 1]);
    const prev = getColor(periods[len - 2]);

    // Need RG or GR (different colors), skip RR/GG
    if (curr === prev) return;

    // RG → bet G, GR → bet R (last color)
    const betColor = curr;
    section.loss2Phase = 'BET_1';
    section.loss2Bet1Color = betColor;
    section.pendingBet = {
      color: betColor,
      period: section.nextPeriod,
      isVirtual: false,
      betAmount: 30
    };
    section.strategyState = 'SIGNAL_ACTIVE';
    persistRgrgLockState();
    showTradeSignal(key);
    addLog(
      `🎯 [${section.name}] ${prev}${curr} pattern! BET 1 → ${colorName(betColor)} ₹30 on #${formatPeriod(section.nextPeriod)}`,
      'signal'
    );
    if (!state.isInitialLoad) {
      playAlertSound();
      showToast(`🎯 ${section.name} — BET ${colorName(betColor)} ₹30!`, 'info');
    }
    return;
  }
}

function resolveLoss2Bet(key, period) {
  const section = state.sections[key];
  const resolvedBet = section.pendingBet;
  if (!resolvedBet || resolvedBet.period !== period.period) return false;

  section.pendingBet = null;
  const actualColor = getColor(period);
  const won = actualColor === resolvedBet.color;

  // ──── Virtual bet resolution ────
  if (resolvedBet.isVirtual) {
    if (won) {
      section.loss2ConsecLosses = 0;
      section.virtualLossCount = 0;
      section.lockLossCount = 0;
      section.strategyState = 'HUNTING';
      section.loss2Phase = 'RGRG_VIRTUAL';
      addLog(`👁️ [${section.name}] Virtual WIN #${formatPeriod(period.period)}. Losses reset to 0.`, 'info');
    } else {
      section.loss2ConsecLosses++;
      section.virtualLossCount = Math.min(VIRTUAL_LOSS_DOTS_MAX, section.loss2ConsecLosses);
      section.lockLossCount = section.virtualLossCount;
      if (section.loss2ConsecLosses >= 2) {
        section.loss2Phase = 'WAIT_RG_GR';
        section.strategyState = 'READY_FOR_LIVE';
        addLog(`🚨 [${section.name}] 2 virtual losses! Waiting for RG/GR...`, 'signal');
        if (!state.isInitialLoad) {
          play2LossAlertSound();
          showToast(`🚨 ${section.name} — 2 losses! Waiting RG/GR...`, 'info');
        }
      } else {
        section.loss2Phase = 'RGRG_VIRTUAL';
        section.strategyState = 'HUNTING';
        addLog(`👁️ [${section.name}] Virtual LOSS #${formatPeriod(period.period)}. ${section.loss2ConsecLosses}/2.`, 'info');
      }
    }
    persistRgrgLockState();
    return true;
  }

  // ──── LIVE bet resolution ────
  section.betHistory.push({ period: period.period, betColor: resolvedBet.color, actualColor, won });
  hideSignalBanner();

  if (won) {
    section.totalWins++;
    // Full reset
    section.loss2Phase = 'RGRG_VIRTUAL';
    section.loss2ConsecLosses = 0;
    section.loss2Bet1Color = null;
    section.virtualLossCount = 0;
    section.lockLossCount = 0;
    section.strategyState = 'HUNTING';
    section.pendingBet = null;
    section.patternDetected = false;
    section.patternColors = null;
    const amt = resolvedBet.betAmount || 30;
    addLog(`✅ [${section.name}] WIN! ${colorName(resolvedBet.color)} ₹${amt} → +₹${(amt * 0.96).toFixed(0)}. Reset!`, 'win');
    playAlertSound();
    showToast(`✅ ${section.name} WIN! +₹${(amt * 0.96).toFixed(0)}`, 'success');
  } else {
    section.totalLosses++;
    if (section.loss2Phase === 'BET_1') {
      // Bet 1 lost → arm Bet 2 on OPPOSITE color
      section.loss2Phase = 'BET_2';
      const oppColor = opposite(resolvedBet.color);
      section.pendingBet = {
        color: oppColor,
        period: section.nextPeriod || (period.period + 1),
        isVirtual: false,
        betAmount: 90
      };
      section.strategyState = 'SIGNAL_ACTIVE';
      showTradeSignal(key);
      addLog(`🔄 [${section.name}] Bet 1 LOSS! Recovery → ${colorName(oppColor)} ₹90 on #${formatPeriod(section.nextPeriod || (period.period + 1))}`, 'loss');
      if (!state.isInitialLoad) {
        playAlertSound();
        showToast(`🔄 ${section.name} — Recovery ${colorName(oppColor)} ₹90`, 'info');
      }
    } else {
      // Bet 2 lost → full reset
      section.loss2Phase = 'RGRG_VIRTUAL';
      section.loss2ConsecLosses = 0;
      section.loss2Bet1Color = null;
      section.virtualLossCount = 0;
      section.lockLossCount = 0;
      section.strategyState = 'HUNTING';
      section.patternDetected = false;
      section.patternColors = null;
      addLog(`❌ [${section.name}] Both bets LOST! Full reset.`, 'loss');
    }
    showToast(`❌ ${section.name} loss.`, 'error');
  }
  persistRgrgLockState();
  return true;
}


// ============ DATA FETCHING ============

async function fetchSectionData(category) {
  const url = `${CONFIG.API_BASE}/win/next_period_info_noauth?category=${category}&saas_id=${CONFIG.SAAS_ID}`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (data.code !== 200) throw new Error(`API error code: ${data.code}`);

    return data;
  } catch (err) {
    console.error(`Failed to fetch ${category}:`, err);
    return null;
  }
}

async function fetchAllSections() {
  const results = {};
  const promises = Object.keys(CONFIG.SECTIONS).map(async (key) => {
    const data = await fetchSectionData(key);
    if (data) results[key] = data;
  });

  await Promise.all(promises);
  return results;
}

// ============ PATTERN DETECTION & STRATEGY ENGINE ============

/**
 * 🎰 RGRG + TREND BREAK WAIT STRATEGY (Rank #1 — 57.3% win rate):
 * 1. Detect 4-length alternating pattern (RGRG / GRGR).
 * 2. Bet LIVE on last same color.
 * 3. WIN → back to hunting for next pattern.
 * 4. LOSS → PAUSE → wait for trend break (2 consecutive same colors).
 * 5. After trend break → resume hunting.
 */

/**
 * Scan history — replay past periods to build bet history stats.
 * States: HUNTING → SIGNAL_ACTIVE → HUNTING (repeat)
 */
function scanHistoryForSection(section) {
  const periods = getEligiblePeriodsForSignals(section);

  // Reset tracking for fresh scan
  section.totalWins = 0;
  section.totalLosses = 0;
  section.betHistory = [];
  section.pendingBet = null;
  section.strategyState = 'HUNTING';
  section.virtualLossCount = 0;
  section.recoveryAttempt = 0;
  section.lockLossCount = 0;
  section.rgrgLocked = false;


  if (periods.length === 0) {
    checkCurrentPattern(section);
    return;
  }

  const strategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';
  const len = getStrategyPatternLength(strategy);
  let activeBet = null; // { color, period, isVirtual }
  let virtualLossCount = 0;
  let recoveryAttempt = 0;
  let rgrgHistoryLiveLoss = false;

  for (let i = 0; i < periods.length; i++) {
    const actualColor = getColor(periods[i]);



    // 2. Resolve active bet
    if (activeBet && periods[i].period === activeBet.period) {
      const won = actualColor === activeBet.color;

      if (activeBet.isVirtual) {
        // Virtual bet resolution
        if (won) {
          virtualLossCount = 0;
          section.strategyState = 'HUNTING';
        } else {
          virtualLossCount = Math.min(VIRTUAL_LOSS_DOTS_MAX, virtualLossCount + 1);
          // CONTRARIAN_DOUBLE doesn't need trend break
          if (strategy === 'CONTRARIAN_DOUBLE') {
            section.strategyState = 'HUNTING';
          } else {
            section.strategyState = 'WAITING_FOR_TREND_BREAK';
          }
          rgrgHistoryLiveLoss = false;
        }
      } else {
        // LIVE bet resolution
        section.betHistory.push({
          period: periods[i].period,
          betColor: activeBet.color,
          actualColor,
          won
        });

        if (won) {
          section.totalWins++;
          virtualLossCount = 0;
          section.strategyState = 'HUNTING';
          if (strategy === 'ANTI_MARTINGALE_SELECT') {
            section.amConsecutiveWins++;
            const betAmt = activeBet.amBetAmount || getAMBetAmount(Math.max(0, section.amConsecutiveWins - 1));
            section.amTotalPNL += betAmt * AM_CONFIG.WIN_MULTIPLIER;
            section.amCurrentBet = getAMBetAmount(section.amConsecutiveWins);
            if (section.amTotalPNL >= AM_CONFIG.TAKE_PROFIT) {
              section.amStopped = true;
              section.amStopReason = 'TAKE_PROFIT';
            }
          }
          if (strategy === 'RECOVERY_3_CHANCE') {
            recoveryAttempt = 0;
          }
          if (strategy === 'STREAK_5_CONTINUE') {
            const betAmt = STREAK5_CONFIG.BET_LADDER[section.streak5Level];
            section.streak5TotalPNL += betAmt * STREAK5_CONFIG.WIN_MULTIPLIER;
            section.streak5Level = 0;
          }
        } else {
          section.totalLosses++;
          if (strategy === 'ANTI_MARTINGALE_SELECT') {
            const betAmt = activeBet.amBetAmount || getAMBetAmount(section.amConsecutiveWins);
            section.amTotalPNL -= betAmt;
            section.amConsecutiveWins = 0;
            section.amCurrentBet = AM_CONFIG.BET_LADDER[0];
            if (section.amTotalPNL <= AM_CONFIG.STOP_LOSS) {
              section.amStopped = true;
              section.amStopReason = 'STOP_LOSS';
            }
          }
          if (strategy === 'STREAK_5_CONTINUE') {
            const betAmt = STREAK5_CONFIG.BET_LADDER[section.streak5Level];
            section.streak5TotalPNL -= betAmt;
            section.streak5Level++;
            if (section.streak5Level >= STREAK5_CONFIG.BET_LADDER.length) {
              section.streak5Level = 0;
            }
          }
          if (strategy === 'RECOVERY_3_CHANCE') {
            recoveryAttempt++;
            if (recoveryAttempt >= 3) {
              section.strategyState = 'WAITING_FOR_TREND_BREAK';
              recoveryAttempt = 0;
            } else {
              section.strategyState = 'HUNTING'; // Keep hunting in same trend
            }
          } else if (strategy === 'RGRG_TREND_BREAK' || strategy === 'SNIPER_3_LOSS_RGRG') {
            section.strategyState = 'WAITING_FOR_TREND_BREAK';
            rgrgHistoryLiveLoss = true;
          } else if (strategy === 'ANTI_MARTINGALE_SELECT') {
            section.strategyState = 'HUNTING';
          } else if (strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3') {
            // Wait for trend break before next pattern
            section.strategyState = 'WAITING_FOR_TREND_BREAK';
            rgrgHistoryLiveLoss = true;
          } else if (strategy === 'CONTRARIAN_DOUBLE') {
            // Reset counter after live loss — re-count 4 virtual losses
            virtualLossCount = 0;
            section.strategyState = 'HUNTING';
          } else {
            section.strategyState = 'HUNTING';
          }
        }
      }

      activeBet = null;
    }

    if (activeBet) continue;

    // Check for trend break if we are waiting for one
    if (section.strategyState === 'WAITING_FOR_TREND_BREAK') {
      if (i > 0 && getColor(periods[i - 1]) === getColor(periods[i])) {
        rgrgHistoryLiveLoss = false;
        recoveryAttempt = 0;
        if (virtualLossCount >= getVirtualLossTarget(strategy)) {
          section.strategyState = 'READY_FOR_LIVE';
        } else {
          section.strategyState = 'HUNTING';
        }
      }
    }

    // Hunt for pattern
    let patternDetected = false;
    let betColor = null;
    let nextPeriod = null;

    if (i >= len - 1) {
      const patternColors = periods
        .slice(i - len + 1, i + 1)
        .map(period => getColor(period));

      if (strategy === 'RGRG_TREND_BREAK' || strategy === 'SNIPER_3_LOSS_RGRG' || strategy === 'RECOVERY_3_CHANCE' || strategy === 'ANTI_MARTINGALE_SELECT' || strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3') {
        if (isAlternating(patternColors)) {
          patternDetected = true;
          betColor = patternColors[patternColors.length - 1];
        }
      } else if (strategy === 'CONTRARIAN_DOUBLE') {
        if (patternColors[0] !== patternColors[1] && patternColors[1] === patternColors[2]) {
          patternDetected = true;
          betColor = patternColors[0];  // RGG→R, GRR→G
        }
      } else if (strategy === 'BREAK_OPPOSITE') {
        if (patternColors[0] !== patternColors[1] && patternColors[1] === patternColors[2]) {
          patternDetected = true;
          betColor = opposite(patternColors[2]);
        }
      } else if (strategy === 'STREAK_BREAK_3') {
        if (patternColors[0] === patternColors[1] && patternColors[1] === patternColors[2]) {
          patternDetected = true;
          betColor = opposite(patternColors[2]);
        }
      } else if (strategy === 'STREAK_5_CONTINUE') {
        if (patternColors.every(c => c === patternColors[0])) {
          patternDetected = true;
          betColor = patternColors[patternColors.length - 1];
        }
      }

      if (patternDetected && i + 1 < periods.length) {
        nextPeriod = periods[i + 1].period;
      }
    }

    if (section.strategyState !== 'HUNTING' && section.strategyState !== 'READY_FOR_LIVE') continue;
    if (!patternDetected || !nextPeriod) continue;
    if (strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3' || strategy === 'CONTRARIAN_DOUBLE') {
      const scanTarget = getVirtualLossTarget(strategy);
      if (virtualLossCount >= scanTarget) {
        activeBet = { color: betColor, period: nextPeriod, isVirtual: false };
        section.strategyState = 'SIGNAL_ACTIVE';
      } else {
        activeBet = { color: betColor, period: nextPeriod, isVirtual: true };
      }
    } else if (strategy === 'ANTI_MARTINGALE_SELECT') {
      activeBet = { color: betColor, period: nextPeriod, isVirtual: false };
      section.strategyState = 'SIGNAL_ACTIVE';
    } else if (strategy === 'SNIPER_3_LOSS_RGRG') {
      if (section.strategyState === 'READY_FOR_LIVE') {
        activeBet = { color: betColor, period: nextPeriod, isVirtual: false };
        section.strategyState = 'SIGNAL_ACTIVE';
      } else {
        activeBet = { color: betColor, period: nextPeriod, isVirtual: true };
      }
    } else if (strategy === 'RECOVERY_3_CHANCE') {
      // Recovery: ALL bets are LIVE
      activeBet = { color: betColor, period: nextPeriod, isVirtual: false };
      section.strategyState = 'SIGNAL_ACTIVE';
    } else {
      activeBet = { color: betColor, period: nextPeriod, isVirtual: false };
      section.strategyState = 'SIGNAL_ACTIVE';
    }
  }

  section.virtualLossCount = virtualLossCount;
  section.lockLossCount = virtualLossCount;
  section.recoveryAttempt = recoveryAttempt;
  

  // Check for current pattern (latest colors)
  checkCurrentPattern(section);
}

function checkCurrentPattern(section) {
  const allPeriods = section.periods;
  const strategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';
  const len = getStrategyPatternLength(strategy);



  if (allPeriods.length < len) {
    section.patternDetected = false;
    section.patternColors = null;
    return;
  }

  const latestColors = allPeriods
    .slice(-len)
    .map(period => getColor(period));

  if (section.freshStartArmed) {
    let currentIsPattern = false;
    if (strategy === 'RGRG_TREND_BREAK' || strategy === 'SNIPER_3_LOSS_RGRG' || strategy === 'RECOVERY_3_CHANCE' || strategy === 'ANTI_MARTINGALE_SELECT' || strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3') {
      currentIsPattern = isAlternating(latestColors);
    } else if (strategy === 'CONTRARIAN_DOUBLE') {
      currentIsPattern = latestColors[0] !== latestColors[1] && latestColors[1] === latestColors[2];
    } else if (strategy === 'BREAK_OPPOSITE') {
      currentIsPattern = latestColors[0] !== latestColors[1] && latestColors[1] === latestColors[2];
    } else if (strategy === 'STREAK_BREAK_3') {
      currentIsPattern = latestColors[0] === latestColors[1] && latestColors[1] === latestColors[2];
    } else if (strategy === 'STREAK_5_CONTINUE') {
      currentIsPattern = latestColors.every(c => c === latestColors[0]);
    }

    if (currentIsPattern) {
      section.patternDetected = false;
      section.patternColors = null;
      persistFreshSignalState();
      return;
    }

    section.freshStartArmed = false;
    section.freshStartAnchorPeriod = allPeriods[allPeriods.length - 1].period;
    section.strategyState = 'HUNTING';
    section.virtualLossCount = 0;
    persistFreshSignalState();
  }

  const periods = getEligiblePeriodsForSignals(section);
  if (periods.length < len) {
    section.patternDetected = false;
    section.patternColors = null;
    return;
  }

  const sliceColors = periods.slice(-len).map(p => getColor(p));
  let isPattern = false;
  if (strategy === 'RGRG_TREND_BREAK' || strategy === 'SNIPER_3_LOSS_RGRG' || strategy === 'RECOVERY_3_CHANCE' || strategy === 'ANTI_MARTINGALE_SELECT' || strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3') {
    isPattern = isAlternating(sliceColors);
  } else if (strategy === 'CONTRARIAN_DOUBLE') {
    isPattern = sliceColors[0] !== sliceColors[1] && sliceColors[1] === sliceColors[2];
  } else if (strategy === 'BREAK_OPPOSITE') {
    isPattern = sliceColors[0] !== sliceColors[1] && sliceColors[1] === sliceColors[2];
  } else if (strategy === 'STREAK_BREAK_3') {
    isPattern = sliceColors[0] === sliceColors[1] && sliceColors[1] === sliceColors[2];
  } else if (strategy === 'STREAK_5_CONTINUE') {
    isPattern = sliceColors.every(c => c === sliceColors[0]);
  }

  if (isPattern) {
    section.patternDetected = true;
    section.patternColors = sliceColors;
  } else {
    section.patternDetected = false;
    section.patternColors = null;
  }
}

function processNewData(key, apiData) {
  const section = state.sections[key];
  const activeStrategy = state.selectedStrategy || 'RGRG_LOCK_RESET';

  if (section.disabled) {
    // If paused, just sync periods data silently.
    section.periods = apiData.periods || [];
    section.lastKnownPeriod = section.periods[section.periods.length - 1]?.period || 0;
    section.nextPeriod = apiData.next_period;
    return;
  }

  const newPeriods = apiData.periods;
  const newNextPeriod = apiData.next_period;

  if (!newPeriods || newPeriods.length === 0) return;

  const isFirstLoad = section.periods.length === 0;

  if (isFirstLoad) {
    // First load - set up and scan history. RGRG virtual 7-loss starts from
    // live observations (or restored state), never from stale history.
    section.periods = newPeriods;
    section.lastKnownPeriod = newPeriods[newPeriods.length - 1].period;
    section.nextPeriod = newNextPeriod;

    // Persist all loaded periods to IndexedDB (non-blocking)
    colorDB.savePeriods(key, newPeriods).then(count => {
      if (count > 0) console.log(`[colorDB] ${key}: Saved ${count} periods (initial load)`);
    });

    if (activeStrategy === 'RGRG_LOCK_RESET') {
      scanHistoryForCycleStrategy(key);
      addLog(`${section.emoji} [${section.name}] Loaded ${newPeriods.length} periods | Cycles: ${section.cycleCount}/4 | Phase: ${section.cyclePhase}`, 'info');
      // Don't arm bets on first load — wait for live updates
    } else if (activeStrategy === 'LOSS_2_RG_GR') {
      // Restore persisted state, log current phase, DON'T arm bets on first load
      addLog(`${section.emoji} [${section.name}] Loaded ${newPeriods.length} periods | Phase: ${section.loss2Phase} | V-Losses: ${section.loss2ConsecLosses}/2`, 'info');
      // If we were in WAIT_RG_GR, check if current last 2 colors already form RG/GR
      // But DON'T arm — wait for next live period to avoid stale data
    } else if (activeStrategy === 'RGR_GRG_3' || activeStrategy === 'CONTRARIAN_DOUBLE') {
      if (section.pendingBet) {
        const resolvedPeriod = newPeriods.find(period => period.period === section.pendingBet.period);
        if (resolvedPeriod) resolveRgrgBet(key, resolvedPeriod);
      }
      checkCurrentPattern(section);
      addLog(`${section.emoji} [${section.name}] Loaded ${newPeriods.length} periods | State: ${section.strategyState}`, 'info');
      if (!section.pendingBet && !isRgrgSectionLocked(section, activeStrategy)) {
        armBetFromCurrentPattern(key, newNextPeriod);
      }
    } else {
      scanHistoryForSection(section);
      addLog(`${section.emoji} [${section.name}] Loaded ${newPeriods.length} periods | State: ${section.strategyState}`, 'info');
      if (!section.pendingBet && !isRgrgSectionLocked(section, activeStrategy)) {
        armBetFromCurrentPattern(key, newNextPeriod);
      }
    }

    // Mark initial load complete for this section after first arm
    // We'll clear the global flag after ALL sections have loaded
    return;
  }

  // Find new resolved periods
  const previousLastPeriod = section.lastKnownPeriod;
  const latestPeriodInData = newPeriods[newPeriods.length - 1].period;

  if (latestPeriodInData <= previousLastPeriod) {
    return; // No new data
  }

  // Get newly resolved periods
  const newResolvedPeriods = newPeriods.filter(p => p.period > previousLastPeriod);

  // Check pending bet outcomes
  for (const period of newResolvedPeriods) {
    if (section.pendingBet && period.period === section.pendingBet.period) {
      const resolvedBet = section.pendingBet;
      section.pendingBet = null;

      const actualColor = getColor(period);
      const won = actualColor === resolvedBet.color;
      const strategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';

      if (strategy === 'LOSS_2_RG_GR') {
        section.pendingBet = resolvedBet;
        resolveLoss2Bet(key, period);
        continue;
      }

      if (strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3' || strategy === 'CONTRARIAN_DOUBLE') {
        section.pendingBet = resolvedBet;
        resolveRgrgBet(key, period);
        continue;
      }

      if (resolvedBet.isVirtual) {
        // Resolve virtual bet (Sniper mode)
        if (won) {
          section.virtualLossCount = 0;
          section.strategyState = 'HUNTING';
          addLog(
            `👁️ [${section.name}] Sniper Virtual WIN (No real bet) on #${formatPeriod(period.period)}. Resetting sniper.`,
            'info'
          );
        } else {
          section.virtualLossCount = Math.min(VIRTUAL_LOSS_DOTS_MAX, section.virtualLossCount + 1);
          section.strategyState = 'WAITING_FOR_TREND_BREAK';
          section.rgrgLiveLoss = false;
          addLog(
            `👁️ [${section.name}] Sniper Virtual LOSS (No real bet) on #${formatPeriod(period.period)}. Count: ${section.virtualLossCount}/${VIRTUAL_LOSS_TARGET}.`,
            'info'
          );
        }
      } else {
        // Resolve LIVE bet
        section.betHistory.push({
          period: period.period,
          betColor: resolvedBet.color,
          actualColor,
          won
        });

        if (won) {
          section.totalWins++;
          section.virtualLossCount = 0;
          section.lockLossCount = 0;
          addLog(
            `✅ [${section.name}] WIN! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)} (#${formatPeriod(period.period)})`,
            'win'
          );
          hideSignalBanner();
          playAlertSound();
          showToast(`✅ ${section.name} WIN!`, 'success');
          section.strategyState = 'HUNTING';
          if (strategy === 'RECOVERY_3_CHANCE') {
            section.recoveryAttempt = 0;
          }
          if (strategy === 'STREAK_5_CONTINUE') {
            const betAmt = STREAK5_CONFIG.BET_LADDER[section.streak5Level];
            section.streak5TotalPNL += betAmt * STREAK5_CONFIG.WIN_MULTIPLIER;
            section.streak5Level = 0;
            addLog(`💰 [${section.name}] Streak5 PNL: ₹${section.streak5TotalPNL.toFixed(1)} | Reset to Lv1`, 'info');
          }
        } else {
          section.totalLosses++;
          hideSignalBanner();
          if (strategy === 'RECOVERY_3_CHANCE') {
            section.recoveryAttempt++;
            const attemptNum = section.recoveryAttempt;
            if (attemptNum >= 3) {
              addLog(
                `❌ [${section.name}] LOSS #3! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)}. 3 chances used — Cooling down.`,
                'loss'
              );
              section.strategyState = 'WAITING_FOR_TREND_BREAK';
              section.recoveryAttempt = 0;
            } else {
              addLog(
                `❌ [${section.name}] LOSS! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)}. Recovery ${attemptNum}/3 — Hunting next pattern in same trend.`,
                'loss'
              );
              section.strategyState = 'HUNTING'; // Keep hunting in same trend
            }
          } else if (strategy === 'RGRG_TREND_BREAK' || strategy === 'SNIPER_3_LOSS_RGRG') {
            addLog(
              `❌ [${section.name}] LOSS! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)}.`,
              'loss'
            );
            section.strategyState = 'WAITING_FOR_TREND_BREAK';
            section.rgrgLiveLoss = true;
          } else {
            addLog(
              `❌ [${section.name}] LOSS! Bet ${colorName(resolvedBet.color)}, Got ${colorName(actualColor)}.`,
              'loss'
            );
            section.strategyState = 'HUNTING';
          }
          if (strategy === 'STREAK_5_CONTINUE') {
            const betAmt = STREAK5_CONFIG.BET_LADDER[section.streak5Level];
            section.streak5TotalPNL -= betAmt;
            section.streak5Level++;
            if (section.streak5Level >= STREAK5_CONFIG.BET_LADDER.length) {
              section.streak5Level = 0;
              addLog(`💀 [${section.name}] 4 consecutive losses! -₹150 cycle. Reset to Lv1`, 'loss');
            } else {
              addLog(`💰 [${section.name}] Streak5 PNL: ₹${section.streak5TotalPNL.toFixed(1)} | Next: Lv${section.streak5Level + 1} (₹${STREAK5_CONFIG.BET_LADDER[section.streak5Level]})`, 'info');
            }
          }
        }
      }
    }
  }

  // Update stored periods
  section.periods = newPeriods;
  section.lastKnownPeriod = latestPeriodInData;
  section.nextPeriod = newNextPeriod;

  // Persist new resolved periods to IndexedDB (non-blocking)
  if (newResolvedPeriods && newResolvedPeriods.length > 0) {
    colorDB.savePeriods(key, newResolvedPeriods).then(count => {
      if (count > 0) console.log(`[colorDB] ${key}: Saved ${count} new periods`);
    });
  }

  // Strategy-specific logic after period update
  const strategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';

  if (strategy === 'RGRG_LOCK_RESET') {
    // Cycle counting strategy — process new colors for cycle detection
    if (!section.pendingBet) {
      processCycleStrategy(key);
    }
  } else if (strategy === 'LOSS_2_RG_GR') {
    // 2-Loss RG/GR strategy — fully self-contained
    processLoss2Strategy(key);
  } else {
    // Other strategies: trend break check + pattern hunting
    if (section.strategyState === 'WAITING_FOR_TREND_BREAK') {
      if (hasTrendBreakSince(section.periods, previousLastPeriod)) {
        section.rgrgLiveLoss = false;
        section.recoveryAttempt = 0;
        if (strategy === 'RGR_GRG_3' || strategy === 'CONTRARIAN_DOUBLE') {
          persistRgrgLockState();
        }
        
        if (section.virtualLossCount >= getVirtualLossTarget(strategy)) {
          section.strategyState = 'READY_FOR_LIVE';
        } else {
          section.strategyState = 'HUNTING';
        }
        addLog(`🔄 [${section.name}] Trend ended (consecutive same colors). Re-armed and hunting.`, 'info');
      }
    }

    // Hunt for next pattern if no active bet and state is HUNTING/READY_FOR_LIVE
    if (!section.pendingBet && (section.strategyState === 'HUNTING' || section.strategyState === 'READY_FOR_LIVE')) {
      armBetFromCurrentPattern(key, newNextPeriod);
    }
  }
}

// ============ SIMPLIFIED SIGNAL FLOW ============

function resetAllSections() {
  for (const key of Object.keys(state.sections)) {
    const section = state.sections[key];
    section.pendingBet = null;
    section.patternDetected = false;
    section.patternColors = null;
    section.totalWins = 0;
    section.totalLosses = 0;
    section.betHistory = [];
    section.freshStartArmed = false;
    section.freshStartAnchorPeriod = 0;
    section.strategyState = 'HUNTING';
    section.virtualLossCount = 0;
    section.recoveryAttempt = 0;
    section.lockLossCount = 0;
    section.rgrgLocked = false;
    section.rgrgLiveLoss = false;
  }

  persistRgrgLockState();
  persistFreshSignalState();
}

function startFreshSignalsNow() {
  state.lastNotifiedPeriod = 0;

  for (const section of Object.values(state.sections)) {
    const ignoreCurrentPattern = sectionHasLiveAlternatingPattern(section);
    const anchorPeriod = section.lastKnownPeriod || section.periods[section.periods.length - 1]?.period || 0;

    section.pendingBet = null;
    section.patternDetected = false;
    section.patternColors = null;
    section.totalWins = 0;
    section.totalLosses = 0;
    section.betHistory = [];
    section.freshStartArmed = ignoreCurrentPattern;
    section.freshStartAnchorPeriod = anchorPeriod;
    section.strategyState = 'HUNTING';
    section.virtualLossCount = 0;
    section.recoveryAttempt = 0;
    section.lockLossCount = 0;
    section.rgrgLocked = false;
    section.rgrgLiveLoss = false;
  }

  hideSignalBanner();
  persistRgrgLockState();
  persistFreshSignalState();
  renderAll();

  addLog(
    '🔄 Manual fresh reset applied. Current pattern cleared, now watching only fresh signals from this point.',
    'reset'
  );
  showToast('Fresh signal mode started from current point.', 'success');
  sendSystemNotification(
    '🔄 Fresh Signals',
    'Current pattern and cycle reset. Now watching fresh signals from this point.'
  );
}

// ============ UPGRADE EVENT HANDLERS ============

function changeStrategy(newStrategy) {
  if (HIDDEN_STRATEGIES.has(newStrategy)) {
    newStrategy = DEFAULT_STRATEGY;
  }

  state.selectedStrategy = newStrategy;
  localStorage.setItem('wingo-selected-strategy', newStrategy);
  
  addLog(`⚙️ Strategy changed to: ${newStrategy.replace(/_/g, ' ')}`, 'info');
  showToast('Strategy mode changed. Will apply from next period.', 'success');
}

function toggleSection(key, isChecked) {
  const section = state.sections[key];
  if (!section) return;

  section.disabled = !isChecked;
  section.profitLocked = false;
  
  persistDisabledSections();

  if (section.disabled) {
    section.pendingBet = null;
    section.patternDetected = false;
    section.patternColors = null;
    section.strategyState = 'HUNTING';
    section.virtualLossCount = 0;
    section.recoveryAttempt = 0;
    section.rgrgLiveLoss = false;
    hideSignalBanner();
  } else {
    if (state.selectedStrategy === 'RGRG_LOCK_RESET' || state.selectedStrategy === 'RGR_GRG_3') {
      clearRgrgSectionLock(section);
      checkCurrentPattern(section);
    } else {
      scanHistoryForSection(section);
    }
    if (!section.pendingBet && (section.strategyState === 'HUNTING' || section.strategyState === 'READY_FOR_LIVE')) {
      armBetFromCurrentPattern(key, section.nextPeriod);
    }
  }

  renderAll();
  
  addLog(
    `🔧 [${section.name}] is now ${isChecked ? 'ENABLED' : 'PAUSED'}`,
    'info'
  );
  showToast(`${section.name} is ${isChecked ? 'Enabled' : 'Paused'}`, 'success');
}

// ============ UI RENDERING ============

function renderSection(key) {
  const section = state.sections[key];
  const currentStrategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';
  const toggleEl = document.getElementById(`toggle-${key}`);
  if (toggleEl) {
    toggleEl.checked = !section.disabled;
  }

  // Period info
  const periodEl = document.getElementById(`period-P`.replace('P', key));
  const nextPeriodEl = document.getElementById(`next-period-P`.replace('P', key));
  if (section.periods.length > 0) {
    const last = section.periods[section.periods.length - 1];
    periodEl.textContent = `Latest: #${formatPeriod(last.period)}`;
    nextPeriodEl.textContent = `Next: #${formatPeriod(section.nextPeriod)}`;
  }

  // Color trend dots
  renderColorDots(key);

  // Pattern status
  const patternEl = document.getElementById(`pattern-${key}`);
  if (section.disabled) {
    patternEl.textContent = 'Disabled';
    patternEl.className = 'pattern-status no-pattern';
  } else if (section.patternDetected && section.patternColors) {
    patternEl.textContent = `Pattern: ${section.patternColors.join(' → ')}`;
    patternEl.className = 'pattern-status pattern-found';
  } else {
    patternEl.textContent = 'No Pattern';
    patternEl.className = 'pattern-status no-pattern';
  }

  // Bet info
  const betEl = document.getElementById(`bet-${key}`);
  if (section.disabled) {
    betEl.textContent = 'PAUSED';
    betEl.className = 'bet-info bet-none';
  } else if (section.pendingBet) {
    const colorLabel = colorName(section.pendingBet.color);
    const virtualText = section.pendingBet.isVirtual ? ' (V)' : '';
    betEl.textContent = `Bet: ${colorLabel}${virtualText}`;
    betEl.className = `bet-info bet-${colorLabel.toLowerCase()}`;
  } else if ((currentStrategy === 'RGRG_LOCK_RESET' || currentStrategy === 'RGR_GRG_3' || currentStrategy === 'CONTRARIAN_DOUBLE') && section.virtualLossCount >= getVirtualLossTarget(currentStrategy)) {
    betEl.textContent = 'NEXT LIVE';
    betEl.className = 'bet-info bet-green';
  } else {
    betEl.textContent = '--';
    betEl.className = 'bet-info bet-none';
  }

  // Stats
  document.getElementById(`wins-${key}`).textContent = `W: ${section.totalWins}`;
  document.getElementById(`losses-${key}`).textContent = `L: ${section.totalLosses}`;
  
  // Strategy state label — simple: Hunting or LIVE
  let stateLabel = '🔍 Hunting';
  if (section.disabled) {
    stateLabel = '⏸️ Paused';
  } else if (section.strategyState === 'SIGNAL_ACTIVE') {
    if (currentStrategy === 'RECOVERY_3_CHANCE') {
      const attemptNum = section.recoveryAttempt + 1;
      stateLabel = attemptNum === 1 ? '🎯 Signal #1' : attemptNum === 2 ? '🔄 Recovery #2' : '⚠️ LAST #3';
    } else {
      stateLabel = '🎯 LIVE Signal';
    }
  } else if (section.strategyState === 'WAITING_FOR_TREND_BREAK') {
    stateLabel = currentStrategy === 'RECOVERY_3_CHANCE' ? '❄️ Cooldown' : '⏳ Wait Trend';
  } else if (currentStrategy === 'RGRG_LOCK_RESET' && section.cyclePhase === 'WAITING_CONFIRM') {
    stateLabel = `⏳ Waiting for ${colorName(section.confirmColor)}...`;
  } else if (currentStrategy === 'RGRG_LOCK_RESET' && section.cyclePhase === 'WAITING_TREND_BREAK') {
    stateLabel = `👁️ ${section.cycleCount}/4: Waiting Trend Break...`;
  } else if (currentStrategy === 'RGRG_LOCK_RESET' && section.cyclePhase === 'POST_BREAK_HUNTING') {
    stateLabel = `🔍 ${section.cycleCount}/4: Hunting Next RGRG...`;
  } else if (currentStrategy === 'LOSS_2_RG_GR') {
    if (section.loss2Phase === 'WAIT_RG_GR') {
      stateLabel = '⏳ Wait RG/GR';
    } else if (section.loss2Phase === 'BET_1') {
      stateLabel = '🎯 Bet 1';
    } else if (section.loss2Phase === 'BET_2') {
      stateLabel = '🔄 Bet 2 Recovery';
    } else if (section.loss2ConsecLosses > 0) {
      stateLabel = `👁️ V-Loss: ${section.loss2ConsecLosses}/2`;
    }
  } else if ((currentStrategy === 'RGR_GRG_3' || currentStrategy === 'CONTRARIAN_DOUBLE') && section.virtualLossCount >= getVirtualLossTarget(currentStrategy)) {
    stateLabel = `✅ Ready (${section.virtualLossCount} losses)`;
  } else if ((currentStrategy === 'RGR_GRG_3' || currentStrategy === 'CONTRARIAN_DOUBLE') && section.virtualLossCount > 0) {
    stateLabel = `👁️ V-Loss: ${section.virtualLossCount}/${getVirtualLossTarget(currentStrategy)}`;
  } else if (section.patternDetected) {
    stateLabel = '📊 Pattern Found';
  } else if (currentStrategy === 'RECOVERY_3_CHANCE' && section.recoveryAttempt > 0) {
    stateLabel = `🔄 Recovery ${section.recoveryAttempt}/3`;
  } else if (section.virtualLossCount > 0) {
    stateLabel = `🔍 V-Loss: ${section.virtualLossCount}/${VIRTUAL_LOSS_TARGET}`;
  }
  document.getElementById(`streak-${key}`).textContent = stateLabel;

  // Section status badge
  const statusEl = document.getElementById(`status-${key}`);
  if (section.disabled) {
    statusEl.textContent = 'PAUSED';
    statusEl.className = 'section-status status-paused';
  } else if (section.pendingBet) {
    statusEl.textContent = section.pendingBet.isVirtual ? 'V-BET' : '🎯 TRADE';
    statusEl.className = section.pendingBet.isVirtual ? 'section-status status-pattern' : 'section-status status-signal';
  } else if (currentStrategy === 'RGRG_LOCK_RESET' && section.cyclePhase === 'WAITING_CONFIRM') {
    statusEl.textContent = '✅ Confirm';
    statusEl.className = 'section-status status-profit';
  } else if ((currentStrategy === 'RGR_GRG_3' || currentStrategy === 'CONTRARIAN_DOUBLE') && section.virtualLossCount >= getVirtualLossTarget(currentStrategy)) {
    statusEl.textContent = '✅ Ready';
    statusEl.className = 'section-status status-profit';
  } else if (section.strategyState === 'WAITING_FOR_TREND_BREAK' || (currentStrategy === 'RGRG_LOCK_RESET' && section.cyclePhase === 'WAITING_TREND_BREAK')) {
    statusEl.textContent = 'Wait Trend';
    statusEl.className = 'section-status status-watching';
  } else if (hasFreshSignalState(section)) {
    statusEl.textContent = 'Fresh Reset';
    statusEl.className = 'section-status status-watching';
  } else if (currentStrategy === 'LOSS_2_RG_GR') {
    if (section.loss2Phase === 'WAIT_RG_GR') {
      statusEl.textContent = '✅ Ready';
      statusEl.className = 'section-status status-profit';
    } else if (section.loss2ConsecLosses > 0) {
      statusEl.textContent = `V-Loss: ${section.loss2ConsecLosses}`;
      statusEl.className = 'section-status status-pattern';
    } else {
      statusEl.textContent = 'Watching';
      statusEl.className = 'section-status status-watching';
    }
  } else if (section.patternDetected) {
    statusEl.textContent = 'Pattern!';
    statusEl.className = 'section-status status-pattern';
  } else {
    statusEl.textContent = 'Watching';
    statusEl.className = 'section-status status-watching';
  }

  // Card classes
  const cardEl = document.getElementById(`card-${key}`);
  cardEl.classList.remove('active', 'signal-triggered', 'signal-green', 'signal-red', 'paused', 'hunting', 'virtual-tracking', 'virtual-ready-highlight', 'profit-locked');

  if (section.disabled) {
    cardEl.classList.add('paused');
  } else if (section.pendingBet && !section.pendingBet.isVirtual) {
    cardEl.classList.add('signal-triggered');
    cardEl.classList.add(section.pendingBet.color === 'G' ? 'signal-green' : 'signal-red');
  } else if ((currentStrategy === 'RGRG_LOCK_RESET' || currentStrategy === 'RGR_GRG_3' || currentStrategy === 'CONTRARIAN_DOUBLE') && section.virtualLossCount >= getVirtualLossTarget(currentStrategy)) {
    cardEl.classList.add('virtual-ready-highlight');
  } else if (currentStrategy === 'LOSS_2_RG_GR' && section.loss2Phase === 'WAIT_RG_GR') {
    cardEl.classList.add('virtual-ready-highlight');
  } else if ((currentStrategy === 'RGRG_LOCK_RESET' || currentStrategy === 'RGR_GRG_3' || currentStrategy === 'CONTRARIAN_DOUBLE') && (section.pendingBet?.isVirtual || section.virtualLossCount > 0)) {
    cardEl.classList.add('virtual-tracking');
  } else if (section.patternDetected) {
    cardEl.classList.add('active');
  }

  // In-card trade banner
  renderTradeBanner(key);

  // Bet history ribbon
  renderBetHistory(key);

  // Sniper loss tracker
  renderSniperTracker(key);

  const sectionCard = document.getElementById(`card-${key}`);
  if (sectionCard) {
    if (!section.disabled && section.virtualLossCount >= getVirtualLossTarget(currentStrategy)) {
      sectionCard.classList.add('virtual-ready-highlight');
    } else {
      sectionCard.classList.remove('virtual-ready-highlight');
    }
  }
}

function renderColorDots(key) {
  const section = state.sections[key];
  const container = document.getElementById(`trend-${key}`);
  container.innerHTML = '';

  const periods = section.periods;
  const startIdx = Math.max(0, periods.length - CONFIG.MAX_DOTS_DISPLAY);
  const displayPeriods = periods.slice(startIdx);

  // Determine pattern highlight range
  let patternStart = -1;
  const strategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';
  const len = getStrategyPatternLength(strategy);
  if (section.patternDetected && displayPeriods.length >= len) {
    patternStart = displayPeriods.length - len;
  }

  displayPeriods.forEach((period, idx) => {
    const dot = document.createElement('div');
    const num = period.last_num;

    // Determine CSS class
    let dotClass = 'color-dot';
    if (period.is_violet) {
      dotClass += period.is_green ? ' green-violet' : ' red-violet';
    } else if (period.is_green) {
      dotClass += ' green';
    } else {
      dotClass += ' red';
    }

    // Latest dot
    if (idx === displayPeriods.length - 1) {
      dotClass += ' latest';
    }

    // Pattern highlight
    if (patternStart >= 0 && idx >= patternStart) {
      dotClass += ' pattern-highlight';
    }

    dot.className = dotClass;
    dot.textContent = num;
    dot.title = `#${formatPeriod(period.period)} | Num: ${num} | ${period.is_green ? 'Green' : 'Red'}${period.is_violet ? '+Violet' : ''}`;

    container.appendChild(dot);
  });
}

function renderBetHistory(key) {
  const section = state.sections[key];
  const container = document.getElementById(`history-${key}`);
  container.innerHTML = '';

  // Show last 10 bet results
  const recent = section.betHistory.slice(-10);
  if (recent.length === 0) return;

  recent.forEach(bet => {
    const dot = document.createElement('div');
    dot.className = `bet-result-dot ${bet.won ? 'result-win' : 'result-loss'}`;
    dot.textContent = bet.won ? '✓' : '✗';
    dot.title = `Bet: ${colorName(bet.betColor)}, Got: ${colorName(bet.actualColor)} → ${bet.won ? 'WIN' : 'LOSS'}`;
    container.appendChild(dot);
  });
}

function renderSniperTracker(key) {
  const section = state.sections[key];
  const tracker = document.getElementById(`sniper-tracker-${key}`);
  if (!tracker) return;

  const strategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';
  // Show for Sniper, Recovery, RGRG Lock Reset, and LOSS_2_RG_GR strategies
  if ((strategy !== 'SNIPER_3_LOSS_RGRG' && strategy !== 'RECOVERY_3_CHANCE' && strategy !== 'RGRG_LOCK_RESET' && strategy !== 'RGR_GRG_3' && strategy !== 'CONTRARIAN_DOUBLE' && strategy !== 'LOSS_2_RG_GR') || section.disabled) {
    tracker.style.display = 'none';
    return;
  }

  tracker.style.display = '';

  const labelEl = tracker.querySelector('.sniper-label');
  const countEl = document.getElementById(`sniper-count-${key}`);

  if (strategy === 'LOSS_2_RG_GR') {
    if (labelEl) labelEl.textContent = '2-Loss Hunt:';
    const count = section.loss2ConsecLosses || 0;
    const isReady = section.loss2Phase === 'WAIT_RG_GR';
    const isLive = section.loss2Phase === 'BET_1' || section.loss2Phase === 'BET_2';

    // Show dots
    for (let i = 1; i <= 2; i++) {
      const dot = document.getElementById(`sniper-dot-${key}-${i}`);
      if (!dot) continue;

      dot.style.display = '';
      dot.classList.remove('filled', 'ready');
      if (i <= count) {
        dot.classList.add('filled');
      }
      if (count >= 2 || isReady || isLive) {
        dot.classList.add('ready');
      }
    }
    
    // Hide unused dots
    for (let i = 3; i <= 10; i++) {
      const dot = document.getElementById(`sniper-dot-${key}-${i}`);
      if (dot) dot.style.display = 'none';
    }

    if (isLive) {
      countEl.textContent = `🎯 LIVE!`;
      countEl.className = 'sniper-count sniper-live';
      tracker.classList.add('tracker-live');
      tracker.classList.remove('tracker-ready');
    } else if (isReady) {
      countEl.textContent = `✅ READY!`;
      countEl.className = 'sniper-count sniper-ready';
      tracker.classList.add('tracker-ready');
      tracker.classList.remove('tracker-live');
    } else {
      countEl.textContent = `${count}/2`;
      countEl.className = 'sniper-count';
      tracker.classList.remove('tracker-ready', 'tracker-live');
    }
  } else if (strategy === 'RGRG_LOCK_RESET' || strategy === 'RGR_GRG_3' || strategy === 'CONTRARIAN_DOUBLE') {
    const vTarget = getVirtualLossTarget(strategy);
    const dotsMax = 10;
    if (labelEl) labelEl.textContent = 'RGRG Loss:';
    const count = section.virtualLossCount || 0;
    const isLive = section.strategyState === 'SIGNAL_ACTIVE' && section.pendingBet && !section.pendingBet.isVirtual;

    // Show dots
    for (let i = 1; i <= dotsMax; i++) {
      const dot = document.getElementById(`sniper-dot-${key}-${i}`);
      if (!dot) continue;
      
      dot.style.display = i <= VIRTUAL_LOSS_DOTS_MAX ? '' : 'none';

      dot.classList.remove('filled', 'ready');
      if (i <= count) {
        dot.classList.add('filled');
      }
      if (count >= vTarget) {
        dot.classList.add('ready');
      }
    }

    if (isLive) {
      countEl.textContent = `🎯 LIVE!`;
      countEl.className = 'sniper-count sniper-live';
      tracker.classList.add('tracker-live');
      tracker.classList.remove('tracker-ready');
    } else if (section.strategyState === 'READY_FOR_LIVE' || count >= vTarget) {
      countEl.textContent = `✅ READY (${count})`;
      countEl.className = 'sniper-count sniper-ready';
      tracker.classList.add('tracker-ready');
      tracker.classList.remove('tracker-live');
    } else if (count > 0) {
      countEl.textContent = `${count}/${vTarget}`;
      countEl.className = 'sniper-count';
      tracker.classList.remove('tracker-ready', 'tracker-live');
    } else {
      countEl.textContent = `0/${vTarget}`;
      countEl.className = 'sniper-count';
      tracker.classList.remove('tracker-ready', 'tracker-live');
    }
  } else if (strategy === 'RECOVERY_3_CHANCE') {
    // Recovery 3-Chance mode
    if (labelEl) labelEl.textContent = 'Recovery:';
    const count = section.recoveryAttempt || 0;
    const isLive = section.strategyState === 'SIGNAL_ACTIVE' && section.pendingBet && !section.pendingBet.isVirtual;
    const isCooldown = section.strategyState === 'WAITING_FOR_TREND_BREAK';

    // Update dots — show recovery attempts used
    for (let i = 1; i <= 3; i++) {
      const dot = document.getElementById(`sniper-dot-${key}-${i}`);
      if (!dot) continue;
      
      dot.style.display = '';
      dot.classList.remove('filled', 'ready');
      if (i <= count) {
        dot.classList.add('filled');
      }
      if (count >= 2 || isLive) {
        dot.classList.add('ready');
      }
    }
    
    // Hide unused dots
    for (let i = 4; i <= 10; i++) {
      const dot = document.getElementById(`sniper-dot-${key}-${i}`);
      if (dot) dot.style.display = 'none';
    }

    // Update count text
    if (isCooldown) {
      countEl.textContent = '❄️ Cooldown';
      countEl.className = 'sniper-count';
      tracker.classList.remove('tracker-ready', 'tracker-live');
    } else if (isLive) {
      const attemptNum = count + 1;
      const label = attemptNum === 1 ? '🎯 #1' : attemptNum === 2 ? '🔄 #2' : '⚠️ LAST!';
      countEl.textContent = label;
      countEl.className = attemptNum >= 3 ? 'sniper-count sniper-live' : 'sniper-count sniper-ready';
      tracker.classList.add(attemptNum >= 3 ? 'tracker-live' : 'tracker-ready');
      tracker.classList.remove(attemptNum >= 3 ? 'tracker-ready' : 'tracker-live');
    } else if (count > 0) {
      countEl.textContent = `${count}/3 used`;
      countEl.className = 'sniper-count';
      tracker.classList.remove('tracker-ready', 'tracker-live');
    } else {
      countEl.textContent = '0/3';
      countEl.className = 'sniper-count';
      tracker.classList.remove('tracker-ready', 'tracker-live');
    }
  } else {
    // Original Sniper mode
    if (labelEl) labelEl.textContent = 'Sniper Loss:';
    const count = section.virtualLossCount || 0;
    const isReady = section.strategyState === 'READY_FOR_LIVE';
    const isLive = section.strategyState === 'SIGNAL_ACTIVE' && section.pendingBet && !section.pendingBet.isVirtual;

    // Update dots
    for (let i = 1; i <= 10; i++) {
      const dot = document.getElementById(`sniper-dot-${key}-${i}`);
      if (!dot) continue;
      
      dot.style.display = i <= VIRTUAL_LOSS_TARGET ? '' : 'none';

      dot.classList.remove('filled', 'ready');
      if (i <= count) {
        dot.classList.add('filled');
      }
      if (count >= VIRTUAL_LOSS_TARGET || isReady || isLive) {
        dot.classList.add('ready');
      }
    }

    // Update count text
    if (isLive) {
      countEl.textContent = '🎯 LIVE!';
      countEl.className = 'sniper-count sniper-live';
      tracker.classList.add('tracker-live');
      tracker.classList.remove('tracker-ready');
    } else if (isReady || count >= VIRTUAL_LOSS_TARGET) {
      countEl.textContent = '✅ READY!';
      countEl.className = 'sniper-count sniper-ready';
      tracker.classList.add('tracker-ready');
      tracker.classList.remove('tracker-live');
    } else {
      countEl.textContent = `${count}/${VIRTUAL_LOSS_TARGET}`;
      countEl.className = 'sniper-count';
      tracker.classList.remove('tracker-ready', 'tracker-live');
    }
  }
}

function renderLog(entry) {
  const container = document.getElementById('activity-log');

  // Remove empty state on first entry
  const emptyState = container.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const iconMap = {
    info: 'ℹ️',
    pattern: '🎯',
    win: '✅',
    loss: '❌',
    signal: '🚨',
    reset: '🔄'
  };

  const el = document.createElement('div');
  el.className = `log-entry log-${entry.type}`;
  el.innerHTML = `
    <span class="log-time">${entry.time}</span>
    <span class="log-icon">${iconMap[entry.type] || 'ℹ️'}</span>
    <span class="log-text">${entry.message}</span>
  `;

  container.insertBefore(el, container.firstChild);

  // Trim old entries
  while (container.children.length > CONFIG.MAX_LOG_ENTRIES) {
    container.removeChild(container.lastChild);
  }
}

function renderStrategyPanel() {
  const modeText = document.getElementById('mode-text');
  const activeSectionText = document.getElementById('active-section-text');
  const nextSignalText = document.getElementById('next-signal-text');
  const appStatus = document.getElementById('app-status');
  const freshResetActive = Object.values(state.sections).some(section => hasFreshSignalState(section));

  // Virtual bets stay silent; only the sixth/live bet is a trade signal.
  const activeTrades = [];
  for (const [key, section] of Object.entries(state.sections)) {
    if (section.pendingBet && !section.pendingBet.isVirtual) {
      activeTrades.push({ key, section });
    }
  }

  const patternSections = Object.values(state.sections)
    .filter(section => section.patternDetected);

  const waitingSections = Object.values(state.sections)
    .filter(section => section.strategyState === 'WAITING_FOR_TREND_BREAK');

  if (activeTrades.length > 0) {
    modeText.textContent = '🎯 TRADE ACTIVE';
    modeText.className = 'value signal-mode';
    const names = activeTrades.map(t => t.section.name).join(', ');
    activeSectionText.textContent = names;
    appStatus.textContent = `🎯 ${activeTrades.length} TRADE${activeTrades.length > 1 ? 'S' : ''}`;
    appStatus.className = 'status-badge signal-active';

    const tradeTexts = activeTrades.map(t => {
      const betColor = colorName(t.section.pendingBet.color);
      return `${t.section.name}: ${betColor}`;
    });
    nextSignalText.textContent = tradeTexts.join(' | ');
    nextSignalText.style.color = '';
  } else if (patternSections.length > 0) {
    modeText.textContent = '📊 PATTERN FOUND';
    modeText.className = 'value hunting-mode';
    activeSectionText.textContent = patternSections.map(s => s.name).join(', ');
    appStatus.textContent = 'PATTERN';
    appStatus.className = 'status-badge hunting';
    nextSignalText.textContent = 'Pattern detected! Signal will fire on next period.';
    nextSignalText.style.color = '';
  } else if (waitingSections.length > 0) {
    modeText.textContent = '⏳ WAIT TREND';
    modeText.className = 'value reset-mode';
    activeSectionText.textContent = waitingSections.map(s => s.name).join(', ');
    appStatus.textContent = 'WAIT TREND';
    appStatus.className = 'status-badge watching';
    nextSignalText.textContent = 'Waiting for alternating trend to end before hunting next signal.';
    nextSignalText.style.color = '';
  } else if (freshResetActive) {
    modeText.textContent = 'FRESH WATCH';
    modeText.className = 'value reset-mode';
    activeSectionText.textContent = 'All Sections';
    appStatus.textContent = 'FRESH START';
    appStatus.className = 'status-badge watching';
    nextSignalText.textContent = 'Fresh reset active. Waiting for current trend to clear and new pattern to form.';
    nextSignalText.style.color = '';
  } else {
    modeText.textContent = 'WATCHING';
    modeText.className = 'value watching-mode';
    activeSectionText.textContent = 'All Sections';
    appStatus.textContent = 'WATCHING ALL';
    appStatus.className = 'status-badge watching';
    nextSignalText.textContent = 'Monitoring all sections for RGRG/GRGR patterns...';
    nextSignalText.style.color = '';
  }
}

function renderAll() {
  for (const key of Object.keys(CONFIG.SECTIONS)) {
    renderSection(key);
  }
  renderStrategyPanel();
  updateLastUpdateTime();
}

function updateLastUpdateTime() {
  document.getElementById('last-update').textContent = formatTime();
}

// ============ SIGNAL BANNER ============



function showSignalBanner(key) {
  const section = state.sections[key];
  const banner = document.getElementById('signal-banner');
  const mainText = document.getElementById('signal-main-text');
  const subText = document.getElementById('signal-sub-text');

  mainText.textContent = `🎯 TRADE: ${section.name.toUpperCase()}`;

  if (section.pendingBet && !section.pendingBet.isVirtual) {
    const betColor = colorName(section.pendingBet.color);
    const periodStr = formatPeriod(section.pendingBet.period);
    subText.textContent = `Next Bet: ${betColor} on Period #${periodStr}`;
    banner.className = `signal-banner signal-${betColor.toLowerCase()}`;
    
    // Notification logic
    const period = section.pendingBet.period;
    if (section.lastNotifiedPeriod !== period) {
      section.lastNotifiedPeriod = period;
      sendSystemNotification(
        `🎯 Wingo: ${section.name} Trade`,
        `Bet ${betColor} on Period #${periodStr}!`
      );
    }
  } else {
    subText.textContent = `${section.name} highlighted — waiting for next live pattern`;
    banner.className = 'signal-banner signal-hunting';
    
    // Notification logic
    const uniqueKey = `${section.lastKnownPeriod}_highlighted`;
    if (section.lastNotifiedPeriod !== uniqueKey) {
      section.lastNotifiedPeriod = uniqueKey;
      sendSystemNotification(
        `🎯 Wingo: ${section.name} Highlighted`,
        `${section.name} is highlighted and waiting for pattern...`
      );
    }
  }

  // Shift content down
  document.getElementById('app-header').style.paddingTop = '80px';
}

function updateSignalBanner(key) {
  const section = state.sections[key];
  const subText = document.getElementById('signal-sub-text');

  if (section.pendingBet) {
    const betColor = colorName(section.pendingBet.color);
    const periodStr = formatPeriod(section.pendingBet.period);
    subText.textContent = `Next Bet: ${betColor} on Period #${periodStr}`;
    const banner = document.getElementById('signal-banner');
    banner.className = `signal-banner signal-${betColor.toLowerCase()}`;
    
    // Notification logic
    const period = section.pendingBet.period;
    if (section.lastNotifiedPeriod !== period) {
      section.lastNotifiedPeriod = period;
      playTradeReadySound();  // Play sound for new bet signal
      sendSystemNotification(
        `🚨 Wingo: ${section.name} Bet`,
        `Next Bet: ${betColor} on Period #${periodStr}!`
      );
    }
  } else {
    subText.textContent = 'Hunting for RGRG/GRGR pattern...';
  }
}

function hideSignalBanner() {
  // Check if any other section still has an active live bet
  const activeSectionKey = Object.keys(state.sections).find(
    key => state.sections[key].pendingBet && !state.sections[key].pendingBet.isVirtual
  );

  if (activeSectionKey) {
    showSignalBanner(activeSectionKey);
    return;
  }

  const banner = document.getElementById('signal-banner');
  banner.classList.add('hidden');
  document.getElementById('app-header').style.paddingTop = '';
}

// ============ IN-CARD TRADE BANNER ============

function renderTradeBanner(key) {
  const section = state.sections[key];
  const banner = document.getElementById(`trade-banner-${key}`);
  if (!banner) return;

  const colorEl = document.getElementById(`trade-banner-color-${key}`);
  const periodEl = document.getElementById(`trade-banner-period-${key}`);

  if (section.pendingBet) {
    const betColor = section.pendingBet.color;
    const betColorLabel = colorName(betColor);
    const periodStr = formatPeriod(section.pendingBet.period);
    const isGreen = betColor === 'G';
    const strategy = state.selectedStrategy || 'SNIPER_3_LOSS_RGRG';

    if (strategy === 'RECOVERY_3_CHANCE') {
      const attemptNum = section.recoveryAttempt + 1;
      const attemptLabel = attemptNum === 1 ? '🎯' : attemptNum === 2 ? '🔄 Recovery #2 —' : '⚠️ LAST CHANCE —';
      colorEl.textContent = `${attemptLabel} ${betColorLabel} pe lagao!`;
    } else if (strategy === 'STREAK_5_CONTINUE') {
      const betAmt = STREAK5_CONFIG.BET_LADDER[section.streak5Level || 0];
      colorEl.textContent = `🔥 ${betColorLabel} pe lagao! (₹${betAmt} Lv${(section.streak5Level || 0) + 1})`;
    } else if (strategy === 'RGRG_LOCK_RESET') {
      const betLabel = section.liveRecovery ? '🔄 Recovery' : '🎯 LIVE';
      colorEl.textContent = `${betLabel}: ${betColorLabel} pe lagao!`;
    } else if (strategy === 'RGR_GRG_3' || strategy === 'CONTRARIAN_DOUBLE') {
      const vt = getVirtualLossTarget(strategy);
      colorEl.textContent = `🎯 ${vt + 1}th BET: ${betColorLabel} pe lagao!`;
    } else {
      colorEl.textContent = `🎯 ${betColorLabel} pe lagao!`;
    }
    colorEl.className = `trade-banner-color ${isGreen ? 'banner-green' : 'banner-red'}`;
    periodEl.textContent = `Period #${periodStr}`;

    banner.classList.remove('hidden', 'banner-mode-green', 'banner-mode-red');
    banner.classList.add(isGreen ? 'banner-mode-green' : 'banner-mode-red');
  } else {
    banner.classList.add('hidden');
    banner.classList.remove('banner-mode-green', 'banner-mode-red');
  }
}

// ============ TOAST NOTIFICATIONS ============

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast toast-${type} show`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// ============ REFRESH PROGRESS BAR ============

function startRefreshProgress() {
  state.refreshProgress = 0;
  const bar = document.getElementById('refresh-bar');
  bar.style.width = '0%';

  clearInterval(state.progressTimer);
  state.progressTimer = setInterval(() => {
    state.refreshProgress += (1000 / CONFIG.REFRESH_INTERVAL) * 100;
    if (state.refreshProgress > 100) state.refreshProgress = 100;
    bar.style.width = `${state.refreshProgress}%`;
  }, 1000);
}

// ============ SMART 3-MIN BOUNDARY SYNC ============

/**
 * Calculate milliseconds until the next 3-minute boundary from midnight.
 * Periods start at 00:00:00 and repeat every 3 minutes:
 *   00:00, 00:03, 00:06, 00:09, ... 23:57
 */
function getMsUntilNextBoundary() {
  const now = new Date();
  const midnightMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const elapsedMs = now.getTime() - midnightMs;
  const periodMs = CONFIG.PERIOD_DURATION_MS; // 180000 (3 min)
  const currentPeriodStart = Math.floor(elapsedMs / periodMs) * periodMs;
  const nextBoundary = currentPeriodStart + periodMs;
  const msUntil = nextBoundary - elapsedMs;
  return Math.max(msUntil, 50); // minimum 50ms to avoid tight loops
}

/**
 * Get remaining seconds until next 3-minute boundary.
 */
function getSecondsUntilNextBoundary() {
  return Math.ceil(getMsUntilNextBoundary() / 1000);
}

/**
 * Schedule a precision fetch right at the next 3-minute boundary,
 * plus follow-up fetches at +3s and +8s (API may be slightly delayed).
 */
function scheduleNextBoundaryFetch() {
  // Clear any existing timers
  clearTimeout(state.nextBoundaryTimer);
  clearTimeout(state.boundaryFollowUp1);
  clearTimeout(state.boundaryFollowUp2);

  const msUntil = getMsUntilNextBoundary();

  state.nextBoundaryTimer = setTimeout(async () => {
    state.lastBoundaryFetch = Date.now();
    addLog('⏰ 3-min boundary hit! Fetching new color...', 'info');
    await refresh();

    // Follow-up fetch at +3 seconds (API might update slightly late)
    state.boundaryFollowUp1 = setTimeout(async () => {
      await refresh();
    }, 3000);

    // Follow-up fetch at +8 seconds (catch slower updates)
    state.boundaryFollowUp2 = setTimeout(async () => {
      await refresh();
    }, 8000);

    // Schedule the NEXT boundary
    scheduleNextBoundaryFetch();
  }, msUntil);
}

/**
 * Start the live countdown timer that updates every second.
 */
function startCountdownTimer() {
  clearInterval(state.countdownInterval);

  function updateCountdown() {
    const secondsLeft = getSecondsUntilNextBoundary();
    const min = Math.floor(secondsLeft / 60);
    const sec = secondsLeft % 60;
    const display = `${min}:${String(sec).padStart(2, '0')}`;

    // Update countdown elements
    const countdownEl = document.getElementById('next-color-countdown');
    if (countdownEl) {
      countdownEl.textContent = display;

      // Visual urgency: change color when < 10 seconds
      if (secondsLeft <= 10) {
        countdownEl.classList.add('countdown-urgent');
      } else if (secondsLeft <= 30) {
        countdownEl.classList.add('countdown-soon');
        countdownEl.classList.remove('countdown-urgent');
      } else {
        countdownEl.classList.remove('countdown-urgent', 'countdown-soon');
      }
    }

    // Update the progress bar to match the 3-minute cycle
    const bar = document.getElementById('refresh-bar');
    if (bar) {
      const totalSeconds = CONFIG.PERIOD_DURATION_MS / 1000; // 180
      const elapsed = totalSeconds - secondsLeft;
      const pct = (elapsed / totalSeconds) * 100;
      bar.style.width = `${Math.min(pct, 100)}%`;
    }
  }

  updateCountdown(); // run immediately
  state.countdownInterval = setInterval(updateCountdown, 1000);
}

// ============ MAIN LOOP ============

async function refresh() {
  try {
    const allData = await fetchAllSections();

    for (const [key, data] of Object.entries(allData)) {
      processNewData(key, data);
    }

    renderAll();

  } catch (err) {
    console.error('Refresh error:', err);
    addLog(`⚠️ Refresh failed: ${err.message}`, 'info');
    showToast('⚠️ Data fetch failed, retrying...', 'error');
  }
}

async function initialize() {
  addLog('🚀 Dashboard initializing...', 'info');

  // Initialize IndexedDB color storage
  const dbReady = await colorDB.init();
  if (dbReady) {
    addLog('🗄️ Color database ready', 'info');
    colorDB.initStatusUI();
  } else {
    addLog('⚠️ Color database unavailable — data won\'t persist', 'info');
  }

  try {
    await refresh();

    state.initialized = true;
    state.isInitialLoad = false;  // Now popups can show for live signals

    // Hide loading overlay
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.style.display = 'none', 500);

    addLog('✅ Dashboard ready! Monitoring all 4 sections.', 'info');
    showToast('Dashboard ready!', 'success');

    // Start smart 3-minute boundary sync (precision fetch at period boundaries)
    scheduleNextBoundaryFetch();

    // Start live countdown timer (updates every second)
    startCountdownTimer();

    // Safety-net background poll (catches anything the boundary sync might miss)
    state.refreshTimer = setInterval(refresh, CONFIG.REFRESH_INTERVAL);

    addLog(`⏰ Smart sync started. Next color in ${getSecondsUntilNextBoundary()}s`, 'info');

  } catch (err) {
    console.error('Initialization error:', err);
    addLog(`❌ Init failed: ${err.message}`, 'info');
    showToast('Failed to load data. Retrying in 10s...', 'error');

    // Retry after 10 seconds
    setTimeout(initialize, 10000);
  }
}

// ============ START ============

// Initialize audio context and request notification permission on first user interaction
document.addEventListener('click', () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  requestNotificationPermission();
}, { once: true });

// Start the app
document.addEventListener('DOMContentLoaded', () => {
  // Restore disabled sections
  const rawDisabled = localStorage.getItem('wingo-disabled-sections');
  if (rawDisabled) {
    try {
      const disabledMap = JSON.parse(rawDisabled);
      for (const key of Object.keys(state.sections)) {
        const savedDisabled = disabledMap[key];
        if (savedDisabled) {
          const wasProfitLocked = typeof savedDisabled === 'object' && savedDisabled.reason === 'profit';
          if (wasProfitLocked) {
            // Don't restore profit-locked state — sections should stay active now
            state.sections[key].disabled = false;
            state.sections[key].profitLocked = false;
          } else {
            // Manual pause — respect it
            state.sections[key].disabled = true;
            state.sections[key].profitLocked = false;
          }
        }
      }
      // Clear stale profit locks from storage
      persistDisabledSections();
    } catch (e) {
      console.error('Failed to restore disabled sections:', e);
    }
  }

  restoreFreshSignalState();
  restoreRgrgLockState();
  
  // Set strategy select element
  const selectEl = document.getElementById('strategy-select');
  if (selectEl) {
    selectEl.value = state.selectedStrategy;
  }

  // Set toggle switches
  for (const key of Object.keys(state.sections)) {
    const toggleEl = document.getElementById(`toggle-${key}`);
    if (toggleEl) {
      toggleEl.checked = !state.sections[key].disabled;
    }
  }

  initialize();
  updateNotificationStatus();
});

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then(reg => {
        console.log('Service Worker registered successfully!', reg.scope);
      })
      .catch(err => {
        console.error('Service Worker registration failed:', err);
      });
  });
}
