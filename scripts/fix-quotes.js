const fs = require('fs');
let s = fs.readFileSync('src/utils/exam.js','utf8');

// 1) Fix template literals that start with ` but end with '
// Match: `...text without backticks...' followed by whitespace and ), comma, semicolon, or }
// Use a while loop to catch them all
let prev;
do {
  prev = s;
  s = s.replace(/`([^`\n]*)'(\s*\)?\s*[,;}\]])/g, '`$1`$2');
} while (prev !== s);

fs.writeFileSync('src/utils/exam.js', s);
console.log('Done - fixed template literal mismatches');
