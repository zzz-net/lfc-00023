const fs = require('fs');
const path = require('path');

function checkFile(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const regex = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  const issues = [];
  let idx = 0;
  while ((m = regex.exec(html)) !== null) {
    idx++;
    const code = m[1];
    if (code.trim() === '') continue;

    // 1. 检查 onclick 中是否有未转义的单引号问题（模板字符串）
    const onclickRE = /onclick\s*=\s*"[^"]*\$\{[^}]+\}[^"]*"/g;
    const onclickM = code.match(onclickRE);
    if (onclickM) {
      for (const om of onclickM) {
        // 检查 onclick 中的字符串插值是否用单引号包裹变量
        if (om.includes("'${")) {
          issues.push(`脚本${idx}: onclick属性存在单引号注入风险: ${om.slice(0, 100)}`);
        }
      }
    }

    // 2. 检查模板字符串中是否嵌套了带引号的 onclick 属性
    const templateRE = /`[^`]*onclick\s*=\s*"[^"`]*\$\{[^}`]+\}[^"`]*"[^`]*`/g;
    const tplM = code.match(templateRE);
    if (tplM) {
      for (const tm of tplM) {
        if (tm.includes(`'$`) || tm.includes(`\${'`)) {
          issues.push(`脚本${idx}: 模板字符串内onclick属性有引号冲突风险: ${tm.slice(0, 120)}`);
        }
      }
    }

    // 3. 检查 JSON.stringify 在 td 中直接输出（可能破坏HTML）
    if (code.includes('${JSON.stringify(')) {
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('${JSON.stringify(') && lines[i].includes('<td')) {
          issues.push(`脚本${idx} 行${i+1}: JSON.stringify直接输出到td中，可能破坏HTML结构`);
        }
      }
    }

    // 4. 检查未转义的换行符在属性中
    if (code.includes('onclick="') && code.includes('\n')) {
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('onclick="') && !lines[i].includes('" onclick') && !lines[i].endsWith('">') && !lines[i].endsWith('"')) {
          if (!lines[i].includes('</button>') && !lines[i].includes('>')) {
            issues.push(`脚本${idx} 行${i+1}: onclick属性跨多行，可能有解析问题`);
          }
        }
      }
    }
  }
  return issues;
}

const files = ['admin.html', 'nurse.html', 'doctor.html'];
let found = false;
for (const f of files) {
  const fullPath = path.join(__dirname, '../public', f);
  const issues = checkFile(fullPath);
  console.log(`\n=== ${f} ===`);
  if (issues.length === 0) {
    console.log('  ✓ 无明显问题');
  } else {
    found = true;
    for (const i of issues) {
      console.log(`  ✗ ${i}`);
    }
  }
}
console.log(found ? '\n存在需要修复的问题' : '\n所有页面初步检查通过');
