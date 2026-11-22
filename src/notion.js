import { Client } from '@notionhq/client';
import { NotionConverter } from 'notion-to-md';
import fs from 'fs/promises';
import * as path from 'path';
import {
  CONFIG,
  stats,
  log,
  sleep,
  sanitizeFilename,
  ensureDir,
  generateFrontmatter
} from './utils.js';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_API_VERSION = '2025-09-03';

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionConverter(notion);

async function notionFetch(endpoint, options = {}) {
  await sleep(CONFIG.API_DELAY);
  const res = await fetch('https://notion.com' + endpoint, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + NOTION_TOKEN,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error('Notion API ' + res.status + ' on ' + endpoint + ': ' + errBody);
  }
  return res.json();
}

function richTextToMarkdown(richTextArr) {
  if (!Array.isArray(richTextArr)) return '';
  return richTextArr.map(t => {
    let text = t.plain_text || '';
    if (!text) return '';
    const ann = t.annotations || {};
    if (ann.code) text = '`' + text + '`';
    if (ann.bold) text = '**' + text + '**';
    if (ann.italic) text = '*' + text + '*';
    if (ann.strikethrough) text = '~~' + text + '~~';
    if (t.href) text = '[' + text + '](' + t.href + ')';
    return text;
  }).join('');
}

async function fallbackBlocksToMarkdown(blockId, depth = 0) {
  const lines = [];
  const prefix = '  '.repeat(depth);
  let cursor = undefined;

  do {
    const query = cursor ? '?page_size=100&start_cursor=' + encodeURIComponent(cursor) : '?page_size=100';
    const res = await notionFetch('/blocks/' + blockId + '/children' + query);

    for (const block of (res.results || [])) {
      const type = block.type;
      const data = block[type] || {};
      const text = richTextToMarkdown(data.rich_text);

      switch (type) {
        case 'paragraph':
          lines.push(prefix + text);
          lines.push('');
          break;
        case 'heading_1':
          lines.push(prefix + '# ' + text);
          lines.push('');
          break;
        case 'heading_2':
          lines.push(prefix + '## ' + text);
          lines.push('');
          break;
        case 'heading_3':
          lines.push(prefix + '### ' + text);
          lines.push('');
          break;
        case 'bulleted_list_item':
          lines.push(prefix + '- ' + text);
          break;
        case 'numbered_list_item':
          lines.push(prefix + '1. ' + text);
          break;
        case 'to_do':
          lines.push(prefix + '- [' + (data.checked ? 'x' : ' ') + '] ' + text);
          break;
        case 'toggle':
          lines.push(prefix + '> **' + text + '**');
          break;
        case 'quote':
          lines.push(prefix + '> ' + text);
          lines.push('');
          break;
        case 'callout':
          lines.push(prefix + '> 💡 ' + text);
          lines.push('');
          break;
        case 'code':
          lines.push(prefix + '```' + (data.language || ''));
          lines.push(text);
          lines.push(prefix + '```');
          lines.push('');
          break;
        case 'divider':
          lines.push(prefix + '---');
          lines.push('');
          break;
        case 'child_page':
          lines.push(prefix + '- 📄 **[' + (data.title || 'Subpage') + ']**');
          break;
        case 'child_database':
          lines.push(prefix + '- 🗄️ **Database: ' + (data.title || 'Untitled Database') + '** *(exported in subfolder)*');
          break;
        case 'bookmark':
        case 'embed':
        case 'link_preview':
          if (data.url) lines.push(prefix + '[' + data.url + '](' + data.url + ')');
          break;
        case 'image': {
          const url = (data.file && data.file.url) || (data.external && data.external.url) || '';
          if (url) lines.push(prefix + '!(' + url + ')');
          break;
        }
        default:
          if (text) lines.push(prefix + text);
          break;
      }

      if (block.has_children && type !== 'child_page' && type !== 'child_database') {
        const childMd = await fallbackBlocksToMarkdown(block.id, depth + 1);
        if (childMd) lines.push(childMd);
      }
    }

    cursor = res.next_cursor;
  } while (cursor);

  return lines.join('\n');
}

