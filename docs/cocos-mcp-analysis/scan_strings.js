// 扫描 decoded-strings.json 中所有长字符串(工具描述、提示词类内容)
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/Project/cocos/jihe_defence/extensions/cocos-mcp-v1.7.5-all/deobfuscated';
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'decoded-strings.json'), 'utf8'));

const keys = Object.keys(d);
for (const k of keys) {
  const arr = d[k];
  if (!Array.isArray(arr)) continue;
  const longStrs = arr.filter(x =>
    typeof x === 'string' && x.length > 40 &&
    !/^[0-9a-fA-F]{20,}$/.test(x) &&
    !x.includes('\\x') && !x.includes('0x') && !x.includes('\\u')
  );
  if (longStrs.length > 0) {
    console.log('### ' + k + ' -> ' + longStrs.length + ' long strings');
    for (const s of longStrs.slice(0, 8)) {
      console.log('   • ' + s.slice(0, 200));
    }
  }
}
