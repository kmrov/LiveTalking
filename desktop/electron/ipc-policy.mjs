export function isAllowedStudioNavigation(destination, expectedUrl) {
  return destination === expectedUrl;
}

export function isTrustedStudioSender(event, window, expectedUrl) {
  if (!event?.sender || !window?.webContents || window.isDestroyed?.()) return false;
  if (event.sender !== window.webContents) return false;
  if (event.sender.id !== window.webContents.id) return false;
  if (event.sender.getURL() !== expectedUrl) return false;
  if (event.senderFrame?.url && event.senderFrame.url !== expectedUrl) return false;
  return true;
}

export function mayUseMicrophone(event, permission, window, expectedUrl, details = {}) {
  return permission === 'media'
    && Array.isArray(details.mediaTypes)
    && details.mediaTypes.includes('audio')
    && !details.mediaTypes.includes('video')
    && isTrustedStudioSender(event, window, expectedUrl);
}
