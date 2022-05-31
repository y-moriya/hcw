import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import winston, {format} from 'winston';

const hatebu_url = 'https://b.hatena.ne.jp';
const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const myFormat = format.printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const logger = winston.createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    myFormat
  ),
  defaultMeta: { service: 'user-service' },
  transports: [
    //
    // - Write all logs with importance level of `error` or less to `error.log`
    // - Write all logs with importance level of `info` or less to `combined.log`
    //
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'hcw.log' }),
    new winston.transports.Console()
  ],
});

// Get bookmarks from hono
const getTargetBookmarks = async () => {
  const response = await fetch(config.hono_api_url + 'bookmarks');
  const json = await response.json();

  if (json.ok) {
    logger.info('getTargetBookmarks succeeded.');
    return json.bookmarks
  } else {
    logger.error('getTargetBookmarks failed.')
  }
}

// Get comments
const crawl = async (bookmark) => {
  const response = await fetch(bookmark.url);
  const body = await response.text();
  const $ = cheerio.load(body);
  const comments = $('.entry-comment-contents');
  const users = [];
  logger.info(`There are ${comments.length} comments (including duplicate)`);

  const result = [];
  for (let c of comments) {
    const el = cheerio.load(c);
    const username = el('.entry-comment-username').text();
    if (users.includes(username)) {
      continue;
    } else {
      users.push(username);
    }
    const avatar_url = el('img').attr('src');
    const comment_content = el('span.entry-comment-text').text();
    const permalink = hatebu_url + el('.entry-comment-permalink > a').attr('href');

    const perma = await fetch(permalink);
    const perma_body = await perma.text();
    const perma_el = cheerio.load(perma_body);
    const date = perma_el('span.comment-body-date > a').text();
    const comment_date = new Date(date);
    await _sleep(1000);
    // last_updated_at = last_updated_at > comment_date ? last_updated_at : comment_date;

    if (comment_date < new Date(bookmark.last_updated_at)) {
      logger.info(`skip this comment: ${username}, ${comment_content}`)
      continue;
    }

    result.push({ username, avatar_url, comment_content, permalink, date });
  }

  return result;
}

const postToDiscord = async (c) => {
  const body = JSON.stringify({
    "username": `${c.username} ${c.date}`,
    "avatar_url": c.avatar_url,
    "content": c.comment_content + "\n" + c.permalink
  });
  logger.info(`send discord: ${body}`);
  const res = await fetch(config.discord_webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: body
  });
  const status = res.status;
  if (status === 204) {
    logger.info('post to discord was succeeded.');
  } else {
    logger.error(`status: ${status}`);
  }
}

const updateBookmark = async (b) => {
  const id = encodeURIComponent(b.url);
  const body = JSON.stringify({ "last_updated_at": b.last_updated_at });
  const res = await fetch(config.hono_api_url + 'bookmarks/' + id, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${config.hono_basic_auth}`,
      'Content-Type': 'application/json'
    },
    body: body
  });
}

const deleteBookmark = async (b) => {
  const id = encodeURIComponent(b.url);
  const res = await fetch(config.hono_api_url + 'bookmarks/' + id, {
    method: 'DELETE',
    headers: {
      'Authorization': `Basic ${config.hono_basic_auth}`
    }
  });
}

// main
const main = async () => {
  const bookmarks = await getTargetBookmarks();
  logger.info(`target bookmarks: ${bookmarks.length}`);
  for (let b of bookmarks) {
    if (!b.last_updated_at) {
      b.last_updated_at = new Date('2022/01/01 00:00');
    }
    let comments = [];
    logger.info('start crawl: ', b.url);
    comments = await crawl(b);
    logger.info('end crawl: ', b.url);
    
    if (comments.length > 0) {
      comments.sort((a, b) => {
        return Date.parse(a.date) - Date.parse(b.date);
      });
      b.last_updated_at = comments[comments.length - 1].date;

      logger.info(`update bookmark, date: ${b.last_updated_at}`);
      await updateBookmark(b);

      for (let c of comments) {
        await postToDiscord(c);
        await _sleep(3000);
      }

    } else {
      logger.info('No new comment.')
      const last_updated_at = new Date(b.last_updated_at);
      const limit_date = new Date(last_updated_at.setDate(last_updated_at.getDate() + config.limit_days));
      if (limit_date < new Date()) {
        logger.info(`Delete bookmark ${b.url} because of over limit date.`)
        await deleteBookmark(b);
      }
    }


  }
}

await main();

