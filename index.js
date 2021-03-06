import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import winston, {format} from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const hatebu_url = 'https://b.hatena.ne.jp';
const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const timezoned = () => {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
const myFormat = format.printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

// def logger
const logger = winston.createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: timezoned }),
    myFormat
  ),
  defaultMeta: { service: 'user-service' },
  transports: [
    //
    // - Write all logs with importance level of `error` or less to `error.log`
    // - Write all logs with importance level of `info` or less to `combined.log`
    //
    new winston.transports.File({ filename: 'log/error.log', level: 'error' }),
    new DailyRotateFile({ filename: 'log/hcw.log', datePattern: 'yyyy-MM-DD', maxFiles: '7d' }),
    new winston.transports.Console()
  ],
});

// Get bookmarks from rails
const getTargetBookmarks = async () => {
  const response = await fetch(config.rails_api_url + 'bookmarks');
  const json = await response.json();

  if (json) {
    logger.info('getTargetBookmarks succeeded.');
    return json
  } else {
    logger.error('getTargetBookmarks failed.')
  }
}

const getBookmarkUrl = (url) => {
  const m = url.match(/http(s?):\/\/(.+)/);
  if (m[1] === 's') {
    return `${hatebu_url}/entry/s/${m[2]}`;
  } else {
    return `${hatebu_url}/entry/${m[2]}`;
  }
}

// Get comments
const crawl = async (bookmark, ignores) => {
  const url = getBookmarkUrl(bookmark.url);
  bookmark.b_url = url;
  logger.info(`start crawl: ${url}`);
  const response = await fetch(url);
  const body = await response.text();
  const $ = cheerio.load(body);
  const comments = $('.entry-comment-contents');
  logger.info(`There are ${comments.length} comments (including duplicate)`);

  const result = [];
  for (let c of comments) {
    const el = cheerio.load(c);
    const username = el('.entry-comment-username').text().trim();
    if (ignores.includes(username)) {
      logger.info(`skip ignore comment: ${username}`);
      continue;
    } else if (bookmark.users.includes(username)) {
      logger.info(`skip posted comment: ${username}`);
      continue;
    } else {
      bookmark.users.push(username);
    }
    const avatar_url = el('img').attr('src');
    const comment_content = el('span.entry-comment-text').text();
    const permalink = hatebu_url + el('.entry-comment-permalink > a').attr('href');

    try {
      const perma = await fetch(permalink);
      const perma_body = await perma.text();
      const perma_el = cheerio.load(perma_body);
      const date = perma_el('span.comment-body-date > a').text();
      const comment_date = new Date(date);
      await _sleep(1000);
  
      if (comment_date <= new Date(bookmark.updated_at)) {
        logger.info(`skip old comment: ${permalink}`)
        continue;
      }
  
      result.push({ username, avatar_url, comment_content, permalink, date });
      
    } catch (error) {
      logger.error(`unexpected error occurred, username: ${username}`);
      logger.error(error);
    }
  }

  logger.info(`end crawl: ${url}, ${result.length} comments were found.`);
  return result;
}

const postToDiscord = async (c, thread_id) => {
  const params = { thread_id: thread_id };
  const query_params = new URLSearchParams(params);
  const url = config.discord_webhook_url + query_params;
  const body = JSON.stringify({
    "username": `${c.username}`,
    "avatar_url": c.avatar_url,
    "content": c.comment_content
  });
  logger.info(`send discord: ${body}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: body
  });
  const status = res.status;
  if (status === 204) {
    logger.info(`post to discord ${c.permalink} was succeeded.`);
  } else {
    logger.error(`post to discord ${c.permalink} was failed, status: ${status}`);
  }
}

const updateBookmark = async (b) => {
  logger.info(`update bookmark`);
  const body = JSON.stringify({"url": b.url, "users": b.users, "b_url": b.b_url });
  const res = await fetch(config.rails_api_url + 'bookmarks/update', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: body
  });
  const status = res.status;
  if (status === 200) {
    logger.info(`update bookmark ${b.url} was succeeded.`);
  } else {
    logger.info(`update bookmark was failed, status: ${status}`);
  }
}

const deleteBookmark = async (b) => {
  const body = JSON.stringify({"url": b.url});
  const res = await fetch(config.rails_api_url + 'bookmarks/destroy', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json'
    },
    body: body
  });
  const status = res.status;
  if (status === 204) {
    logger.info(`delete bookmark ${b.url} was succeeded.`);
  } else {
    logger.info(`delete bookmark was failed, status: ${status}`);
  }
}

const getIgnores = async () => {
  const response = await fetch(config.rails_api_url + 'ignores');
  const json = await response.json();

  if (json) {
    logger.info('getIgnores succeeded.');
    return json
  } else {
    logger.error('getIgnores failed.')
  }
}

// main
const main = async () => {
  logger.info('start main.');
  const bookmarks = await getTargetBookmarks();
  const ignores = await getIgnores();
  logger.info(`target bookmarks: ${bookmarks.length}`);
  for (let b of bookmarks) {
    if (!b.users) {
      b.users = [];
    }
    let comments = [];

    // b.updated_at ??????????????????????????????
    comments = await crawl(b, ignores);
    
    if (comments.length > 0) {
      logger.info(`${comments.length} comments to post.`);

      // ?????????????????????????????????????????????????????????
      comments.sort((a, b) => {
        return Date.parse(a.date) - Date.parse(b.date);
      });

      await updateBookmark(b);

      // ?????????????????? discord ??? post
      for (let c of comments) {
        await postToDiscord(c, b.thread_id);
        await _sleep(3000);
      }

    } else {
      // ?????????????????????????????????????????????
      logger.info('No new comment.')

      // users ???????????????????????? update ??????
      await updateBookmark(b);

      // ????????????????????????????????????????????????
      // config.limit_days ?????????????????????????????????bookmark???????????????
      const updated_at = new Date(b.updated_at);
      const limit_date = new Date(updated_at.setDate(updated_at.getDate() + config.limit_days));
      if (limit_date < new Date()) {
        logger.info(`Delete bookmark ${b.url} because the date of limit is over.`)
        await deleteBookmark(b);
      }
    }

    await _sleep(1000);
  }

  logger.info('end main.');
}

await main();
