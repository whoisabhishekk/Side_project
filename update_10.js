const fs = require('fs');

let appJs = fs.readFileSync('app.js', 'utf8');
appJs = appJs.replace('const VIRTUAL_LOSS_TARGET = 4;', 'const VIRTUAL_LOSS_TARGET = 10;');
appJs = appJs.replace('const VIRTUAL_LOSS_DOTS_MAX = 4;', 'const VIRTUAL_LOSS_DOTS_MAX = 10;');
fs.writeFileSync('app.js', appJs);

let html = fs.readFileSync('index.html', 'utf8');
html = html.replace('🏆 Sniper 4-Loss + RGRG', '🏆 Sniper 10-Loss + RGRG');
html = html.replace('🏆 Sniper 4-Loss + RGRG (Old Strategy)', '🏆 Sniper 10-Loss + RGRG');
fs.writeFileSync('index.html', html);
console.log("Updated to 10!");
