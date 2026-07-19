const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'shop.html');
let content = fs.readFileSync(filePath, 'utf8');

const starSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" class="icon-star"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

const newTrustBadge = `<div class="hero-badge" style="justify-content:center;margin-top:1.5rem;">
          <span class="stars" aria-hidden="true" style="display:inline-flex;gap:2px;">
            ${starSvg.repeat(5)}
          </span>
          <div>
            <b>4.9 out of 5</b>
            <span>32 Etsy reviews · 105+ sales</span>
          </div>
        </div>`;

content = content.replace(/<p class="shop-trust">.*?<\/p>/, newTrustBadge);

fs.writeFileSync(filePath, content, 'utf8');
console.log("Updated shop trust badge");
