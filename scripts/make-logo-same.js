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
  
  // Replace the HTML
  const regex = /<span class="brand-word">Y'allternative <span class="brand-sub">Living<\/span><\/span>/g;
  const newHTML = `<span class="brand-word">Y'allternative Living</span>`;
  
  content = content.replace(regex, newHTML);
  fs.writeFileSync(filePath, content, 'utf8');
});
console.log("HTML updated to same styling");
