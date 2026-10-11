import type { CoordinatorMessage, NavigationPlan, NavigationReply } from './types.js';

function visible(element: Element) {
  return (
    element.checkVisibility({ checkVisibilityCSS: true }) && element.getClientRects().length > 0
  );
}

function messageElement(id: string, inVersions = false) {
  const selector = inVersions
    ? '[aria-modal="true"] [data-chatgpt-selection-message-id]'
    : 'main [data-chatgpt-search-message-ids]';
  return [...document.querySelectorAll(selector)].find(
    (element) =>
      visible(element) &&
      (inVersions
        ? element.getAttribute('data-chatgpt-selection-message-id') === id
        : element.getAttribute('data-chatgpt-search-message-ids')!.split(' ').includes(id)),
  );
}

function waitFor<T>(find: () => T | null | undefined | false, timeout = 12000): Promise<T> {
  const found = find();
  if (found) return Promise.resolve(found);
  return new Promise<T>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const value = find();
      if (value) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      }
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('targetMissing'));
    }, timeout);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  });
}

async function locateMainMessage(id: string, pathIds: string[]) {
  const region = await waitFor(() =>
    [...document.querySelectorAll<HTMLElement>('[aria-label="Conversation"]')].find(
      (element) => visible(element) && element.querySelector('[data-chatgpt-search-message-ids]'),
    ),
  );
  const renderedIds = () =>
    [...region.querySelectorAll('[data-chatgpt-search-message-ids]')]
      .filter(visible)
      .map((element) => element.getAttribute('data-chatgpt-search-message-ids')!.split(' ')[0]);
  let target = messageElement(id);
  while (!target) {
    const ids = renderedIds();
    const signature = ids.join('|');
    const indices = ids
      .map((messageId) => pathIds.indexOf(messageId))
      .filter((index) => index >= 0);
    const older = pathIds.indexOf(id) < Math.min(...indices);
    const reverse = getComputedStyle(region).flexDirection === 'column-reverse';
    region.scrollTop = older
      ? reverse
        ? -region.scrollHeight
        : 0
      : reverse
        ? 0
        : region.scrollHeight;
    await waitFor(() => messageElement(id) || renderedIds().join('|') !== signature);
    target = messageElement(id);
  }
  return target;
}

async function navigate(plan: NavigationPlan) {
  const versions = [...document.querySelectorAll('[aria-modal="true"]')].find(
    (dialog) => dialog.querySelector('h2')?.textContent === 'Versions',
  );
  if (versions) {
    [...versions.querySelectorAll<HTMLButtonElement>('button')]
      .find(
        (button) =>
          button.textContent!.trim() === 'Close dialog' ||
          button.getAttribute('aria-label') === 'Close dialog',
      )!
      .click();
    await waitFor(() => !versions.isConnected);
  }
  let target;
  if (plan.kind === 'current') {
    target = await locateMainMessage(plan.targetId, plan.pathIds);
  } else {
    const anchor = await locateMainMessage(plan.anchorId, plan.pathIds);
    const button = anchor
      .closest('[data-turn-key]')!
      .querySelector<HTMLButtonElement>('button[aria-label="See versions"]');
    if (!button) throw new Error('noVersions');
    button.click();
    await waitFor(() =>
      document.querySelector('[aria-modal="true"] button[aria-label="Next version"]'),
    );
    while (!messageElement(plan.matchId, true)) {
      const next = document.querySelector<HTMLButtonElement>(
        '[aria-modal="true"] button[aria-label="Next version"]',
      )!;
      if (next.disabled) throw new Error('versionMissing');
      const before = document.querySelector<HTMLElement>('[aria-modal="true"]')!.innerText;
      next.click();
      await waitFor(
        () => document.querySelector<HTMLElement>('[aria-modal="true"]')!.innerText !== before,
      );
    }
    target = await waitFor(() => {
      if (plan.targetRole === 'assistant') return messageElement(plan.targetId, true);
      const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
      return [
        ...document.querySelectorAll(
          '[aria-modal="true"] p, [aria-modal="true"] div, [aria-modal="true"] span',
        ),
      ].find(
        (element) =>
          visible(element) &&
          normalize(element.textContent!) === normalize(plan.targetText) &&
          ![...element.children].some(
            (child) => normalize(child.textContent!) === normalize(plan.targetText),
          ),
      );
    });
  }
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  target.animate([{ outline: '2px solid #74c8a6' }, { outline: '2px solid transparent' }], {
    duration: 1800,
  });
  await chrome.runtime.sendMessage({ type: 'navigated' });
}

chrome.runtime.onMessage.addListener(
  (message: { type: string; plan: NavigationPlan }, sender, respond) => {
    if (message.type !== 'navigate') return;
    navigate(message.plan).then(
      () => respond({ ok: true }),
      (error: Error) => respond({ error: error.message }),
    );
    return true;
  },
);

chrome.runtime
  .sendMessage<CoordinatorMessage, NavigationReply>({ type: 'ready' })
  .then((result) => {
    if (result.plan) return navigate(result.plan);
  })
  .catch((error: Error) =>
    chrome.runtime.sendMessage({ type: 'navigationError', error: error.message }),
  );

function observeMessages() {
  let timer: ReturnType<typeof setTimeout>;
  let previous = '';
  const observer = new MutationObserver(() => {
    const signature = [...document.querySelectorAll('main [data-chatgpt-search-message-ids]')]
      .filter(visible)
      .map(
        (element) =>
          `${element.getAttribute('data-chatgpt-search-message-ids')}:${element.textContent.length}`,
      )
      .join('|');
    if (signature === previous) return;
    previous = signature;
    clearTimeout(timer);
    timer = setTimeout(() => chrome.runtime.sendMessage({ type: 'sync' }), 1500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

observeMessages();
