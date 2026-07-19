const fs = require('fs');
const report = JSON.parse(fs.readFileSync('./lighthouse-report.json', 'utf8'));

const audit = report.audits['render-blocking-resources'];
console.log(JSON.stringify(audit, null, 2));
