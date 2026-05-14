/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_URL =
  'https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts';
const FREESTYLE_REPO_URL =
  'https://github.com/freestylefly/awesome-gpt-image-2';
const REPO_BRANCH = 'main';
const RAW_IMAGE_MARKER = '/main/images/';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const GOOGLE_TRANSLATE_URL =
  'https://translate.googleapis.com/translate_a/single';
const MYMEMORY_TRANSLATE_URL = 'https://api.mymemory.translated.net/get';
const DEFAULT_TRANSLATION_MODEL = 'gpt-5.2';
const TRANSLATION_CACHE_VERSION = 1;

const currentFile = fileURLToPath(import.meta.url);
const webDir = path.resolve(path.dirname(currentFile), '..');
const promptLibraryDir = path.join(
  webDir,
  'src',
  'features',
  'ai-creation',
  'promptLibrary',
);

const outputDataPath = path.join(promptLibraryDir, 'zhCNPromptLibrary.js');
const translationCachePath = path.join(
  promptLibraryDir,
  'translationCache.json',
);
const auditPath = path.join(promptLibraryDir, 'zhCNPromptLibrary.audit.json');
const imageOverrideRoot = path.join(promptLibraryDir, 'imageOverrides');
const outputAssetRoot = path.join(promptLibraryDir, 'assets');

const categories = [
  { key: 'ecommerce', label: '电商', file: 'ecommerce_zh-CN.md' },
  { key: 'ad-creative', label: '广告创意', file: 'ad-creative_zh-CN.md' },
  { key: 'portrait', label: '人像摄影', file: 'portrait_zh-CN.md' },
  { key: 'poster', label: '海报插画', file: 'poster_zh-CN.md' },
  { key: 'character', label: '角色设计', file: 'character_zh-CN.md' },
  { key: 'ui', label: 'UI / 社交媒体', file: 'ui_zh-CN.md' },
  { key: 'comparison', label: '对比案例', file: 'comparison_zh-CN.md' },
];

const freestyleCategoryMap = {
  'Architecture & Spaces': 'poster',
  'Brand & Logos': 'ad-creative',
  'Characters & People': 'character',
  'Charts & Infographics': 'ui',
  'Documents & Publishing': 'ui',
  'History & Classical Themes': 'poster',
  'Illustration & Art': 'poster',
  'Other Use Cases': 'comparison',
  'Photography & Realism': 'portrait',
  'Posters & Typography': 'poster',
  'Products & E-commerce': 'ecommerce',
  'Scenes & Storytelling': 'poster',
  'UI & Interfaces': 'ui',
};

