/* Regenerate the symbol-only logo + favicons from the original badge art.
   Instead of a rectangular crop (which clipped the antlers/moon and left text),
   this labels the artwork's connected color regions and keeps only the ones we
   want -- the rainbow stag, the crescent moon, and the three sparkle stars --
   dropping the arced "Y'ALLTERNATIVE" text, the "LIVING" text, and stray noise.
   Writes:
     assets/img/logo.png                (transparent symbol -- header logo)
     assets/img/favicon-32/192/512.png  (transparent -- browser tab icons)
     assets/img/apple-touch-icon.png    (paper background -- iOS renders
                                          transparent icons on black)
   Run: node scripts/make-logo.js */
const sharp = require('sharp');
const path = require('path');
const IMG = path.join(__dirname, '..', 'assets/img');

(async () => {
  const T = 236; // whiteness cutoff: min(r,g,b) >= T is background
  const { data, info } = await sharp(path.join(IMG, 'logo.jpg'))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const minc = (x, y) => { const i = (y * W + x) * C; return Math.min(data[i], data[i + 1], data[i + 2]); };
  const isSubj = (x, y) => minc(x, y) < T;

  // --- label connected components (8-connectivity) ---
  const label = new Int32Array(W * H);
  let next = 0; const comps = {};
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!isSubj(x, y) || label[y * W + x]) continue;
    next++; let cnt = 0, sx = 0, sy = 0; const st = [x, y]; label[y * W + x] = next;
    while (st.length) {
      const cy = st.pop(), cx = st.pop(); cnt++; sx += cx; sy += cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!label[ni] && isSubj(nx, ny)) { label[ni] = next; st.push(nx, ny); }
      }
    }
    comps[next] = { cnt, cx: sx / cnt, cy: sy / cnt };
  }

  // --- select the symbol: deer + moon + stars ---
  // Drop: 1-4px noise (cnt<150); the top arc text (centroid high, cy<95) and
  // bottom "LIVING" (cy>285); and the large detached "VE" glyph sitting to the
  // right of the deer (big + far-right: cnt>1000 && cx>300).
  const keep = new Set();
  for (const id in comps) {
    const c = comps[id];
    if (c.cnt >= 150 && c.cy >= 95 && c.cy <= 285 && !(c.cnt > 1000 && c.cx > 300)) keep.add(+id);
  }

  // --- build alpha (anti-aliased) + crop to the kept pixels' bounds ---
  let minx = W, miny = H, maxx = 0, maxy = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, i = p * C, mn = minc(x, y);
    const base = mn >= T ? 0 : (mn <= 222 ? 255 : Math.round((T - mn) / (T - 222) * 255));
    const a = keep.has(label[p]) ? base : 0;
    data[i + 3] = a;
    if (a > 0) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  }
  const cropW = maxx - minx + 1, cropH = maxy - miny + 1;
  const cut = await sharp(data, { raw: { width: W, height: H, channels: C } })
    .extract({ left: minx, top: miny, width: cropW, height: cropH }).png().toBuffer();

  // center on a padded square master
  const S = Math.round(Math.max(cropW, cropH) * 1.14);
  const master = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: cut, gravity: 'centre' }]).png().toBuffer();

  const out = async (size, file, bg) => {
    let base = sharp(master).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' });
    if (bg) base = sharp({ create: { width: size, height: size, channels: 4, background: bg } })
      .composite([{ input: await base.png().toBuffer() }]);
    await base.png().toFile(path.join(IMG, file));
    console.log('wrote', file, size + 'x' + size, bg ? '(bg)' : '(transparent)');
  };

  console.log('kept components:', [...keep].join(','), '| crop', cropW + 'x' + cropH, 'at', minx + ',' + miny);
  await out(512, 'logo.png');
  await out(512, 'favicon-512.png');
  await out(192, 'favicon-192.png');
  await out(32,  'favicon-32.png');
  await out(180, 'apple-touch-icon.png', { r: 250, g: 245, b: 234, alpha: 1 });
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
