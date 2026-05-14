import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aiCreationDir = path.resolve(__dirname, '..');
const localeDir = path.resolve(aiCreationDir, '../../i18n/locales');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs']);
const IGNORED_DIRS = new Set(['__tests__']);

const LOCALES = ['zh-CN', 'zh-TW', 'en', 'fr', 'ru', 'ja', 'vi'];
const DYNAMIC_TRANSLATION_KEYS = [
  '正在为您设计中...',
  '灵感正在慢慢成形',
  '细节正在被认真打磨',
  '画面很快就会出现',
];

const extractTranslationKeys = (source) => {
  const keys = new Set();
  const translationCallPattern = /\bt\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g;
  let match;

  while ((match = translationCallPattern.exec(source)) !== null) {
    keys.add(match[1] || match[2] || match[3]);
  }

  return keys;
};

const collectSourceFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        files.push(...(await collectSourceFiles(fullPath)));
      }
      continue;
    }

    if (
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !entry.name.endsWith('.bak')
    ) {
      files.push(fullPath);
    }
  }

  return files.sort();
};

const loadLocale = async (locale) => {
  const raw = await readFile(path.join(localeDir, `${locale}.json`), 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.translation || parsed;
};

const run = async () => {
  const allKeys = new Set();
  const sourceFiles = await collectSourceFiles(aiCreationDir);

  for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8');
    for (const key of extractTranslationKeys(source)) {
      allKeys.add(key);
    }
  }
  for (const key of DYNAMIC_TRANSLATION_KEYS) {
    allKeys.add(key);
  }

  assert.ok(
    allKeys.size > 0,
    'expected AI creation files to contain i18n translation keys',
  );

  for (const locale of LOCALES) {
    const messages = await loadLocale(locale);
    const missingKeys = [...allKeys].filter(
      (key) => typeof messages[key] !== 'string' || messages[key].length === 0,
    );

    assert.deepEqual(
      missingKeys,
      [],
      `${locale} is missing AI creation i18n keys`,
    );
  }

  console.log(
    `ai-creation i18n coverage passed for ${allKeys.size} keys across ${LOCALES.length} locales`,
  );
};

run();