const categoryByKey = new Map(
  categories.map((category) => [category.key, category]),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cloneRepo({ repoUrl, tmpPrefix }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const repoDir = path.join(tmpDir, 'repo');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
      execFileSync('git', ['clone', '--depth', '1', repoUrl, repoDir], {
        stdio: 'inherit',
      });
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(
        `Clone failed for ${repoUrl}, retrying (${attempt + 1}/3)...`,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }

  return {
    repoDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function resolveEvoLinkRepo() {
  const override = process.env.GPT_IMAGE_PROMPT_LIBRARY_REPO;
  if (override) {
    const repoDir = path.resolve(override);
    assertEvoLinkRepo(repoDir);
    return { repoDir, cleanup: null };
  }

  const source = cloneRepo({
    repoUrl: REPO_URL,
    tmpPrefix: 'gpt-image-prompts-',
  });
  assertEvoLinkRepo(source.repoDir);
  return source;
}

function resolveFreestyleRepo() {
  const override = process.env.GPT_IMAGE_FREESTYLE_LIBRARY_REPO;
  if (override) {
    const repoDir = path.resolve(override);
    assertFreestyleRepo(repoDir);
    return { repoDir, cleanup: null };
  }

  const source = cloneRepo({
    repoUrl: FREESTYLE_REPO_URL,
    tmpPrefix: 'freestyle-gpt-image-prompts-',
  });
  assertFreestyleRepo(source.repoDir);
  return source;
}

function assertEvoLinkRepo(repoDir) {
  for (const category of categories) {
    const casePath = path.join(repoDir, 'cases', category.file);
    if (!fs.existsSync(casePath)) {
      throw new Error(`Missing upstream case file: ${casePath}`);
    }
  }
  const imageDir = path.join(repoDir, 'images');
  if (!fs.existsSync(imageDir)) {
    throw new Error(`Missing upstream images directory: ${imageDir}`);
  }
}

function assertFreestyleRepo(repoDir) {
  const casesPath = path.join(repoDir, 'data', 'cases.json');
  if (!fs.existsSync(casesPath)) {
    throw new Error(`Missing freestyle cases data: ${casesPath}`);
  }
  const imageDir = path.join(repoDir, 'data', 'images');
  if (!fs.existsSync(imageDir)) {
    throw new Error(`Missing freestyle images directory: ${imageDir}`);
  }
}

function getGitRevision(repoDir) {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function parseCaseFile(repoDir, category) {
  const relativeCasePath = path.posix.join('cases', category.file);
  const sourcePath = path.join(repoDir, 'cases', category.file);
  const markdown = fs.readFileSync(sourcePath, 'utf8');
  const casePattern = /^### Case\s+(\d+):\s+(.+)$/gm;
  const matches = [...markdown.matchAll(casePattern)];

  return matches.map((match, index) => {
    const blockStart = match.index ?? 0;
    const blockEnd = matches[index + 1]?.index ?? markdown.length;
    const block = markdown.slice(blockStart, blockEnd);
    const caseNo = Number.parseInt(match[1], 10);
    const header = parseCaseHeader(match[2]);
    const imageSourceUrl = extractImageUrl(block);
    const imageRelativePath = getImageRelativePath(imageSourceUrl);
    const rawPrompt = extractPrompt(block);
    const sourceLine = getLineNumber(markdown, blockStart);

    return {
      id: `${category.key}-case-${caseNo}`,
      caseNo,
      category: category.key,
      categoryLabel: category.label,
      title: createDisplayTitle(category.label, caseNo, header.title),
      sourceName: 'EvoLinkAI',
      originalTitle: header.title,
      rawPrompt,
      imageRelativePath,
      imageRoot: 'images',
      sourceUrl: `${REPO_URL}/blob/${REPO_BRANCH}/${relativeCasePath}#L${sourceLine}`,
      author: header.author,
      authorUrl: header.authorUrl,
      originalUrl: header.originalUrl,
      tags: [category.label, `Case ${caseNo}`],
    };
  });
}

function parseFreestyleCases(repoDir) {
  const dataPath = path.join(repoDir, 'data', 'cases.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const items = Array.isArray(data.cases) ? data.cases : [];

  return items
    .map((item) => {
      const categoryKey = freestyleCategoryMap[item.category];
      const category = categoryByKey.get(categoryKey);
      if (!category) return null;

      const caseNo = Number.parseInt(item.id, 10);
      const imageRelativePath = String(item.image || '')
        .replace(/^\/+/, '')
        .replace(/^images\//, '');

      return {
        id: `freestyle-${category.key}-case-${caseNo}`,
        caseNo,
        category: category.key,
        categoryLabel: category.label,
        title: createDisplayTitle(category.label, caseNo, item.title),
        sourceName: 'freestylefly',
        originalTitle: normalizeWhitespace(item.title),
        rawPrompt: normalizePrompt(item.prompt || ''),
        imageRelativePath,
        imageRoot: 'data/images',
        sourceCategory: item.category || '',
        sourceStyles: Array.isArray(item.styles) ? item.styles : [],
        sourceScenes: Array.isArray(item.scenes) ? item.scenes : [],
        sourceUrl:
          item.githubUrl ||
          `${FREESTYLE_REPO_URL}/blob/${REPO_BRANCH}/data/cases.json`,
        author: normalizeAuthor(item.sourceLabel),
        authorUrl: item.sourceUrl || '',
        originalUrl: item.sourceUrl || '',
        tags: [category.label, `Case ${caseNo}`, 'freestylefly'],
      };
    })
    .filter(Boolean);
}

function parseCaseHeader(headerText) {
  const linkedHeader = headerText.match(
    /^\[(.+?)\]\((.+?)\)(?:\s+\(by\s+\[(.+?)\]\((.+?)\)\))?/,
  );
  if (!linkedHeader) {
    return {
      title: normalizeWhitespace(headerText),
      originalUrl: '',
      author: '',
      authorUrl: '',
    };
  }

  return {
    title: normalizeWhitespace(linkedHeader[1]),
    originalUrl: linkedHeader[2]?.trim() || '',
    author: normalizeAuthor(linkedHeader[3]),
    authorUrl: linkedHeader[4]?.trim() || '',
  };
}

function createDisplayTitle(categoryLabel, caseNo, originalTitle) {
  const title = normalizeWhitespace(originalTitle);
  if (isReadableChineseTitle(title) && !looksJsonPrompt(title)) return title;
  return `${categoryLabel}妗堜緥 ${caseNo}`;
}

function normalizeWhitespace(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeAuthor(value = '') {
  return normalizeWhitespace(value).replace(/^@/, '');
}

function getLineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function extractImageUrl(block) {
  return block.match(/<img\s+[^>]*src="([^"]+)"/i)?.[1]?.trim() || '';
}

function getImageRelativePath(imageUrl) {
  if (!imageUrl) return '';
  const markerIndex = imageUrl.indexOf(RAW_IMAGE_MARKER);
  if (markerIndex >= 0) {
    return imageUrl.slice(markerIndex + RAW_IMAGE_MARKER.length);
  }
  const imagesIndex = imageUrl.indexOf('/images/');
  if (imagesIndex >= 0) {
    return imageUrl.slice(imagesIndex + '/images/'.length);
  }
  return imageUrl.replace(/^images\//, '');
}

function extractPrompt(block) {
  const promptMarker = block.match(
    /\*\*(?:[\u63d0\u793a\u8bcd]+|Prompt)\s*[:\uff1a]\*\*/i,
  );
  const promptSection = promptMarker
    ? block.slice((promptMarker.index ?? 0) + promptMarker[0].length)
    : block;
  const fencedBlocks = [
    ...promptSection.matchAll(/```(?:[\w-]+)?\r?\n([\s\S]*?)```/g),
  ]
    .map((match) => match[1].trim())
    .filter(Boolean);

  if (fencedBlocks.length > 0) {
    return normalizePrompt(fencedBlocks.join('\n\n'));
  }

  if (!promptMarker) return '';
  return normalizePrompt(
    promptSection
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('|') && !line.startsWith('<'))
      .join('\n'),
  );
}

function normalizePrompt(prompt = '') {
  return String(prompt)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasMeaningfulChinese(value = '') {
  const cjkMatches = String(value).match(/[\u3400-\u9fff\uf900-\ufaff]/gu);
  return (cjkMatches?.length || 0) >= 6;
}

function getCjkCount(value = '') {
  return String(value).match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length || 0;
}

function getLatinLetterCount(value = '') {
  return String(value).match(/[A-Za-z]/g)?.length || 0;
}

function hasJapaneseKana(value = '') {
  return /[\u3040-\u30ff]/u.test(String(value));
}

function isCleanChinesePrompt(value = '') {
  const prompt = String(value);
  const cjkCount = getCjkCount(prompt);
  if (cjkCount < 6 || hasJapaneseKana(prompt)) return false;

  const latinRatio = getLatinLetterCount(prompt) / Math.max(1, cjkCount);
  return latinRatio <= 0.3;
}

function isReadableChineseTitle(value = '') {
  const title = String(value);
  return getCjkCount(title) >= 2 && !hasJapaneseKana(title);
}

function looksJsonPrompt(value = '') {
  const prompt = String(value).trim();
  if (!prompt || !/^[{[]/.test(prompt)) return false;
  try {
    JSON.parse(prompt);
    return true;
  } catch {
    return (
      /^[{[][\s\S]*["'][\w-]+["']\s*:/.test(prompt) ||
      /^[{[][\s\S]*(positive_prompt|negative_prompt|prompt|description)/i.test(
        prompt,
      )
    );
  }
}

function getPromptHash(prompt) {
  return crypto.createHash('sha256').update(prompt).digest('hex');
}

function loadTranslationCache() {
  if (!fs.existsSync(translationCachePath)) {
    return { version: TRANSLATION_CACHE_VERSION, entries: {} };
  }
  const cache = JSON.parse(fs.readFileSync(translationCachePath, 'utf8'));
  return {
    version: TRANSLATION_CACHE_VERSION,
    entries: cache.entries || {},
  };
}

function writeTranslationCache(cache) {
  fs.mkdirSync(path.dirname(translationCachePath), { recursive: true });
  fs.writeFileSync(
    translationCachePath,
    `${JSON.stringify(
      { version: TRANSLATION_CACHE_VERSION, entries: cache.entries },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function translatePromptIfNeeded(rawPrompt, cache, audit) {
  const prompt = normalizePrompt(rawPrompt);
  if (isCleanChinesePrompt(prompt)) {
    return { prompt, status: 'source-zh' };
  }

  const embeddedChinesePrompt = extractEmbeddedChinesePrompt(prompt);
  if (embeddedChinesePrompt && isCleanChinesePrompt(embeddedChinesePrompt)) {
    return { prompt: embeddedChinesePrompt, status: 'source-zh-extracted' };
  }

  const hash = getPromptHash(prompt);
  const cached = cache.entries[hash];
  if (
    cached?.translatedPrompt &&
    isCleanChinesePrompt(cached.translatedPrompt)
  ) {
    return {
      prompt: normalizePrompt(cached.translatedPrompt),
      status: 'translated-cache',
    };
  }

  if (
    !process.env.OPENAI_API_KEY &&
    !process.env.PROMPT_LIBRARY_TRANSLATION_PROVIDER
  ) {
    return { prompt: '', status: 'missing-api-key' };
  }

  const translatedPrompt = await translatePrompt(prompt);
  if (
    !isCleanChinesePrompt(translatedPrompt) ||
    looksJsonPrompt(translatedPrompt)
  ) {
    audit.skipped.translationInvalid += 1;
    return { prompt: '', status: 'translation-invalid' };
  }

  cache.entries[hash] = {
    sourceHash: hash,
    translatedPrompt,
    translatedAt: new Date().toISOString(),
    provider: getTranslationProvider(),
    model: getTranslationModel(),
  };
  writeTranslationCache(cache);
  audit.translated += 1;
  return {
    prompt: translatedPrompt,
    status: `translated-${getTranslationProvider()}`,
  };
}

function createDerivedChinesePrompt(rawCase) {
  if (!isReadableChineseTitle(rawCase.originalTitle)) return '';

  return normalizePrompt(
    [
      `基于参考图创作「${rawCase.originalTitle}」主题的高质量图像。`,
      `画面需要紧扣「${rawCase.originalTitle}」和「${rawCase.categoryLabel}」的视觉方向，主体清晰，构图完整，风格统一，细节丰富。`,
      `请保持商业级成片质感，强化光影、材质、色彩层次和空间关系，让图像适合直接作为${rawCase.categoryLabel}案例展示。`,
      '避免无关文字、水印、错别字、变形人物、杂乱背景和低清晰度细节。',
    ].join('\n'),
  );
}

function extractEmbeddedChinesePrompt(prompt) {
  const blocks = [
    prompt.match(/\[中文\]\s*([\s\S]*?)(?=\n\s*\[(?:English|英文)\]|$)/i)?.[1],
    prompt.match(
      /(?:^|\n)\s*中文\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:English|英文)\s*[:：]|$)/i,
    )?.[1],
    prompt.match(
      /(?:^|\n)\s*Chinese\s*[:：]\s*([\s\S]*?)(?=\n\s*English\s*[:：]|$)/i,
    )?.[1],
  ].filter(Boolean);

  return blocks
    .map((block) => normalizePrompt(block))
    .find((block) => isCleanChinesePrompt(block));
}

async function translatePrompt(prompt) {
  const provider = getTranslationProvider();
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAI translation.');
    }
    return translatePromptWithOpenAI(prompt, apiKey);
  }

  return translatePromptWithGoogle(prompt);
}

async function translatePromptWithOpenAI(prompt, apiKey) {
  const payload = {
    model: getTranslationModel(),
    instructions:
      '你是专业的图像生成提示词本地化编辑。把用户提供的英文图像生成提示词翻译成自然、准确、可直接用于图像生成的简体中文。保留品牌名、参数占位符、比例、镜头、风格和技术术语；不要输出 JSON、Markdown、解释或前后缀。',
    input: prompt,
    max_output_tokens: 1600,
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      const translated = extractResponseText(body);
      if (!translated) {
        throw new Error('OpenAI translation response did not include text.');
      }
      return normalizePrompt(translated);
    }

    if (
      [408, 429, 500, 502, 503, 504].includes(response.status) &&
      attempt < 3
    ) {
      await sleep(1000 * attempt);
      continue;
    }

    const message = body?.error?.message || response.statusText;
    throw new Error(
      `OpenAI translation failed (${response.status}): ${message}`,
    );
  }

  throw new Error('OpenAI translation failed after retries.');
}

function getTranslationModel() {
  return process.env.OPENAI_TRANSLATION_MODEL || DEFAULT_TRANSLATION_MODEL;
}

function getTranslationProvider() {
  if (process.env.PROMPT_LIBRARY_TRANSLATION_PROVIDER) {
    return process.env.PROMPT_LIBRARY_TRANSLATION_PROVIDER;
  }
  return process.env.OPENAI_API_KEY ? 'openai' : 'google';
}

async function translatePromptWithGoogle(prompt) {
  const chunks = splitPromptForTranslation(prompt);
  const translatedChunks = [];

  for (const chunk of chunks) {
    translatedChunks.push(await translateGoogleChunk(chunk));
    await sleep(500);
  }

  return normalizePrompt(translatedChunks.join('\n\n'));
}

async function translateGoogleChunk(chunk) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const params = new URLSearchParams({
        client: 'gtx',
        sl: 'auto',
        tl: 'zh-CN',
        dt: 't',
        q: chunk,
      });
      const response = await fetch(GOOGLE_TRANSLATE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: params,
      });
      if (!response.ok) {
        throw new Error(`${response.status}: ${response.statusText}`);
      }
      const body = await response.json();
      return extractGoogleTranslateText(body);
    } catch (error) {
      if (chunk.length > 1200 && attempt === 3) {
        const smallerChunks = splitLongText(chunk, 1000);
        const translated = [];
        for (const smallerChunk of smallerChunks) {
          translated.push(await translateGoogleChunk(smallerChunk));
          await sleep(500);
        }
        return translated.join('\n');
      }
      if (attempt >= 3) {
        return translateWithMyMemory(chunk);
      }
      const isRateLimited = String(error.message).includes('429');
      await sleep(isRateLimited ? 30000 * attempt : 1000 * attempt);
    }
  }

  return '';
}

async function translateWithMyMemory(text) {
  if (text.length > 450) {
    const chunks = splitLongText(text, 430);
    const translated = [];
    for (const chunk of chunks) {
      translated.push(await translateWithMyMemory(chunk));
      await sleep(500);
    }
    return translated.join('\n');
  }

  const params = new URLSearchParams({
    q: text,
    langpair: 'en|zh-CN',
  });
  const response = await fetch(`${MYMEMORY_TRANSLATE_URL}?${params}`);
  if (!response.ok) {
    throw new Error(
      `MyMemory translation failed (${response.status}): ${response.statusText}`,
    );
  }
  const body = await response.json();
  const translated = body?.responseData?.translatedText || '';
  if (
    !translated ||
    /MYMEMORY WARNING|INVALID EMAIL|QUERY LENGTH/i.test(translated)
  ) {
    throw new Error(`MyMemory translation failed: ${translated || 'empty'}`);
  }
  return normalizePrompt(translated);
}

function splitPromptForTranslation(prompt) {
  const normalized = normalizePrompt(prompt);
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length > 4500) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitLongText(paragraph, 4500));
      continue;
    }

    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > 4500) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function splitLongText(text, maxLength) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxLength) {
    let splitAt = rest.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength * 0.5) splitAt = rest.lastIndexOf('. ', maxLength);
    if (splitAt < maxLength * 0.5) splitAt = maxLength;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function extractGoogleTranslateText(body) {
  return (body?.[0] || [])
    .map((part) => part?.[0] || '')
    .join('')
    .trim();
}

function extractResponseText(response) {
  if (typeof response.output_text === 'string') {
    return response.output_text;
  }

  return (response.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function copyCaseImage({
  repoDir,
  categoryKey,
  caseNo,
  imageRelativePath,
  imageRoot = 'images',
  targetCasePrefix = 'case',
  overrideId = '',
}) {
  if (!imageRelativePath) return '';
  const targetCaseId = `${targetCasePrefix}-${caseNo}`;

  const overridePath = overrideId
    ? path.join(imageOverrideRoot, `${overrideId}.png`)
    : '';
  if (overridePath && fs.existsSync(overridePath)) {
    const targetDir = path.join(outputAssetRoot, categoryKey, targetCaseId);
    const imageName = `${overrideId}.png`;
    const targetPath = path.join(targetDir, imageName);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(overridePath, targetPath);
    return createLocalImageAsset({
      targetPath,
      categoryKey,
      targetCaseId,
      imageName,
    });
  }

  const sourcePath = path.join(
    repoDir,
    ...imageRoot.split('/'),
    ...imageRelativePath.split('/'),
  );
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing upstream image: ${sourcePath}`);
  }

  const imageName = path.posix.basename(imageRelativePath) || 'output.jpg';
  const targetDir = path.join(outputAssetRoot, categoryKey, targetCaseId);
  const targetPath = path.join(targetDir, imageName);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);

  return createLocalImageAsset({
    targetPath,
    categoryKey,
    imageName,
    targetCaseId,
  });
}

function toPosixPath(value) {
  return value.split(path.sep).join(path.posix.sep);
}

function createLocalImageAsset({
  targetPath,
  categoryKey,
  targetCaseId,
  imageName,
}) {
  const relativeToAssetRoot = path.relative(outputAssetRoot, targetPath);
  if (
    !relativeToAssetRoot ||
    relativeToAssetRoot.startsWith('..') ||
    path.isAbsolute(relativeToAssetRoot)
  ) {
    throw new Error(`Invalid prompt library asset target: ${targetPath}`);
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Invalid prompt library image file: ${targetPath}`);
  }

  return {
    assetPath: `./${path.posix.join(
      'assets',
      categoryKey,
      targetCaseId,
      imageName,
    )}`,
    localImagePath: toPosixPath(path.relative(webDir, targetPath)),
    localImageFileSize: stat.size,
  };
}

async function buildPromptItems(rawCases, cache, audit) {
  const items = [];

  for (const rawCase of rawCases) {
    audit.total += 1;
    audit.bySource[rawCase.sourceName].total += 1;
    if (!rawCase.rawPrompt) {
      audit.skipped.missingPrompt += 1;
      audit.bySource[rawCase.sourceName].skipped += 1;
      continue;
    }
    if (!rawCase.imageRelativePath) {
      audit.skipped.missingImage += 1;
      audit.bySource[rawCase.sourceName].skipped += 1;
      continue;
    }
    if (looksJsonPrompt(rawCase.rawPrompt)) {
      audit.skipped.jsonPrompt += 1;
      audit.bySource[rawCase.sourceName].skipped += 1;
      continue;
    }

    let translated;
    try {
      translated = await translatePromptIfNeeded(
        rawCase.rawPrompt,
        cache,
        audit,
      );
    } catch (error) {
      console.warn(`Translation failed for ${rawCase.id}: ${error.message}`);
      translated = { prompt: '', status: 'translation-error' };
    }

    if (!translated.prompt) {
      const derivedPrompt = createDerivedChinesePrompt(rawCase);
      if (derivedPrompt && isCleanChinesePrompt(derivedPrompt)) {
        translated = {
          prompt: derivedPrompt,
          status: 'title-derived-zh',
        };
        audit.derived += 1;
      }
    }

    if (!translated.prompt) {
      if (translated.status === 'missing-api-key') {
        audit.skipped.untranslated += 1;
      }
      audit.bySource[rawCase.sourceName].skipped += 1;
      continue;
    }

    let imageAsset;
    try {
      imageAsset = copyCaseImage({
        repoDir: rawCase.repoDir,
        categoryKey: rawCase.category,
        caseNo: rawCase.caseNo,
        imageRelativePath: rawCase.imageRelativePath,
        imageRoot: rawCase.imageRoot,
        targetCasePrefix:
          rawCase.sourceName === 'freestylefly' ? 'freestyle-case' : 'case',
        overrideId: rawCase.id,
      });
    } catch (error) {
      audit.skipped.imageCopyFailed += 1;
      audit.bySource[rawCase.sourceName].skipped += 1;
      console.warn(`Image copy failed for ${rawCase.id}: ${error.message}`);
      continue;
    }

    if (!imageAsset?.assetPath) {
      audit.skipped.missingImage += 1;
      audit.bySource[rawCase.sourceName].skipped += 1;
      continue;
    }

    audit.localImages.copied += 1;
    audit.localImages.totalBytes += imageAsset.localImageFileSize;
    audit.byCategory[rawCase.category].localImages += 1;

    const upstreamImagePath = path.posix.join(
      rawCase.imageRoot,
      rawCase.imageRelativePath,
    );

    items.push({
      id: rawCase.id,
      caseNo: rawCase.caseNo,
      category: rawCase.category,
      categoryLabel: rawCase.categoryLabel,
      title: rawCase.title,
      prompt: translated.prompt,
      promptLanguage: 'zh-CN',
      translationStatus: translated.status,
      image: imageAsset.assetPath,
      localImagePath: imageAsset.localImagePath,
      localImageFileSize: imageAsset.localImageFileSize,
      sourceUrl: rawCase.sourceUrl,
      sourceName: rawCase.sourceName,
      upstreamImagePath,
      author: rawCase.author,
      authorUrl: rawCase.authorUrl,
      originalUrl: rawCase.originalUrl,
      originalTitle: rawCase.originalTitle,
      tags: rawCase.tags,
    });
    audit.bySource[rawCase.sourceName].emitted += 1;
  }

  return items;
}

function createImageUrlPlaceholder(index) {
  return `__PROMPT_LIBRARY_IMAGE_URL_${index}__`;
}

function writeDataFile({ evoLinkRepoDir, freestyleRepoDir, items, audit }) {
  const itemsWithImagePlaceholders = items.map((item, index) => ({
    ...item,
    image: createImageUrlPlaceholder(index),
  }));
  const source = {
    sources: [
      {
        name: 'EvoLinkAI',
        sourceUrl: REPO_URL,
        zhReadmePath: 'README_zh-CN.md',
        zhCasePattern: 'cases/*_zh-CN.md',
        imageRoot: 'images/',
        syncedFromCommit: getGitRevision(evoLinkRepoDir),
      },
      {
        name: 'freestylefly',
        sourceUrl: FREESTYLE_REPO_URL,
        zhReadmePath: 'README.zh-CN.md',
        dataPath: 'data/cases.json',
        imageRoot: 'data/images/',
        syncedFromCommit: getGitRevision(freestyleRepoDir),
      },
    ],
    itemCount: items.length,
    categories: categories.map(({ key, label, file }) => ({
      key,
      label,
      file,
    })),
    assets: {
      storage: 'feature-local-vite-import',
      root: 'web/src/features/ai-creation/promptLibrary/assets',
      copied: audit.localImages.copied,
      totalBytes: audit.localImages.totalBytes,
    },
    translation: {
      model: getTranslationModel(),
      cachePath:
        'web/src/features/ai-creation/promptLibrary/translationCache.json',
      jsonPolicy: 'skip',
      runtimeNetwork: false,
    },
  };
  const itemsLiteral = toJsLiteral(itemsWithImagePlaceholders).replace(
    /"__PROMPT_LIBRARY_IMAGE_URL_(\d+)__"/g,
    (_, index) =>
      `new URL(${JSON.stringify(items[Number(index)].image)}, import.meta.url).href`,
  );
  const data = `/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

// Generated by web/scripts/sync-gpt-image-prompt-library.mjs.
// Frontend runtime imports this static data only; it never fetches GitHub.

export const PROMPT_LIBRARY_CATEGORIES = ${toJsLiteral(
    categories.map(({ key, label }) => ({ key, label })),
  )};

export const PROMPT_LIBRARY_SOURCE = ${toJsLiteral(source)};

export const IMAGE_PROMPT_LIBRARY_ITEMS = ${itemsLiteral};
`;

  fs.mkdirSync(path.dirname(outputDataPath), { recursive: true });
  fs.writeFileSync(outputDataPath, `${data}\n`, 'utf8');
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
}

function toJsLiteral(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function main() {
  const evoLinkSource = resolveEvoLinkRepo();
  const freestyleSource = resolveFreestyleRepo();
  const cache = loadTranslationCache();
  const audit = {
    generatedAt: new Date().toISOString(),
    total: 0,
    emitted: 0,
    translated: 0,
    derived: 0,
    skipped: {
      missingPrompt: 0,
      missingImage: 0,
      imageCopyFailed: 0,
      jsonPrompt: 0,
      untranslated: 0,
      translationInvalid: 0,
    },
    localImages: {
      copied: 0,
      totalBytes: 0,
    },
    byCategory: Object.fromEntries(
      categories.map((category) => [
        category.key,
        { label: category.label, emitted: 0, localImages: 0 },
      ]),
    ),
    bySource: {
      EvoLinkAI: { total: 0, emitted: 0, skipped: 0 },
      freestylefly: { total: 0, emitted: 0, skipped: 0 },
    },
  };

  try {
    fs.rmSync(outputAssetRoot, { recursive: true, force: true });
    fs.mkdirSync(outputAssetRoot, { recursive: true });

    const evoLinkCases = categories
      .flatMap((category) => parseCaseFile(evoLinkSource.repoDir, category))
      .map((item) => ({ ...item, repoDir: evoLinkSource.repoDir }));
    const freestyleCases = parseFreestyleCases(freestyleSource.repoDir).map(
      (item) => ({ ...item, repoDir: freestyleSource.repoDir }),
    );
    const rawCases = [...evoLinkCases, ...freestyleCases];
    const items = await buildPromptItems(rawCases, cache, audit);
    for (const item of items) {
      audit.byCategory[item.category].emitted += 1;
    }
    audit.emitted = items.length;

    writeTranslationCache(cache);
    writeDataFile({
      evoLinkRepoDir: evoLinkSource.repoDir,
      freestyleRepoDir: freestyleSource.repoDir,
      items,
      audit,
    });
    console.log(
      `Synced ${items.length} Chinese prompt cases into ${path.relative(
        webDir,
        outputDataPath,
      )}`,
    );
    if (!process.env.OPENAI_API_KEY && audit.skipped.untranslated > 0) {
      console.warn(
        `Skipped ${audit.skipped.untranslated} non-Chinese prompts because OPENAI_API_KEY is not set.`,
      );
    }
    if (audit.skipped.jsonPrompt > 0) {
      console.warn(`Skipped ${audit.skipped.jsonPrompt} JSON prompt cases.`);
    }
  } finally {
    evoLinkSource.cleanup?.();
    freestyleSource.cleanup?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
