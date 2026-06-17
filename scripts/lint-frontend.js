const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = ['admin.html', 'nurse.html', 'doctor.html'];
let hasError = false;

for (const f of files) {
  const fullPath = path.join(__dirname, '../public', f);
  const html = fs.readFileSync(fullPath, 'utf8');
  const regex = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m, idx = 0;
  while ((m = regex.exec(html)) !== null) {
    idx++;
    const code = m[1];
    try {
      new vm.Script(code, { filename: `${f}:script${idx}` });
      console.log(`✓ ${f} 脚本${idx} 语法OK (${code.trim().split('\n').length} 行)`);
    } catch (e) {
      hasError = true;
      const lines = code.split('\n');
      const errLine = e.loc ? e.loc.line : '?';
      const lineText = lines[errLine - 1] || 'N/A';
      console.log(`✗ ${f} 脚本${idx} 语法错误: ${e.message}`);
      console.log(`  行 ${errLine}: ${lineText.trim()}`);
    }
  }
}

console.log(hasError ? '\n存在语法错误' : '\n全部语法检查通过');
process.exit(hasError ? 1 : 0);
