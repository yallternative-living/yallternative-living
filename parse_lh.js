const fs = require('fs');
const report = JSON.parse(fs.readFileSync('./lighthouse-report.json', 'utf8'));

console.log('Scores:');
for (const key of Object.keys(report.categories)) {
  console.log(`${report.categories[key].title}: ${Math.round(report.categories[key].score * 100)}`);
}
