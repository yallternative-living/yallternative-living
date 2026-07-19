const fs = require('fs');
const report = JSON.parse(fs.readFileSync('./lighthouse-report.json', 'utf8'));

const audit = report.audits['unsized-images'];
if (audit && audit.details && audit.details.items) {
  audit.details.items.forEach(item => {
    console.log(item.node.snippet);
  });
}
