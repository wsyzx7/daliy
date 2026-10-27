// 从仓库根目录的 todo.md 读取待办，拼成微信消息，推送到 Server酱。
// 由 GitHub Actions 调用：SLOT=morning|noon|evening|night
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SLOT = (process.env.SLOT || 'morning').toLowerCase();
const KEY = process.env.SERVERCHAN_SENDKEY || '';
const TZ = 'Asia/Shanghai';
const MAX = 6;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const todoPath = path.join(repoRoot, 'todo.md');

const pad = (n) => String(n).padStart(2, '0');

function todayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shift(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function weekdayZh(dateStr) {
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'UTC' })
    .format(new Date(`${dateStr}T00:00:00Z`));
}

async function loadItems() {
  const raw = await readFile(todoPath, 'utf8');
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const done = m[1] !== ' ';
    let text = m[2];
    let due = null;
    const dm = /@(\d{4}-\d{2}-\d{2})/.exec(text);
    if (dm) {
      due = dm[1];
      text = text.replace(/\s*@\d{4}-\d{2}-\d{2}/, '').trim();
    }
    items.push({ text, due, done });
  }
  return items;
}

function buildMessage(slot, today, todayItems, doneToday, overdue, tomorrow) {
  const lines = [];
  const done = doneToday.length;
  const pending = todayItems.length;
  const total = done + pending;

  lines.push(`### ${today} ${weekdayZh(today)}`, '');

  if (slot === 'morning') {
    if (total === 0) {
      lines.push('今天没有排任务。缓冲日：补欠账，或者彻底休息。');
    } else {
      lines.push('**先做这一步（2 分钟）**：打开第一个任务，只看一页图或做一道题，做完就算启动成功', '');
      lines.push(`**今天 ${pending} 件事**`);
      for (const i of todayItems.slice(0, MAX)) lines.push(`- [ ] ${i.text}`);
    }
    if (overdue.length) {
      lines.push('', `**更早还剩 ${overdue.length} 项**`);
      for (const i of overdue.slice(0, 3)) {
        const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${i.due}T00:00:00Z`)) / 86400000);
        lines.push(`- [ ] ${i.text}（逾期 ${days} 天）`);
      }
    }
    lines.push('', '> 3.5 小时是目标不是底线；先完成，再优化');
    return { title: `今日计划 · ${today.slice(5)}`, desp: lines.join('\n') };
  }

  if (slot === 'noon') {
    if (total === 0) {
      lines.push('今天没有排任务。');
    } else {
      lines.push(`**已完成 ${done}/${total}**`);
      if (pending === 0) {
        lines.push('', '今天的任务全部打勾了 ✅ 下午可以提前开下一项，或者休息。');
      } else {
        lines.push('', '**还差**');
        for (const i of todayItems.slice(0, MAX)) lines.push(`- [ ] ${i.text}`);
      }
    }
    lines.push('', '> 下午先花 15 分钟收尾最容易的一项，别从头开始');
    return { title: `午间检查 · ${done}/${total}`, desp: lines.join('\n') };
  }

  if (slot === 'evening') {
    if (total === 0) {
      lines.push('今天没有排任务，晚上自由安排。');
    } else if (pending === 0) {
      lines.push('今天的任务已经全部打勾 ✅ 晚上不用再加量，去休息。');
    } else {
      lines.push(`**还剩 ${pending} 项**`);
      for (const i of todayItems.slice(0, MAX)) lines.push(`- [ ] ${i.text}`);
      lines.push('', '> 现在只承诺 15 分钟：按下计时器，做不完也没关系');
    }
    return { title: `晚间场 · 还剩 ${pending} 项`, desp: lines.join('\n') };
  }

  // night
  lines.push(`**今日 ${done}/${total}**`);
  for (const i of doneToday) lines.push(`✅ ${i.text}`);
  for (const i of todayItems) lines.push(`⬜ ${i.text}`);
  if (tomorrow.length) {
    lines.push('', '**明天**');
    for (const i of tomorrow.slice(0, 3)) lines.push(`- ${i.text}`);
  }
  lines.push('', '> 回我一句完成情况，我记连续天数；连续断 2 天，第 3 天只做最小版，禁止补课');
  return { title: `今日收尾 · ${done}/${total}`, desp: lines.join('\n') };
}

async function main() {
  const today = todayStr();
  const items = await loadItems();
  const open = items.filter((i) => !i.done);
  const todayItems = open.filter((i) => i.due === today);
  const doneToday = items.filter((i) => i.done && i.due === today);
  const overdue = open
    .filter((i) => i.due && i.due < today)
    .sort((a, b) => a.due.localeCompare(b.due));
  const tomorrow = open.filter((i) => i.due === shift(today, 1));

  const { title, desp } = buildMessage(SLOT, today, todayItems, doneToday, overdue, tomorrow);

  if (process.env.DRY_RUN === '1') {
    console.log(`[dry-run] slot=${SLOT}\n标题：${title}\n\n${desp}`);
    return;
  }

  if (!KEY) {
    console.error('缺少 SERVERCHAN_SENDKEY 环境变量（仓库 Secret 未配置）');
    process.exit(1);
  }

  const body = new URLSearchParams({ title, desp });
  const res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(KEY)}.send`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || json.code !== 0) {
    console.error('推送失败:', res.status, JSON.stringify(json));
    process.exit(1);
  }

  console.log(`[${new Date().toISOString()}] slot=${SLOT} 已推送: ${title}`);
}

main().catch((err) => {
  console.error('脚本错误:', err);
  process.exit(1);
});
