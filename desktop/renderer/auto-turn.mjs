const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitForSendSlot({ busy, signal, sleep = delay, pollMs = 50, maxPolls = 400 }) {
  for (let index = 0; index < maxPolls; index++) {
    if (signal?.aborted) return false;
    if (!busy()) return true;
    await sleep(pollMs);
  }
  return false;
}

export async function waitForAvatarReply({ speaking, pending = () => false, signal,
  now = () => Date.now(), sleep = delay, startupTimeoutMs = 30000, maxReplyMs = 120000,
  quietMs = 1200, pollMs = 250 }) {
  const started = now();
  let observedActivity = false;
  let quietSince = null;
  while (now() - started < maxReplyMs) {
    if (signal?.aborted) return 'aborted';
    const preparing = pending();
    const playing = await speaking();
    const active = preparing || playing;
    if (signal?.aborted) return 'aborted';
    if (active) {
      observedActivity = true;
      quietSince = null;
    } else if (observedActivity) {
      quietSince ??= now();
      if (now() - quietSince >= quietMs) return 'finished';
    } else if (now() - started >= startupTimeoutMs) {
      return 'no-reply';
    }
    await sleep(pollMs);
  }
  return signal?.aborted ? 'aborted' : 'timed-out';
}
