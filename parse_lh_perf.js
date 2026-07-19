const fs = require('fs');
const report = JSON.parse(fs.readFileSync('./lighthouse-report.json', 'utf8'));

console.log('Performance Audits < 1.0:');
const perfAudits = report.categories.performance.auditRefs;
perfAudits.forEach(ref => {
  const audit = report.audits[ref.id];
  if (audit.score !== null && audit.score < 1) {
    console.log(`- ${audit.title}: ${audit.displayValue}`);
  }
});
