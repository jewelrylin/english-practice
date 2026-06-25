const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scriptMatch = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);

if (!scriptMatch) {
  throw new Error('找不到 index.html 內的 Babel 應用程式碼');
}

const source = scriptMatch[1];
const ast = parser.parse(source, {
  sourceType: 'script',
  plugins: ['jsx'],
});

function findVariable(name) {
  for (const statement of ast.program.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type === 'Identifier' && declaration.id.name === name) {
        return declaration.init;
      }
    }
  }
  return null;
}

function propertyName(property) {
  if (!property || property.type !== 'ObjectProperty') return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'StringLiteral') return property.key.value;
  return null;
}

function literalValue(node) {
  if (node?.type === 'StringLiteral') return node.value;
  return null;
}

const badgeChecksNode = findVariable('BADGE_CHECKS');
const badgeDefsNode = findVariable('BADGE_DEFS');

if (badgeChecksNode?.type !== 'ObjectExpression') {
  throw new Error('BADGE_CHECKS 必須是物件');
}

if (
  badgeDefsNode?.type !== 'CallExpression' ||
  badgeDefsNode.callee?.type !== 'MemberExpression' ||
  badgeDefsNode.callee.object?.type !== 'ArrayExpression'
) {
  throw new Error('BADGE_DEFS 必須由 badge 陣列建立');
}

const checkIds = new Set(
  badgeChecksNode.properties
    .map(propertyName)
    .filter(Boolean)
);

const requiredFields = ['id', 'name', 'desc', 'reward'];
const badgeErrors = [];
const badgeIds = [];

for (const [index, element] of badgeDefsNode.callee.object.elements.entries()) {
  if (element?.type !== 'ObjectExpression') {
    badgeErrors.push(`badge #${index + 1} 不是物件`);
    continue;
  }

  const properties = new Map(
    element.properties
      .map(property => [propertyName(property), property])
      .filter(([name]) => name)
  );
  const id = literalValue(properties.get('id')?.value);

  for (const field of requiredFields) {
    if (!properties.has(field)) {
      badgeErrors.push(`${id || `badge #${index + 1}`} 缺少 ${field}`);
    }
  }

  if (!id) {
    badgeErrors.push(`badge #${index + 1} 的 id 必須是字串`);
    continue;
  }

  badgeIds.push(id);
  if (!checkIds.has(id)) badgeErrors.push(`${id} 缺少真正的 check 條件`);

  const reward = properties.get('reward')?.value;
  if (reward?.type !== 'ObjectExpression') {
    badgeErrors.push(`${id} 的 reward 必須是物件`);
  }
}

const duplicateIds = badgeIds.filter((id, index) => badgeIds.indexOf(id) !== index);
if (duplicateIds.length) {
  badgeErrors.push(`badge id 重複：${[...new Set(duplicateIds)].join(', ')}`);
}

const directlyCallsCheck = /\bb\.check\s*\(/.test(source);
if (directlyCallsCheck && checkIds.size !== badgeIds.length) {
  badgeErrors.push('程式直接呼叫 b.check，但並非每個 badge 都有 check');
}

if (!/typeof\s+b\.check\s*===\s*['"]function['"]/.test(source)) {
  badgeErrors.push('缺少 b.check 的安全 fallback');
}

if (badgeIds.length !== 36) {
  badgeErrors.push(`預期 36 個 badge，實際為 ${badgeIds.length} 個`);
}

const requiredSafetyPatterns = [
  ['canUseCloud()', /function\s+canUseCloud\s*\(/],
  ['dirtyLocalData state', /const\s+\[dirtyLocalData,\s*setDirtyLocalData\]/],
  ['updated_at conflict comparison', /localUpdatedAt[\s\S]*cloudUpdatedAt/],
  ['offline dirty guard', /dirtyRef\.current[\s\S]*preserveSyncConflict/],
];

for (const [label, pattern] of requiredSafetyPatterns) {
  if (!pattern.test(source)) badgeErrors.push(`缺少 Offline Sync Safety：${label}`);
}

const sourceLines = source.split('\n');
for (const [index, line] of sourceLines.entries()) {
  if (!/\bsb\.(from|rpc|auth)\b/.test(line)) continue;
  const nearbyCode = sourceLines.slice(Math.max(0, index - 20), index + 1).join('\n');
  if (!/canUseCloud\s*\(/.test(nearbyCode)) {
    badgeErrors.push(`第 ${index + 1} 行 Supabase 操作未經 canUseCloud()`);
  }
}

for (const [index, line] of sourceLines.entries()) {
  if (!/\bawait\b/.test(line)) continue;
  const postAwaitCode = sourceLines.slice(index + 1, index + 16).join('\n');
  if (!/(canUseCloud\s*\(|dirtyRef\.current|cloudAccessState\.dirtyLocalData|offlineMode|!active|cancelled)/.test(postAwaitCode)) {
    badgeErrors.push(`第 ${index + 1} 行 await 後缺少 cloud/offline/dirty 重新驗證`);
  }
}

for (const [index, line] of sourceLines.entries()) {
  if (!/saveProgToDB\([^)]*\)\.then\s*\(/.test(line)) continue;
  const callbackCode = sourceLines.slice(index, index + 12).join('\n');
  if (!/canUseCloud\s*\(/.test(callbackCode) ||
      !/cloudAccessState\.dirtyLocalData/.test(callbackCode) ||
      !/updated_at/.test(callbackCode)) {
    badgeErrors.push(`第 ${index + 1} 行同步 callback 缺少 cloud/dirty/version 重新驗證`);
  }
}

if (badgeErrors.length) {
  console.error('Validation failed:');
  for (const error of badgeErrors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Validation passed: ${badgeIds.length} badges，必要欄位與 check 條件完整。`);
