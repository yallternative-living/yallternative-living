const fs = require('fs');
const path = require('path');

const htmlFiles = [
  'index.html', 'shop.html', 'about.html', 'events.html',
  'contact.html', '404.html', 'privacy.html', 'terms.html', 'policies.html'
];

const newBrandWord = `<span class="brand-word">
        <span class="brand-pun"><strong>Y'all</strong>ternative</span>
        <small>Living</small>
      </span>`;

htmlFiles.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) return;
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // The current HTML has <span class="brand-word">Y'allternative<small>Living</small></span>
  content = content.replace(/<span class="brand-word">Y'allternative<small>Living<\/small><\/span>/g, newBrandWord);
  
  fs.writeFileSync(filePath, content, 'utf8');
});

// Update CSS
const cssPath = path.join(__dirname, '..', 'assets', 'css', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

// The CSS currently has `.brand` with `.hero-word` inside it. We need to replace `.hero-word` with `.brand-word` 
// and update its internal styling completely to match the new structure.

const oldCssRegex = /& \.hero-word\{[\s\S]*?\}\s*\}/;

const newCss = `& .brand-word{
    display:flex; flex-direction:column; justify-content:center;
    line-height:1;
    
    & .brand-pun {
      font-family: var(--font-display);
      font-size:1.45rem;
      letter-spacing:.01em;
      color: var(--ink);
      font-weight: 400; /* Lighter weight for 'ternative' */
      
      & strong {
        font-weight: 700;
        color: var(--whiskey); /* Highlights the Y'all pun! */
      }
      
      @media (max-width: 420px) {
        font-size:1.25rem;
      }
    }
    
    & small{
      display:block;
      font-family: var(--font-body);
      font-weight: 600;
      font-size: 0.6rem;
      letter-spacing: 0.35em;
      text-transform: uppercase;
      color: var(--ink-3);
      margin-top: 3px;
      margin-left: 2px;
      
      @media (max-width: 420px) {
        font-size: 0.55rem;
      }
    }
  }`;

css = css.replace(oldCssRegex, newCss);

// Also check if .hero-word existed without the `&`
css = css.replace(/\.hero-word/g, '.brand-word');

fs.writeFileSync(cssPath, css, 'utf8');

console.log("Updated brand lockup in all files!");

