/* 测试脚本专用：改动 data/config.json 之前先备份，结束后原样还原。
   这样跑测试永远不会把用户填的 API Key 冲掉。 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(import.meta.dirname, '..', 'data', 'config.json');

export function backupConfig() {
  try {
    return fs.readFileSync(FILE);
  } catch {
    return null;
  }
}

export function restoreConfig(buf) {
  try {
    if (buf) fs.writeFileSync(FILE, buf);
    else fs.rmSync(FILE, { force: true });
  } catch (err) {
    console.error('恢复 config.json 失败：', err.message);
  }
}
