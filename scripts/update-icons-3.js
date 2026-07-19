const fs = require('fs');
const path = require('path');

const mainJsPath = path.join(__dirname, '..', 'assets', 'js', 'main.js');
let mainJs = fs.readFileSync(mainJsPath, 'utf8');

const xSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

// Replace &times; in wish drawer close
mainJs = mainJs.replace(/&times;/g, `<span style="display:flex;align-items:center;justify-content:center;">${xSvg}</span>`);

fs.writeFileSync(mainJsPath, mainJs, 'utf8');
console.log("Updated X icons");
