import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(webSocketUrl);
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
      this.socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
          return;
        }
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        this.listeners.get(method)?.delete(listener);
        resolve(params);
      };
      const listeners = this.listeners.get(method) ?? new Set();
      listeners.add(listener);
      this.listeners.set(method, listeners);
    });
  }

  close() {
    this.socket.close();
  }
}

function devtoolsEndpoint(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome did not expose DevTools within 15 seconds')), 15_000);
    let buffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before QA with code ${code}`));
    });
  });
}

function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

export async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value;
}

export async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 900,
  });
  await evaluate(cdp, `new Promise((resolve) => {
    window.scrollTo(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
}

export function measureLandscape(cdp) {
  return evaluate(cdp, `(() => {
    const canvas = document.querySelector('#plan-canvas').getBoundingClientRect();
    const navigation = document.querySelector('.mobile-nav').getBoundingClientRect();
    const toolbar = document.querySelector('.canvas-actions').getBoundingClientRect();
    return {
      canvasVisible: canvas.height >= 150 && canvas.bottom <= navigation.top,
      controlsVisible: toolbar.bottom <= navigation.top,
      noDocumentOverflow: document.documentElement.scrollWidth <= innerWidth,
      geometry: {
        canvas: { top: canvas.top, bottom: canvas.bottom, height: canvas.height },
        navigation: { top: navigation.top, bottom: navigation.bottom, height: navigation.height },
        toolbar: { top: toolbar.top, bottom: toolbar.bottom, height: toolbar.height },
      },
    };
  })()`);
}

export async function capture(cdp, path) {
  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(path, Buffer.from(screenshot.data, 'base64'));
  return path;
}

export async function launchChrome(chromePath) {
  const profileDir = await mkdtemp(join(
    process.env.REAL_PLAN_AUDIT_PROFILE_ROOT ?? tmpdir(),
    'room-studio-browser-qa-',
  ));
  const child = spawn(chromePath, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--hide-scrollbars',
    '--no-first-run',
    '--remote-debugging-port=0',
    '--window-size=1440,1000',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const browserWebSocket = await devtoolsEndpoint(child);
  const browserPort = new URL(browserWebSocket).port;
  const targets = await fetch(`http://127.0.0.1:${browserPort}/json/list`).then((response) => response.json());
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('Chrome page target was not created');

  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
  return {
    cdp,
    async navigate(url) {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
    },
    async close() {
      cdp.close();
      await stopProcess(child);
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
