/* One-off: generate the 1200x630 social-share (Open Graph) image.
   Branded, typographic, on-palette. Rasterized from SVG via sharp.
   Output: assets/img/og-image.jpg   (run: node scripts/make-og-image.js) */
const sharp = require('sharp');
const path = require('path');

const W = 1200, H = 630;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#3a2436"/>
      <stop offset="55%" stop-color="#211a15"/>
      <stop offset="100%" stop-color="#17130f"/>
    </radialGradient>
    <linearGradient id="pride" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#e0505a"/><stop offset="20%" stop-color="#e8935a"/>
      <stop offset="40%" stop-color="#e8c65a"/><stop offset="60%" stop-color="#5fae7a"/>
      <stop offset="80%" stop-color="#4f8fc7"/><stop offset="100%" stop-color="#9a6bc9"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="24" y="24" width="${W-48}" height="${H-48}" rx="18" fill="none" stroke="#8a5c30" stroke-width="2"/>

  <!-- crescent moon + spark -->
  <g transform="translate(600 132)">
    <circle cx="0" cy="0" r="34" fill="#d69b5c"/>
    <circle cx="13" cy="-6" r="30" fill="#211a15"/>
    <path d="M74 -20 l4 12 12 4 -12 4 -4 12 -4 -12 -12 -4 12 -4 z" fill="#c65a6d"/>
    <path d="M-82 6 l3 9 9 3 -9 3 -3 9 -3 -9 -9 -3 9 -3 z" fill="#7c8f6e"/>
  </g>

  <text x="600" y="322" text-anchor="middle" font-family="DejaVu Serif" font-weight="bold" font-size="92" fill="#f3ead9">Y&#8217;allternative Living</text>

  <rect x="450" y="356" width="300" height="6" rx="3" fill="url(#pride)"/>

  <text x="600" y="430" text-anchor="middle" font-family="DejaVu Sans" font-size="33" fill="#cfc0a8">Handmade self-care for the black sheep &amp; bold hearts</text>

  <text x="600" y="524" text-anchor="middle" font-family="DejaVu Sans" font-size="25" letter-spacing="3" fill="#d69b5c">QUEER-OWNED  &#183;  SOUTHERN-RAISED  &#183;  LANDRUM, SC</text>
</svg>`;

sharp(Buffer.from(svg))
  .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
  .toFile(path.join(__dirname, '..', 'assets/img/og-image.jpg'))
  .then(info => console.log('wrote assets/img/og-image.jpg', info.width + 'x' + info.height, info.size + ' bytes'))
  .catch(e => { console.error('FAILED', e.message); process.exit(1); });
