#!/usr/bin/env node
/**
 * OPTIMIZER V2: Find best strategy on NEW data (17,184 records)
 */
const fs = require('fs');
const WX = 0.96;

function loadData() {
  const paths = ['/Users/abhishek/Downloads/backtest_data.json', '/Users/abhishek/Desktop/backtest_data.json'];
  let raw;
  for (const p of paths) { try { raw = fs.readFileSync(p, 'utf8'); break; } catch(e) {} }
  const data = JSON.parse(raw);
  const byCategory = {};
  const f = data.recordFields;
  for (const rec of data.records) {
    const cat = rec[f.indexOf('category')];
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({ period: rec[f.indexOf('period')], is_green: rec[f.indexOf('isGreen')], color: rec[f.indexOf('color')] });
  }
  for (const c of Object.keys(byCategory)) byCategory[c].sort((a,b) => a.period - b.period);
  return { byCategory, meta: data };
}

function gc(p) { return (p.is_green || p.color === 'G') ? 'G' : 'R'; }
function alt(c) { for(let i=1;i<c.length;i++) if(c[i]===c[i-1]) return false; return true; }

function run(periods, vn, ladder, mb) {
  const ml = Math.floor(ladder.length / mb);
  let st='HUNT', vl=0, lv=0, cb=0, bet=null, ww=false;
  let pnl=0, w=0, l=0, wipes=0, pk=0, dd=0, mn=0;
  for (let i=0; i<periods.length; i++) {
    const cc=gc(periods[i]), pc=i>0?gc(periods[i-1]):null;
    if (bet && bet.idx===i) {
      const won = cc===bet.color;
      if (bet.v) { if(won){ww=false;vl=0;st='HUNT';}else{vl++;st='WB';} bet=null; continue; }
      const amt=bet.amt, p=won?amt*WX:-amt; pnl+=p;
      if(pnl>pk)pk=pnl; if(pnl<mn)mn=pnl; if(pk-pnl>dd)dd=pk-pnl;
      if(won){w++;vl=0;lv=0;cb=0;ww=false;st='HUNT';}
      else{l++;cb++;if(cb>=mb){cb=0;lv++;if(lv>=ml){wipes++;lv=0;}ww=true;vl=0;st='WB';}else st='WB';}
      bet=null; continue;
    }
    if(bet) continue;
    if(st==='WB'){if(pc&&cc===pc)st='HUNT';continue;}
    if(st==='HUNT'&&i>=3){
      const c4=[gc(periods[i-3]),gc(periods[i-2]),gc(periods[i-1]),cc];
      if(alt(c4)&&i+1<periods.length){
        if(ww) bet={color:cc,idx:i+1,v:true};
        else if(vl>=vn){const bn=cb>=1?cb+1:1;const li=lv*mb+cb;bet={color:cc,idx:i+1,v:false,amt:ladder[Math.min(li,ladder.length-1)]};}
        else bet={color:cc,idx:i+1,v:true};
      }
    }
  }
  return {pnl,w,l,t:w+l,wipes,dd,pk,mn};
}

