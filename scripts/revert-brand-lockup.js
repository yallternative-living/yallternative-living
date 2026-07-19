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
  
  // Replace the stacked structure with a single line
  const oldHTML = `<span class="brand-word">
        <span class="brand-pun"><strong>Y'all</strong>ternative</span>
        <small>Living</small>
      </span>`;
  const newHTML = `<span class="brand-word">Y'allternative<small>Living</small></span>`;
  
  // It might have spaces or newlines, so let's use a regex
  const regex = /<span class="brand-word">\s*<span class="brand-pun"><strong>Y'all<\/strong>ternative<\/span>\s*<small>Living<\/small>\s*<\/span>/g;
  
  content = content.replace(regex, newHTML);
  fs.writeFileSync(filePath, content, 'utf8');
});
console.log("HTML reverted");
