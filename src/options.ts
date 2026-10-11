import { createTranslator, resolveLanguage } from './i18n.js';
import type { LanguagePreference } from './i18n.js';

const languageSelect = document.querySelector<HTMLSelectElement>('#language')!;

async function renderLanguage() {
  const saved = await chrome.storage.local.get<{ language?: LanguagePreference }>('language');
  const preference = saved.language ?? 'auto';
  const language = resolveLanguage(preference, chrome.i18n.getUILanguage());
  const t = createTranslator(language);
  document.documentElement.lang = language === 'zh_CN' ? 'zh-CN' : 'en';
  document.title = t('settingsTitle');
  document.querySelector<HTMLElement>('#title')!.textContent = t('settingsTitle');
  document.querySelector<HTMLElement>('#language-label')!.textContent = t('language');
  document.querySelector<HTMLElement>('#automatic')!.textContent = t('automatic');
  document.querySelector<HTMLElement>('#hint')!.textContent = t('settingsHint');
  languageSelect.value = preference;
}

languageSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ language: languageSelect.value as LanguagePreference });
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.language) void renderLanguage();
});

await renderLanguage();