async function queryDatabaseRows(databaseId) {
  const dbInfo = await notionFetch('/databases/' + databaseId);
  const dataSources = dbInfo.data_sources || [];
  const allRows = [];
  const seenRowIds = new Set();

  if (dataSources.length === 0) {
    let cursor = undefined;
    do {
      const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
      const res = await notionFetch('/databases/' + databaseId + '/query', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      for (const row of (res.results || [])) {
        if (!seenRowIds.has(row.id)) {
          seenRowIds.add(row.id);
          allRows.push(row);
        }
      }
      cursor = res.next_cursor;
    } while (cursor);
    return { dbInfo, rows: allRows };
  }

  for (const ds of dataSources) {
    let cursor = undefined;
    do {
      const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
      const res = await notionFetch('/data_sources/' + ds.id + '/query', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      for (const row of (res.results || [])) {
        if (!seenRowIds.has(row.id)) {
          seenRowIds.add(row.id);
          allRows.push(row);
        }
      }
      cursor = res.next_cursor;
    } while (cursor);
  }

  return { dbInfo, rows: allRows };
}

function extractPropertyValue(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      return (prop.title || []).map(t => t.plain_text).join('');
    case 'rich_text':
      return (prop.rich_text || []).map(t => t.plain_text).join('');
    case 'number':
      return prop.number ?? '';
    case 'select':
      return (prop.select && prop.select.name) || '';
    case 'multi_select':
      return (prop.multi_select || []).map(s => s.name).join(', ');
    case 'status':
      return (prop.status && prop.status.name) || '';
    case 'date':
      if (!prop.date) return '';
      return prop.date.end ? (prop.date.start + ' -> ' + prop.date.end) : prop.date.start;
    case 'checkbox':
      return prop.checkbox ? 'Yes' : 'No';
    case 'url':
      return prop.url || '';
    case 'email':
      return prop.email || '';
    case 'phone_number':
      return prop.phone_number || '';
    case 'relation':
      return (prop.relation || []).map(r => r.id).join(', ');
    case 'people':
      return (prop.people || []).map(p => p.name || p.id).join(', ');
    case 'files':
      return (prop.files || []).map(f => f.name || (f.file && f.file.url) || (f.external && f.external.url) || '').join(', ');
    case 'formula':
      return (prop.formula && prop.formula[prop.formula.type]) ?? '';
    case 'rollup':
      if (prop.rollup && prop.rollup.type === 'array') {
        return (prop.rollup.array || []).map(item => extractPropertyValue(item)).join(', ');
      }
      return (prop.rollup && prop.rollup[prop.rollup.type]) ?? '';
    case 'created_time':
      return prop.created_time || '';
    case 'last_edited_time':
      return prop.last_edited_time || '';
    case 'unique_id':
      return prop.unique_id ? ((prop.unique_id.prefix || '') + prop.unique_id.number) : '';
    default:
      return '';
  }
}

export async function getPageTitle(pageId) {
  try {
    const page = await notionFetch('/pages/' + pageId);
    const properties = page.properties || {};
    const titleProp = Object.values(properties).find(prop => prop.type === 'title');

    if (titleProp && titleProp.title && titleProp.title.length > 0) {
      return titleProp.title.map(t => t.plain_text).join('');
    }
    return 'Untitled-' + pageId.substring(0, 8);
  } catch (error) {
    log.error('Failed to retrieve title for ' + pageId + ': ' + error.message);
    return 'Untitled-' + pageId.substring(0, 8);
  }
}

export async function getChildItems(blockId) {
  const childPages = [];
  const childDatabases = [];
  let cursor = undefined;

  try {
    do {
      const query = cursor ? '?page_size=100&start_cursor=' + encodeURIComponent(cursor) : '?page_size=100';
      const response = await notionFetch('/blocks/' + blockId + '/children' + query);

      if (response.results && response.results.length) {
        for (const block of response.results) {
          if (block.type === 'child_page') {
            childPages.push({
              id: block.id,
              title: block.child_page.title || 'Untitled'
            });
          } else if (block.type === 'child_database') {
            childDatabases.push({
              id: block.id,
              title: block.child_database.title || 'Untitled Database'
            });
          } else if (block.has_children) {
            const nested = await getChildItems(block.id);
            childPages.push(...nested.childPages);
            childDatabases.push(...nested.childDatabases);
          }
        }
      }

      cursor = response.next_cursor;
    } while (cursor);

    return { childPages, childDatabases };
  } catch (error) {
    log.error('Failed to retrieve child items for ' + blockId + ': ' + error.message);
    return { childPages: [], childDatabases: [] };
  }
}

export async function convertPageToMarkdown(pageId) {
  try {
    await sleep(CONFIG.API_DELAY);
    const page = await n2m.convert(pageId);
    return page.content;
  } catch (error) {
    log.warn('notion-to-md failed on ' + pageId + ' (' + error.message + '), using 2025-09-03 fallback converter');
    return await fallbackBlocksToMarkdown(pageId);
  }
}

export async function processDatabase(databaseId, dbTitle, parentPath, level) {
const indent = '  '.repeat(level);
try {
log.info(indent + 'Processing Database: "' + dbTitle + '" (' + databaseId + ')');
const { dbInfo, rows } = await queryDatabaseRows(databaseId);
const resolvedTitle =
(dbInfo.title || []).map(t => t.plain_text).join('') || dbTitle || 'Untitled-Database';
const safeName = sanitizeFilename(resolvedTitle);
const dbDir = path.join(parentPath, safeName);
await ensureDir(dbDir);
const columnSet = new Set();
for (const row of rows) {
Object.keys(row.properties || {}).forEach(k => columnSet.add(k));
}
const columns = Array.from(columnSet);
const mdLines = [
generateFrontmatter(resolvedTitle, databaseId, parentPath, level).trimEnd(),
'',
'# ' + resolvedTitle,
'',
'Total rows: ' + rows.length + '',
''
];
const csvRows = [];
if (columns.length > 0) {
const escapeMd = (v) => String(v ?? '').replace(/|/g, '\|').replace(/\r?\n/g, ' ');
const escapeCsv = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
mdLines.push('| ' + columns.map(escapeMd).join(' | ') + ' |');
mdLines.push('| ' + columns.map(() => '---').join(' | ') + ' |');
csvRows.push(columns.map(escapeCsv).join(','));
for (const row of rows) {
const values = columns.map(col => extractPropertyValue(row.properties && row.properties[col]));
mdLines.push('| ' + values.map(escapeMd).join(' | ') + ' |');
csvRows.push(values.map(escapeCsv).join(','));
}
}
await fs.writeFile(path.join(dbDir, safeName + '.md'), mdLines.join('\n') + '\n', 'utf8');
if (csvRows.length > 0) {
await fs.writeFile(path.join(dbDir, safeName + '.csv'), csvRows.join('\n') + '\n', 'utf8');
}
log.success(indent + 'Saved Database (' + rows.length + ' rows): ' + safeName);
stats.pagesProcessed++;
for (const row of rows) {
try {
await processPageRecursively(row.id, dbDir, level + 1);
} catch (rowErr) {
log.error(indent + '  Row page ' + row.id + ' failed: ' + rowErr.message);
stats.errors++;
}
}
} catch (error) {
log.error(indent + 'Failed to process database "' + dbTitle + '" (' + databaseId + '): ' + error.message);
stats.errors++;
}
}
export async function processPage(pageId, parentPath, level) {
const indent = '  '.repeat(level);
try {
log.info(indent + 'Processing: ' + pageId);
const title = await getPageTitle(pageId);
log.debug(indent + 'Title: "' + title + '"');
const markdown = await convertPageToMarkdown(pageId);
const frontmatter = generateFrontmatter(title, pageId, parentPath, level);
const fullMarkdown = frontmatter + markdown;
await ensureDir(parentPath);
const filename = sanitizeFilename(title) + '.md';
const filepath = path.join(parentPath, filename);
await fs.writeFile(filepath, fullMarkdown, 'utf8');
log.success(indent + 'Saved: ' + filename);
stats.pagesProcessed++;
return { title, filename };
} catch (error) {
log.error(indent + 'Failed to process page: ' + error.message);
stats.errors++;
throw error;
}
}
export async function processPageRecursively(pageId, parentPath = CONFIG.OUTPUT_DIR, level = 0) {
const indent = '  '.repeat(level);
try {
const { title } = await processPage(pageId, parentPath, level);
const { childPages, childDatabases } = await getChildItems(pageId);
if (childPages.length > 0 || childDatabases.length > 0) {
log.info(indent + 'Found ' + childPages.length + ' child page(s) and ' + childDatabases.length + ' database(s)');
const childDir = path.join(parentPath, sanitizeFilename(title));
await ensureDir(childDir);
for (const db of childDatabases) {
await processDatabase(db.id, db.title, childDir, level + 1);
}
if (CONFIG.PARALLEL_PROCESSING) {
const childPromises = childPages.map(child =>
processPageRecursively(child.id, childDir, level + 1)
.catch(error => {
log.error(indent + '  Child page ' + child.id + ' failed: ' + error.message);
stats.errors++;
})
);
await Promise.all(childPromises);
} else {
for (const child of childPages) {
try {
await processPageRecursively(child.id, childDir, level + 1);
} catch (error) {
log.error(indent + '  Child page ' + child.id + ' failed: ' + error.message);
stats.errors++;
}
}
}
}
} catch (error) {
log.error(indent + 'Failed to process page tree: ' + error.message);
stats.errors++;
}
}
