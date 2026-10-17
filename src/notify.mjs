// Shows a Windows notification, used when a run has failed for good. On other systems,
// and if PowerShell isn't available, it does nothing: a missed notice must never fail a run.
import { spawn as spawnProcess } from 'node:child_process';

// Windows PowerShell's own app id, so the notification needs no installed app registration.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($env:HUB_TOAST_XML)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

const escapeXml = (value) => String(value).slice(0, 250)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toastXml(title, body) {
  return `<toast><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>`;
}

export function createNotifier({ platform = process.platform, spawn = spawnProcess } = {}) {
  return function notify(title, body) {
    if (platform !== 'win32') return;
    try {
      // The text travels in an environment variable, never in the script, so it can't run as code.
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
        env: { ...process.env, HUB_TOAST_XML: toastXml(title, body) }, stdio: 'ignore', windowsHide: true,
      });
      child.on?.('error', () => {});
      child.unref?.();
    } catch { /* Notifications are best-effort. */ }
  };
}
