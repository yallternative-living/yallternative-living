const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '..', 'assets', 'css', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

let openCount = 0;
let closeCount = 0;
for (let i = 0; i < css.length; i++) {
  if (css[i] === '{') openCount++;
  if (css[i] === '}') closeCount++;
}

console.log("Open:", openCount, "Close:", closeCount);
