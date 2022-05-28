import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';

const hatebu_url = 'https://b.hatena.ne.jp';
const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Get bookmarks from hono
const getTargetBookmarks = async () => {
  const response = await fetch(config.hono_api_url + 'bookmarks');
  const json = await response.json();

  if (json.ok) {
    console.log('getTargetBookmarks succeeded.');
    return json.bookmarks
  } else {
    console.error('getTargetBookmarks failed.')
  }
}

// Get comments
const crawl = async (bookmark) => {
  let last_updated_at = '2022/01/01 00:00';
  if (bookmark.last_updated_at) {
    last_updated_at = bookmark.last_updated_at;
  }
  const response = await fetch(bookmark.url);
  const body = await response.text();
  const $ = cheerio.load(body);
  const comments = $('.entry-comment-contents');
  const users = [];
  console.log(`There are ${comments.length} comments (including duplicate)`);
  
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
    await _sleep(1000);

    if (Date.parse(date) < Date.parse(last_updated_at)) {
      continue;
    }
  
    result.push({username, avatar_url, comment_content, permalink, date});
    // console.log({username, avatar_url, comment_content, permalink, date});
  }

  return result;
}

const postToDiscord = async (c) => {
  const body = JSON.stringify({
    "username": `${c.username} ${c.date}`,
    "avatar_url": c.avatar_url,
    "content": c.comment_content + "\n" + c.permalink
  });
  console.log('send discord: ', body);
  const res = await fetch(config.discord_webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: body
  });
  const status = res.status;
  if (status === 204) {
    console.log('post to discord was succeeded.');
  } else {
    console.log({status});
  }
}

// TODO: Update bookmark last_updated_at
const updateBookmark = async (b) => {
  const id = encodeURIComponent(b.url);
  const res = await fetch(config.hono_api_url + 'bookmarks/' + id, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${config.hono_basic_auth}`
    }
  });
}

// main
const main = async () => {
  const bookmarks = await getTargetBookmarks();
  console.log('target bookmarks: ', bookmarks.length);
  for (let b of bookmarks) {
    let comments = [];
    console.log('start crawl: ', b.url);
    comments = await crawl(b);
    await updateBookmark(b);
    console.log('end crawl: ', b.url);

    if (comments.length > 0) {
      comments.sort((a, b) => {
        return Date.parse(a.date) - Date.parse(b.date);
      });
  
      for (let c of comments) {
        await postToDiscord(c);
        await _sleep(1000);
      }
      
    } else {
      console.log('No new comment.')
    }
  }
}

await main();