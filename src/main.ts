import './styles.css';
import { mountApp } from './ui/render';

function showStartupError(error: unknown): void {
  const text = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  document.body.innerHTML = `
    <main style="font:14px Consolas,monospace;background:#080d14;color:#f3d28b;min-height:100vh;padding:24px;box-sizing:border-box">
      <h1 style="margin:0 0 12px;font-size:22px;color:#fff">GOA Timing Simulator startup error</h1>
      <p style="color:#9fb0c8">请把下面这段错误发回来，这比空白窗口更容易定位。</p>
      <pre style="white-space:pre-wrap;border:1px solid #37506a;border-radius:12px;padding:16px;background:#0d1724;color:#ffb4a8">${escapeHtml(text)}</pre>
    </main>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

window.addEventListener('error', (event) => showStartupError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => showStartupError(event.reason));

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');
try {
  mountApp(root);
} catch (error) {
  showStartupError(error);
}
