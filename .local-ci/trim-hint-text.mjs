#!/usr/bin/env node
/* 精简提示文字：
   - 阈值设置：去掉"分组与样本库一致…"前半句，保留"超出上限…"的判定说明
   - 设置页：删掉"温度报警阈值已移到侧边栏…"整句（该页已无阈值项，无需说明）
   两份 index.html 同步。
   用法：node .local-ci/trim-hint-text.mjs [--check] */
import fs from 'node:fs';

const checkOnly = process.argv.includes('--check');
const files = [
  'D:/PROJECT/VITALS/vitals-android/app/src/main/assets/web/index.html',
  'D:/PROJECT/VITALS/web-preview/index.html',
];

const edits = [
  {
    label: '阈值设置：保留判定说明，去掉分组口径说明',
    from: '        <p class="muted">分组与「样本库」一致：样本库里出现过的类别都会列在下面，可逐个设置上下限。超出上限或低于下限即报「异常」，接近边界 2.5℃ 内报「预警」。</p>',
    to: '        <p class="muted">超出上限或低于下限即报「异常」，接近边界 2.5℃ 内报「预警」。</p>',
  },
  {
    label: '设置页：删除指向阈值页的说明句',
    from: '        <p class="muted">温度报警阈值已移到侧边栏的「阈值设置」，可按样本分组分别配置。</p>\n',
    to: '',
  },
];

let total = 0;
for (const file of files) {
  let text = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const edit of edits) {
    if (!text.includes(edit.from)) { console.log(`  [!] 未匹配（${edit.label}）：${file.split('/').slice(-2).join('/')}`); continue; }
    text = text.replace(edit.from, edit.to);
    n++;
  }
  if (!checkOnly) fs.writeFileSync(file, text, 'utf8');
  console.log(`${file.split('/').slice(-2).join('/')}: ${n} 处`);
  total += n;
}
console.log(`合计 ${total} 处`);
