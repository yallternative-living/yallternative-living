const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'contact.html');
let content = fs.readFileSync(filePath, 'utf8');

// We will replace everything from <!-- CONTACT CARDS --> down to <!-- FAQ --
const regex = /<!-- CONTACT CARDS -->[\s\S]*?(?=<!-- FAQ --)/;

const newContactSection = `<!-- CONTACT SPLIT LAYOUT -->
  <section class="section-tight">
    <div class="container two-col" style="align-items: flex-start; gap: 64px;">
      
      <!-- LEFT: Form -->
      <div class="reveal" style="width:100%; max-width:600px;">
        <h2 style="margin-bottom:8px;">Send a Message</h2>
        <p style="margin-bottom:32px; color:var(--ink-4);">Use the form below for custom orders, wholesale inquiries, or support. We typically respond within 24-48 hours.</p>
        
        <form action="https://formspree.io/f/YOUR_FORM_ID" method="POST" class="contact-form">
          <div class="field">
            <label for="name">Name</label>
            <input type="text" id="name" name="name" required>
          </div>
          <div class="field">
            <label for="email">Email</label>
            <input type="email" id="email" name="_replyto" required>
          </div>
          <div class="field">
            <label for="message">Message</label>
            <textarea id="message" name="message" rows="5" required></textarea>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Send Message</button>
        </form>
      </div>

      <!-- RIGHT: Info -->
      <div class="reveal">
        <span class="eyebrow">Other Ways to Reach Us</span>
        <h2 style="margin-bottom:24px;">Direct & Socials</h2>
        
        <div style="margin-bottom:32px;">
          <h3 style="font-size:1.1rem; margin-bottom:8px; font-weight:600;">Email</h3>
          <p><a href="mailto:y.allternative.living@gmail.com" style="color:var(--whiskey); text-decoration:underline;">y.allternative.living@gmail.com</a></p>
        </div>

        <div style="margin-bottom:48px;">
          <h3 style="font-size:1.1rem; margin-bottom:12px; font-weight:600;">Social Media</h3>
          <div class="contact-btn-row">
            <a class="btn btn-outline btn-sm" href="https://www.instagram.com/yallternativeliving" target="_blank" rel="noopener">Instagram ↗</a>
            <a class="btn btn-outline btn-sm" href="https://www.tiktok.com/@yallternativeliving" target="_blank" rel="noopener">TikTok ↗</a>
          </div>
        </div>

        <span class="eyebrow">In The Wild</span>
        <h2 style="margin-bottom:16px;">Find Us In Person</h2>
        <div class="img-frame" style="margin-bottom:24px;">
          <picture>
            <source type="image/webp" srcset="assets/img/backroad-soak-480.webp 480w, assets/img/backroad-soak-800.webp 800w, assets/img/backroad-soak.webp 1053w" sizes="(max-width: 880px) 90vw, 44vw">
            <img src="assets/img/backroad-soak.jpg" alt="Y'allternative Living soak product out on a backroad tailgate" width="600" height="798" loading="lazy" decoding="async" style="height:240px; object-fit:cover; width:100%;">
          </picture>
        </div>
        <p>We're based in Landrum, SC, tucked in the Upstate. You'll find us somewhere between a farmers market and a Pride event across the Upstate and beyond.</p>
        <p>Follow <strong>@yallternativeliving</strong> on socials for our latest market dates.</p>
      </div>

    </div>
  </section>
  
  `;

content = content.replace(regex, newContactSection);

fs.writeFileSync(filePath, content, 'utf8');
console.log("Updated contact layout");
