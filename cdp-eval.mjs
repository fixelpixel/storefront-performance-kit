import { launch } from 'chrome-launcher';

const url = process.argv[2];
const expr = process.argv[3];

const chrome = await launch({
  chromeFlags: ['--headless=new', '--window-size=430,900'],
});
const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await new Promise((r) => (ws.onopen = r));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 6000));

const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(out.result?.result?.value ?? out.result, null, 2));
ws.close();
await chrome.kill();
