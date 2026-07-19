const fs = require('fs');
const path = require('path');

const htmlFiles = [
  'index.html', 'shop.html', 'about.html', 'events.html',
  'contact.html', '404.html', 'privacy.html', 'terms.html', 'policies.html'
];

const moonSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
const sunSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const menuSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-menu"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>`;
const cartSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="icon-cart"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>`;
const starSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" class="icon-star"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const starRow = starSvg.repeat(5);

const checkSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-check"><polyline points="20 6 9 17 4 12"/></svg>`;

htmlFiles.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) return;
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace Theme Knob
  content = content.replace(/<span class="knob" aria-hidden="true">🌙<\/span>/g, `<span class="knob" aria-hidden="true">${moonSvg}</span>`);
  
  // Replace Nav Toggle
  content = content.replace(/<button type="button" class="nav-toggle"[^>]*>☰<\/button>/g, `<button type="button" class="nav-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="navLinks">\n        ${menuSvg}\n      </button>`);
  
  // Replace Cart SVG
  content = content.replace(/<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="21" r="1"\/><circle cx="19" cy="21" r="1"\/><path d="M2.5 3h2l2.6 12.6a2 2 0 0 0 2 1.6h8.4a2 2 0 0 0 2-1.6L21 8H6"\/><\/svg>/g, cartSvg);

  // Replace Stars
  content = content.replace(/<span class="stars" aria-hidden="true">★★★★★<\/span>/g, `<span class="stars" aria-hidden="true" style="display:inline-flex;gap:2px;">${starRow}</span>`);

  // Footer Check
  content = content.replace(/<span class="glyph" aria-hidden="true">&#10003;<\/span>/g, `<span class="glyph" aria-hidden="true" style="display:inline-flex;vertical-align:text-bottom;">${checkSvg}</span>`);
  
  // Value strip glyphs (only in index.html)
  if (file === 'index.html') {
    content = content.replace(/<span class="glyph" aria-hidden="true">✦<\/span>/g, `<span class="glyph" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg></span>`);
    content = content.replace(/<span class="glyph" aria-hidden="true">♡<\/span>/g, `<span class="glyph" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg></span>`);
    content = content.replace(/<span class="glyph" aria-hidden="true">✶<\/span>/g, `<span class="glyph" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg></span>`);
    content = content.replace(/<span class="glyph" aria-hidden="true">⟡<\/span>/g, `<span class="glyph" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg></span>`);
  }
  
  fs.writeFileSync(filePath, content, 'utf8');
});

// Update main.js
const mainJsPath = path.join(__dirname, '..', 'assets', 'js', 'main.js');
let mainJs = fs.readFileSync(mainJsPath, 'utf8');

// The theme toggle SVG needs to swap. In JS:
// We can just rely on CSS to change the SVG! 
// Wait, CSS can't easily swap SVGs unless they are embedded and we use display:none.
// Or we can just let JS swap the innerHTML of .knob.

// Menu toggle text replacement
mainJs = mainJs.replace(/navToggle\.textContent = "☰";/g, 'navToggle.innerHTML = `'+menuSvg+'`;');
mainJs = mainJs.replace(/navToggle\.textContent = open \? "✕" : "☰";/g, 'navToggle.innerHTML = open ? `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>` : `'+menuSvg+'`;');

// Wish Heart
mainJs = mainJs.replace(/var wishHeartSVG =[^;]+;/s, 'var wishHeartSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="icon-heart-nav"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`;');

// Wish body empty glyph
mainJs = mainJs.replace(/<span class="glyph" aria-hidden="true">♡<\/span>/g, `<span class="glyph" aria-hidden="true" style="display:inline-flex;margin-right:8px;"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg></span>`);

fs.writeFileSync(mainJsPath, mainJs, 'utf8');

console.log("Replaced icons in HTML files and main.js");

