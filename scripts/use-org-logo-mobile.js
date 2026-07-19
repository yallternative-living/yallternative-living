const fs = require('fs');
const path = require('path');

const htmlFiles = [
  'index.html', 'shop.html', 'about.html', 'events.html',
  'contact.html', '404.html', 'privacy.html', 'terms.html', 'policies.html'
];

htmlFiles.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (!fs.existsSync(filePath)) return;
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace the existing logo image with the two images
  content = content.replace(
    /<img src="assets\/img\/logo\.png" alt="Y'allternative Living logo" width="42" height="42">/g,
    `<img class="logo-desktop" src="assets/img/logo.png" alt="Y'allternative Living icon" width="48" height="48">
      <img class="logo-mobile" src="assets/img/logo.jpg" alt="Y'allternative Living logo" height="48">`
  );
  
  // Just in case it was 48x48 already in some files
  content = content.replace(
    /<img src="assets\/img\/logo\.png" alt="Y'allternative Living logo" width="48" height="48">/g,
    `<img class="logo-desktop" src="assets/img/logo.png" alt="Y'allternative Living icon" width="48" height="48">
      <img class="logo-mobile" src="assets/img/logo.jpg" alt="Y'allternative Living logo" height="48">`
  );
  
  fs.writeFileSync(filePath, content, 'utf8');
});

// Update CSS
const cssPath = path.join(__dirname, '..', 'assets', 'css', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

// We need to replace the `& img{...}` inside `.brand`
// and add the logic to hide `.brand-word` on mobile.

const oldImgRegex = /& img\{\s*width:48px; height:48px;\s*@media \(max-width: 420px\) \{\s*width:40px; height:40px;\s*\}\s*\}/;
const newImgCss = `& img.logo-desktop {
    width: 48px;
    height: 48px;
    border-radius: 50%;
  }
  
  & img.logo-mobile {
    display: none;
    width: auto;
    height: 48px;
    border-radius: 6px;
  }
  
  @media (max-width: 420px) {
    & img.logo-desktop { display: none; }
    & img.logo-mobile { display: block; height: 40px; }
  }`;

css = css.replace(oldImgRegex, newImgCss);

// Now find `.brand-word` media query to hide it entirely
// Right inside `.brand-word`, there's no overall display: none for mobile, but we can just append it inside.
// `.brand-word` starts at `& .brand-word{`
const brandWordStart = css.indexOf('& .brand-word{');
if (brandWordStart !== -1) {
  // we can just add the media query at the top of the block
  css = css.replace('& .brand-word{', '& .brand-word{\n    @media (max-width: 420px) { display: none !important; }');
}

fs.writeFileSync(cssPath, css, 'utf8');
console.log("Updated logo for mobile!");

