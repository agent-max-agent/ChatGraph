import en from '../public/_locales/en/messages.json' with { type: 'json' };
import zh from '../public/_locales/zh_CN/messages.json' with { type: 'json' };

export type Language = 'en' | 'zh_CN';

export type LanguagePreference = Language | 'auto';

export type MessageKey = keyof typeof en;

export type Translator = (key: MessageKey, substitutions?: string[]) => string;

export function resolveLanguage(preference: LanguagePreference, browserLanguage: string): Language {
  return preference === 'auto'
    ? browserLanguage.toLowerCase().startsWith('zh')
      ? 'zh_CN'
      : 'en'
    : preference;
}

export function createTranslator(language: Language): Translator {
  const messages = language === 'zh_CN' ? zh : en;
  return (key, substitutions = []) =>
    messages[key].message.replace(
      /\$(\d)/g,
      (_, index: string) => substitutions[Number(index) - 1],
    );
}

export function translatedError(message: string, translate: Translator): string {
  const [key, ...args] = message.split('|');
  return key in en ? translate(key as MessageKey, args) : message;
}