function main() {
  const {byCategory, meta} = loadData();
  const cats = ['P','S','B','E'];
  const names = {P:'Parity',S:'Sapre',B:'Bcone',E:'Emerd'};

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  🔬 OPTIMIZER V2: Best Strategy on NEW Data (17,184 records, 9 days)             ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');

  // ═══ TEST 1: Flat ₹20 single bet ═══
  console.log('━━━ TEST 1: Flat ₹20 Single Bet ━━━');
  console.log('  ┌────────┬────────┬──────┬───────┬──────────┬────────────┐');
  console.log('  │ V-Loss │ Trades │ Wins │ Losses│ Win Rate │   Total P&L│');
  console.log('  ├────────┼────────┼──────┼───────┼──────────┼────────────┤');
  for (const vn of [2,3,4,5,6,7,8,9,10]) {
    let tp=0,tw=0,tl=0,tt=0;
    for (const c of cats){const r=run(byCategory[c],vn,[20],1);tp+=r.pnl;tw+=r.w;tl+=r.l;tt+=r.t;}
    const wr=tt>0?(tw/tt*100).toFixed(1):'0.0';
    const ps=(tp>=0?'+':'')+tp.toFixed(1);
    const ic=tp>0?'✅':'❌';
    console.log(`  │ ${String(vn).padStart(6)} │ ${String(tt).padStart(6)} │ ${String(tw).padStart(4)} │ ${String(tl).padStart(5)} │ ${(wr+'%').padStart(8)} │ ${(ic+'₹'+ps).padStart(12)} │`);
  }
  console.log('  └────────┴────────┴──────┴───────┴──────────┴────────────┘');

  // ═══ TEST 2: 2-bet (₹20/₹60) flat recovery ═══
  console.log('\n━━━ TEST 2: 2-Bet Recovery ₹20→₹60 ━━━');
  console.log('  ┌────────┬────────┬──────┬───────┬──────────┬────────────┐');
  console.log('  │ V-Loss │ Trades │ Wins │ Losses│ Win Rate │   Total P&L│');
  console.log('  ├────────┼────────┼──────┼───────┼──────────┼────────────┤');
  for (const vn of [2,3,4,5,6,7,8,9,10]) {
    let tp=0,tw=0,tl=0,tt=0;
    for (const c of cats){const r=run(byCategory[c],vn,[20,60],2);tp+=r.pnl;tw+=r.w;tl+=r.l;tt+=r.t;}
    const wr=tt>0?(tw/tt*100).toFixed(1):'0.0';
    const ps=(tp>=0?'+':'')+tp.toFixed(1);
    const ic=tp>0?'✅':'❌';
    console.log(`  │ ${String(vn).padStart(6)} │ ${String(tt).padStart(6)} │ ${String(tw).padStart(4)} │ ${String(tl).padStart(5)} │ ${(wr+'%').padStart(8)} │ ${(ic+'₹'+ps).padStart(12)} │`);
  }
  console.log('  └────────┴────────┴──────┴───────┴──────────┴────────────┘');

  // ═══ TEST 3: 2-bet Martingale (₹20/60 → ₹150/350) ═══
  console.log('\n━━━ TEST 3: 2+2 Martingale ₹20/60→₹150/350 ━━━');
  console.log('  ┌────────┬────────┬──────┬───────┬──────────┬──────────┬────────────┐');
  console.log('  │ V-Loss │ Trades │ Wins │ Losses│ Win Rate │ Wipeouts │   Total P&L│');
  console.log('  ├────────┼────────┼──────┼───────┼──────────┼──────────┼────────────┤');
  for (const vn of [2,3,4,5,6,7,8,9,10]) {
    let tp=0,tw=0,tl=0,tt=0,twp=0;
    for (const c of cats){const r=run(byCategory[c],vn,[20,60,150,350],2);tp+=r.pnl;tw+=r.w;tl+=r.l;tt+=r.t;twp+=r.wipes;}
    const wr=tt>0?(tw/tt*100).toFixed(1):'0.0';
    const ps=(tp>=0?'+':'')+tp.toFixed(1);
    const ic=tp>0?'✅':'❌';
    console.log(`  │ ${String(vn).padStart(6)} │ ${String(tt).padStart(6)} │ ${String(tw).padStart(4)} │ ${String(tl).padStart(5)} │ ${(wr+'%').padStart(8)} │ ${String(twp).padStart(8)} │ ${(ic+'₹'+ps).padStart(12)} │`);
  }
  console.log('  └────────┴────────┴──────┴───────┴──────────┴──────────┴────────────┘');

  // ═══ TEST 4: 3-bet per level (₹20/60/150) single level ═══
  console.log('\n━━━ TEST 4: 3-Bet Single Level ₹20→₹60→₹150 ━━━');
  console.log('  ┌────────┬────────┬──────┬───────┬──────────┬────────────┐');
  console.log('  │ V-Loss │ Trades │ Wins │ Losses│ Win Rate │   Total P&L│');
  console.log('  ├────────┼────────┼──────┼───────┼──────────┼────────────┤');
  for (const vn of [2,3,4,5,6,7,8,9,10]) {
    let tp=0,tw=0,tl=0,tt=0;
    for (const c of cats){const r=run(byCategory[c],vn,[20,60,150],3);tp+=r.pnl;tw+=r.w;tl+=r.l;tt+=r.t;}
    const wr=tt>0?(tw/tt*100).toFixed(1):'0.0';
    const ps=(tp>=0?'+':'')+tp.toFixed(1);
    const ic=tp>0?'✅':'❌';
    console.log(`  │ ${String(vn).padStart(6)} │ ${String(tt).padStart(6)} │ ${String(tw).padStart(4)} │ ${String(tl).padStart(5)} │ ${(wr+'%').padStart(8)} │ ${(ic+'₹'+ps).padStart(12)} │`);
  }
  console.log('  └────────┴────────┴──────┴───────┴──────────┴────────────┘');

  // ═══ TEST 5: Per-section (flat ₹20) ═══
  console.log('\n━━━ TEST 5: Per-Section Analysis (Flat ₹20) ━━━');
  for (const c of cats) {
    console.log(`\n  📌 ${names[c]}:`);
    console.log('  ┌────────┬────────┬──────┬───────┬──────────┬────────────┐');
    console.log('  │ V-Loss │ Trades │ Wins │ Losses│ Win Rate │    P&L     │');
    console.log('  ├────────┼────────┼──────┼───────┼──────────┼────────────┤');
    let best=-Infinity,bv=0;
    for (const vn of [2,3,4,5,6,7,8,9,10]) {
      const r=run(byCategory[c],vn,[20],1);
      const wr=r.t>0?(r.w/r.t*100).toFixed(1):'0.0';
      const ps=(r.pnl>=0?'+':'')+r.pnl.toFixed(1);
      const ic=r.pnl>0?'✅':r.pnl===0?'⚖️':'❌';
      console.log(`  │ ${String(vn).padStart(6)} │ ${String(r.t).padStart(6)} │ ${String(r.w).padStart(4)} │ ${String(r.l).padStart(5)} │ ${(wr+'%').padStart(8)} │ ${(ic+'₹'+ps).padStart(12)} │`);
      if(r.pnl>best){best=r.pnl;bv=vn;}
    }
    console.log('  └────────┴────────┴──────┴───────┴──────────┴────────────┘');
    console.log(`  → Best: ${bv} v-losses (P&L: ${best>=0?'+':''}₹${best.toFixed(1)})`);
  }

  // ═══ TEST 6: Only profitable sections (B+E, B only) ═══
  console.log('\n━━━ TEST 6: Section Combos — 2-Bet ₹20/60 ━━━');
  const combos = [
    {name: 'All (P+S+B+E)', cats: ['P','S','B','E']},
    {name: 'B + E only', cats: ['B','E']},
    {name: 'B only', cats: ['B']},
    {name: 'P + B', cats: ['P','B']},
    {name: 'B + S', cats: ['B','S']},
  ];
  console.log('  ┌──────────────────┬────────┬────────┬──────────┬────────────┐');
  console.log('  │ Sections         │ V-Loss │ Trades │ Win Rate │   Best P&L │');
  console.log('  ├──────────────────┼────────┼────────┼──────────┼────────────┤');
  for (const combo of combos) {
    let bestP=-Infinity,bestV=0,bestT=0,bestWR='0.0';
    for (const vn of [2,3,4,5,6,7,8,9,10]) {
      let tp=0,tw=0,tl=0,tt=0;
      for(const c of combo.cats){const r=run(byCategory[c],vn,[20,60],2);tp+=r.pnl;tw+=r.w;tl+=r.l;tt+=r.t;}
      if(tp>bestP){bestP=tp;bestV=vn;bestT=tt;bestWR=tt>0?(tw/tt*100).toFixed(1):'0.0';}
    }
    const ps=(bestP>=0?'+':'')+bestP.toFixed(1);
    const ic=bestP>0?'✅':'❌';
    console.log(`  │ ${combo.name.padEnd(16)} │ ${String(bestV).padStart(6)} │ ${String(bestT).padStart(6)} │ ${(bestWR+'%').padStart(8)} │ ${(ic+'₹'+ps).padStart(12)} │`);
  }
  console.log('  └──────────────────┴────────┴────────┴──────────┴────────────┘');

  // ═══ TEST 7: Different ladders at v=3 ═══
  console.log('\n━━━ TEST 7: Different Ladders (all sections, best v-loss each) ━━━');
  const ladders = [
    {name:'₹10 flat', l:[10], mb:1},
    {name:'₹20 flat', l:[20], mb:1},
    {name:'₹20,₹60 (2-bet)', l:[20,60], mb:2},
    {name:'₹20,₹60,₹150 (3-bet)', l:[20,60,150], mb:3},
    {name:'₹10,₹30 → ₹90,₹270', l:[10,30,90,270], mb:2},
    {name:'₹20,₹60 → ₹150,₹350', l:[20,60,150,350], mb:2},
    {name:'₹20,₹60 → ₹180,₹540', l:[20,60,180,540], mb:2},
    {name:'₹10,₹30,₹90 (3-bet)', l:[10,30,90], mb:3},
    {name:'₹20,₹40,₹80 (3-bet)', l:[20,40,80], mb:3},
  ];
  console.log('  ┌──────────────────────────────┬────────┬────────┬──────────┬──────────┬────────────┐');
  console.log('  │ Ladder                       │ V-Loss │ Trades │ Win Rate │ Wipeouts │   Best P&L │');
  console.log('  ├──────────────────────────────┼────────┼────────┼──────────┼──────────┼────────────┤');
  for (const cfg of ladders) {
    let bestP=-Infinity,bestV=0,bestT=0,bestWR='0.0',bestWP=0;
    for (const vn of [2,3,4,5,6,7,8,9,10]) {
      let tp=0,tw=0,tl=0,tt=0,twp=0;
      for(const c of cats){const r=run(byCategory[c],vn,cfg.l,cfg.mb);tp+=r.pnl;tw+=r.w;tl+=r.l;tt+=r.t;twp+=r.wipes;}
      if(tp>bestP){bestP=tp;bestV=vn;bestT=tt;bestWR=tt>0?(tw/tt*100).toFixed(1):'0.0';bestWP=twp;}
    }
    const ps=(bestP>=0?'+':'')+bestP.toFixed(1);
    const ic=bestP>0?'✅':'❌';
    const risk = cfg.l.reduce((a,b)=>a+b,0);
    console.log(`  │ ${cfg.name.padEnd(28)} │ ${String(bestV).padStart(6)} │ ${String(bestT).padStart(6)} │ ${(bestWR+'%').padStart(8)} │ ${String(bestWP).padStart(8)} │ ${(ic+'₹'+ps).padStart(12)} │`);
  }
  console.log('  └──────────────────────────────┴────────┴────────┴──────────┴──────────┴────────────┘');

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════════════');
  console.log('');
}
main();
