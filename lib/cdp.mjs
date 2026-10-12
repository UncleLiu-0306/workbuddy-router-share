/**
 * 最小 CDP 客户端：用于从本机 WorkBuddy 桌面端一次性导出登录态。
 * 只在 `wb.mjs import` 时使用；日常签到/网关不需要桌面端。
 */
import { execSync } from 'node:child_process';

const APP_PATH = '/Applications/WorkBuddy.app';
const PROC_PATTERN = 'WorkBuddy.app/Contents/MacOS/Electron';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isAppRunning() {
  try {
    return execSync(`pgrep -f "${PROC_PATTERN}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
  } catch { return false; }
}

export function quitApp() {
  try { execSync(`osascript -e 'tell application "WorkBuddy" to quit'`, { stdio: 'ignore', timeout: 15000 }); } catch {}
  for (let i = 0; i < 20; i++) { if (!isAppRunning()) return true; execSync('sleep 0.5'); }
  try { execSync(`pkill -f "${PROC_PATTERN}"`, { stdio: 'ignore' }); } catch {}
  for (let i = 0; i < 20; i++) { if (!isAppRunning()) return true; execSync('sleep 0.5'); }
  return !isAppRunning();
}

async function targets(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

class Conn {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 45000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

/**
 * 取本机桌面端登录态的 accessToken + 账号信息。
 * @param {{port?:number, relaunch?:boolean, log?:Function}} opts
 */
export async function readDesktopSession({ port = 9222, relaunch = false, log = () => {} } = {}) {
  let launched = false;
  if (!(await targets(port))) {
    if (isAppRunning()) {
      if (!relaunch) throw new Error('WorkBuddy 正在运行但没有调试端口。加 --relaunch 让脚本重启它以读取登录态。');
      log('重启 WorkBuddy 以开启调试端口…');
      if (!quitApp()) throw new Error('WorkBuddy 无法退出');
    }
    log('启动 WorkBuddy…');
    execSync(`open -a "${APP_PATH}" --args --remote-debugging-port=${port}`, { stdio: 'ignore' });
    launched = true;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) { if (await targets(port)) break; await sleep(2000); }
    if (!(await targets(port))) throw new Error('调试端口未就绪');
  }

  const deadline = Date.now() + 120000;
  let lastErr = '未找到渲染进程';
  while (Date.now() < deadline) {
    const list = await targets(port);
    const pages = (list || []).filter((t) => t.type === 'page' || t.type === 'webview');
    const t = pages.find((x) => /renderer\/index\.html/.test(x.url)) || pages[0];
    if (!t) { await sleep(2000); continue; }
    let conn;
    try {
      conn = await new Promise((resolve, reject) => {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        const to = setTimeout(() => reject(new Error('ws 连接超时')), 10000);
        ws.addEventListener('open', () => { clearTimeout(to); resolve(new Conn(ws)); });
        ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('ws 错误')); });
      });
      await conn.send('Runtime.enable');
      const r = await conn.send('Runtime.evaluate', {
        expression: `typeof window.wb === 'object' && window.wb && typeof window.wb.invoke === 'function'`,
        returnByValue: true,
      });
      if (!r.result?.value) { lastErr = 'window.wb 未就绪'; conn.close(); await sleep(2000); continue; }
      const res = await conn.send('Runtime.evaluate', {
        expression: `(async () => ({
          accessToken: await window.wb.invoke('auth:getToken'),
          account: await window.wb.invoke('auth:getAccount'),
        }))()`,
        awaitPromise: true, returnByValue: true, userGesture: true,
      });
      conn.close();
      const v = res.result.value;
      if (!v?.accessToken) throw new Error('未取到 accessToken（可能未登录）');
      return { accessToken: v.accessToken, account: v.account || {}, launched };
    } catch (e) {
      lastErr = String((e && e.message) || e);
      try { conn && conn.close(); } catch {}
      await sleep(2000);
    }
  }
  throw new Error('读取桌面端登录态超时: ' + lastErr);
}
