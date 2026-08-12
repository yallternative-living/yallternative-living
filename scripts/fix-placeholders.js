const fs = require("fs");
const htmlFiles = fs.readdirSync(".").filter((f) => f.endsWith(".html"));

htmlFiles.forEach((file) => {
  let content = fs.readFileSync(file, "utf8");
  let changed = false;

  if (content.includes('action="YOUR_KIT_FORM_ACTION_URL"')) {
    content = content.replace(
      'action="YOUR_KIT_FORM_ACTION_URL"',
      'action="<!--YL:site.kitFormAction-->YOUR_KIT_FORM_ACTION_URL<!--/YL:site.kitFormAction-->"'
    );
    changed = true;
  }

  if (content.includes('action="https://formspree.io/f/YOUR_FORMSPREE_FORM_ID"')) {
    content = content.replace(
      'action="https://formspree.io/f/YOUR_FORMSPREE_FORM_ID"',
      'action="https://formspree.io/f/<!--YL:site.formspreeReviewId-->YOUR_FORMSPREE_FORM_ID<!--/YL:site.formspreeReviewId-->"'
    );
    changed = true;
  }

  if (content.includes('action="https://formspree.io/f/YOUR_FORMSPREE_RESTOCK_ID"')) {
    content = content.replace(
      'action="https://formspree.io/f/YOUR_FORMSPREE_RESTOCK_ID"',
      'action="https://formspree.io/f/<!--YL:site.formspreeRestockId-->YOUR_FORMSPREE_RESTOCK_ID<!--/YL:site.formspreeRestockId-->"'
    );
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, content);
    console.log(`Fixed placeholders in ${file}`);
  }
});
