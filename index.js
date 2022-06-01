import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import winston, {format} from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const hatebu_url = 'https://b.hatena.ne.jp';
const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const myFormat = format.printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

// def logger
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
    new winston.transports.File({ filename: 'log/error.log', level: 'error' }),
    new DailyRotateFile({ filename: 'log/hcw.log', datePattern: 'yyyy-MM-DD' }),
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

const getBookmarkUrl = (url) => {
  const m = url.match(/http(s?):\/\/(.+)/);
  if (m[1] === 's') {
    return `${hatebu_url}/entry/s/${m[2]}`;
  } else {
    return `${hatebu_url}/entry/${m[2]}`;
  }
}

// Get comments
const crawl = async (bookmark) => {
  const url = getBookmarkUrl(bookmark.url)
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
    if (config.ignore.includes(username)) {
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

    const perma = await fetch(permalink);
    const perma_body = await perma.text();
    const perma_el = cheerio.load(perma_body);
    const date = perma_el('span.comment-body-date > a').text();
    const comment_date = new Date(date);
    await _sleep(1000);

    if (comment_date <= new Date(bookmark.last_updated_at)) {
      logger.info(`skip old comment: ${permalink}`)
      continue;
    }

    result.push({ username, avatar_url, comment_content, permalink, date });
  }

  logger.info(`end crawl: ${url}, ${result.length} comments were found.`);
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
    logger.info(`post to discord ${c.permalink} was succeeded.`);
  } else {
    logger.error(`post to discord ${c.permalink} was failed, status: ${status}`);
  }
}

const updateBookmark = async (b) => {
  logger.info(`update bookmark, date: ${b.last_updated_at}`);
  const id = encodeURIComponent(b.url);
  const body = JSON.stringify({ "last_updated_at": b.last_updated_at, "users": b.users });
  const res = await fetch(config.hono_api_url + 'bookmarks/' + id, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${config.hono_basic_auth}`,
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
  const id = encodeURIComponent(b.url);
  const res = await fetch(config.hono_api_url + 'bookmarks/' + id, {
    method: 'DELETE',
    headers: {
      'Authorization': `Basic ${config.hono_basic_auth}`
    }
  });
  const status = res.status;
  if (status === 200) {
    logger.info(`delete bookmark ${b.url} was succeeded.`);
  } else {
    logger.info(`delete bookmark was failed, status: ${status}`);
  }
}

// main
const main = async () => {
  logger.info('start main.');
  const bookmarks = await getTargetBookmarks();
  logger.info(`target bookmarks: ${bookmarks.length}`);
  for (let b of bookmarks) {
    if (!b.last_updated_at) {
      b.last_updated_at = '2022/01/01 00:00';
    }
    if (!b.users) {
      b.users = [];
    }
    let comments = [];

    // b.last_updated_at 以降のコメントを取得
    comments = await crawl(b);
    
    if (comments.length > 0) {
      // 対象のコメントを投稿日時の昇順でソート
      comments.sort((a, b) => {
        return Date.parse(a.date) - Date.parse(b.date);
      });

      // 最後（最新）のコメントの投稿日時を b.last_update_at に設定
      b.last_updated_at = comments[comments.length - 1].date;

      await updateBookmark(b);

      // 各コメントを discord に post
      for (let c of comments) {
        await postToDiscord(c);
        await _sleep(3000);
      }

    } else {
      // 取得したコメントが無かった場合
      logger.info('No new comment.')

      // users を反映させるため一応 update する
      await updateBookmark(b);

      // 最終投稿日時と現在時刻を比較し、
      // config.limit_days 日が経過していた場合はbookmarkを削除する
      const last_updated_at = new Date(b.last_updated_at);
      const limit_date = new Date(last_updated_at.setDate(last_updated_at.getDate() + config.limit_days));
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
