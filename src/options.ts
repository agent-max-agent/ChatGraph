import { createTranslator, resolveLanguage, translatedError } from './i18n.js';
import type { LanguagePreference, MessageKey, Translator } from './i18n.js';
import type { Conversation, IndexProgress } from './types.js';

interface CacheEntry {
  key: string;
  title: string;
  description: string;
  bytes: number;
}

class Settings {
  t: Translator = createTranslator('en');
  entries: CacheEntry[] = [];
  selected = new Set<string>();
  inspecting = false;
  busy = false;
  status = '';
  revision = 0;
  language = document.querySelector<HTMLSelectElement>('#language')!;

  async render() {
    const revision = ++this.revision;
    const values = await chrome.storage.local.get<Record<string, unknown>>(null);
    const preference = (values.language as LanguagePreference | undefined) ?? 'auto';
    const language = resolveLanguage(preference, chrome.i18n.getUILanguage());
    const t = createTranslator(language);
    const entries = await Promise.all(
      Object.entries(values)
        .filter(([key]) => key.startsWith('conversation:') || key === 'historyIndex')
        .map(async ([key, value]): Promise<CacheEntry> => {
          const conversation = value as Conversation;
          const progress = value as IndexProgress;
          return {
            key,
            title:
              key === 'historyIndex'
                ? t('cacheProgress', [String(progress.completed), String(progress.total)])
                : conversation.title || conversation.id,
            description:
              key === 'historyIndex'
                ? key
                : `${conversation.id} · ${t('cacheMessages', [String(conversation.nodes.length)])}`,
            bytes: await chrome.storage.local.getBytesInUse(key),
          };
        }),
    );
    if (revision !== this.revision) return;
    this.t = t;
    this.entries = entries.sort((a, b) => a.title.localeCompare(b.title));
    this.selected = new Set(
      [...this.selected].filter((key) => entries.some((entry) => entry.key === key)),
    );
    document.documentElement.lang = language === 'zh_CN' ? 'zh-CN' : 'en';
    document.title = t('settingsTitle');
    document.querySelector<HTMLElement>('#title')!.textContent = t('settingsTitle');
    document.querySelector<HTMLElement>('#language-label')!.textContent = t('language');
    document.querySelector<HTMLElement>('#automatic')!.textContent = t('automatic');
    document.querySelector<HTMLElement>('#hint')!.textContent = t('settingsHint');
    this.language.value = preference;
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
      element.textContent = t(element.dataset.i18n as MessageKey);
    });
    document.querySelector<HTMLElement>('#cache-status')!.textContent = translatedError(
      this.status,
      t,
    );
    document.querySelector<HTMLElement>('#cache-summary')!.textContent = t('cacheSummary', [
      String(entries.length),
      this.size(entries.reduce((sum, entry) => sum + entry.bytes, 0)),
    ]);
    document.querySelector<HTMLElement>('#cache-summary')!.hidden = !this.inspecting;
    document.querySelector<HTMLElement>('#cache-empty')!.hidden =
      !this.inspecting || entries.length > 0;
    const list = document.querySelector<HTMLElement>('#cache-list')!;
    list.hidden = !this.inspecting;
    const inspectButton = document.querySelector<HTMLButtonElement>('#inspect')!;
    inspectButton.textContent = t(this.inspecting ? 'cacheCollapse' : 'cacheInspect');
    inspectButton.setAttribute('aria-expanded', String(this.inspecting));
    list.replaceChildren(
      ...this.entries.map((entry) => {
        const row = document.createElement('div');
        row.className = 'cache-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.selected.has(entry.key);
        checkbox.disabled = this.busy;
        checkbox.setAttribute('aria-label', t('cacheSelect', [entry.title]));
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) this.selected.add(entry.key);
          else this.selected.delete(entry.key);
          this.controls();
        });
        const content = document.createElement('div');
        const title = document.createElement('span');
        title.className = 'entry-title';
        title.textContent = entry.title;
        const description = document.createElement('small');
        description.textContent = entry.description;
        content.append(title, description);
        const size = document.createElement('span');
        size.textContent = this.size(entry.bytes);
        row.append(checkbox, content, size);
        return row;
      }),
    );
    this.controls();
  }

  size(bytes: number) {
    return bytes < 1024
      ? this.t('cacheBytes', [bytes.toLocaleString(document.documentElement.lang)])
      : this.t('cacheKilobytes', [
          (bytes / 1024).toLocaleString(document.documentElement.lang, {
            maximumFractionDigits: 1,
          }),
        ]);
  }

  controls() {
    document.querySelector<HTMLButtonElement>('#inspect')!.disabled = this.busy;
    document.querySelector<HTMLButtonElement>('#clear-selected')!.disabled =
      this.busy || !this.inspecting || !this.selected.size;
    document.querySelector<HTMLButtonElement>('#clear-all')!.disabled =
      this.busy || !this.entries.length;
  }

  async clear(all: boolean) {
    if (all && !window.confirm(this.t('cacheConfirm'))) return;
    this.busy = true;
    this.controls();
    const status = document.querySelector<HTMLElement>('#cache-status')!;
    this.status = '';
    status.textContent = '';
    try {
      const values = await chrome.storage.local.get(null);
      const keys = Object.keys(values).filter(
        (key) =>
          (key.startsWith('conversation:') || key === 'historyIndex') &&
          (all || this.selected.has(key)),
      );
      await chrome.storage.local.remove(keys);
      this.status = `cacheClearComplete|${keys.length}`;
    } catch (error) {
      this.status = (error as Error).message;
    } finally {
      this.busy = false;
      await this.render();
    }
  }
}

const settings = new Settings();
settings.language.addEventListener('change', async () => {
  await chrome.storage.local.set({ language: settings.language.value as LanguagePreference });
});
document.querySelector('#inspect')!.addEventListener('click', () => {
  settings.inspecting = !settings.inspecting;
  void settings.render();
});
document
  .querySelector('#clear-selected')!
  .addEventListener('click', () => void settings.clear(false));
document.querySelector('#clear-all')!.addEventListener('click', () => void settings.clear(true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === 'local' &&
    Object.keys(changes).some(
      (key) => key === 'language' || key === 'historyIndex' || key.startsWith('conversation:'),
    )
  )
    void settings.render();
});
await settings.render();
