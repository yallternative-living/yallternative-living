const fs = require('fs');
const path = require('path');

const htmlFiles = [
  'index.html', 'shop.html', 'about.html', 'events.html',
  'contact.html', '404.html', 'privacy.html', 'terms.html', 'policies.html'
];

const moonSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
const sunSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;

htmlFiles.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) return;
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Update Theme Knob to contain both, we will toggle in CSS
  content = content.replace(
    new RegExp(`<span class="knob" aria-hidden="true">` + escapeRegExp(moonSvg) + `<\/span>`, 'g'),
    `<span class="knob" aria-hidden="true">${moonSvg}${sunSvg}</span>`
  );
  
  fs.writeFileSync(filePath, content, 'utf8');
});

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// Update CSS
const cssPath = path.join(__dirname, '..', 'assets', 'css', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

css += `
/* Icon visibility for theme toggle */
.theme-toggle .icon-sun { display: none; }
:root[data-theme="light"] .theme-toggle .icon-moon { display: none; }
:root[data-theme="light"] .theme-toggle .icon-sun { display: block; }
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]):not([data-theme="light"]) .theme-toggle .icon-moon { display: none; }
  :root:not([data-theme="dark"]):not([data-theme="light"]) .theme-toggle .icon-sun { display: block; }
}

/* Adjust star container vertically */
.stars { display: inline-flex; gap: 2px; align-items: center; }
`;

fs.writeFileSync(cssPath, css, 'utf8');

console.log("Updated icons step 2");
