import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const hatebu_url = 'https://b.hatena.ne.jp';
const response = await fetch('https://b.hatena.ne.jp/entry/s/xtech.nikkei.com/atcl/nxt/news/18/12937/');
const body = await response.text();
const $ = cheerio.load(body);
const comments = $('.entry-comment-contents');
const users = [];
console.log(`There are ${comments.length} comments (including duplicate)`);

let i = 0;
(Array.from(comments)).forEach(async (c) => {
  const el = cheerio.load(c);
  const username = el('.entry-comment-username').text();
  if (users.includes(username)) {
    return true;
  } else {
    users.push(username);
  }
  const avatar_url = el('img').attr('src');
  const comment_content = el('span.entry-comment-text').text();
  const permalink = el('.entry-comment-permalink > a').attr('href');

  const perma = await fetch(hatebu_url + permalink);
  const perma_body = await perma.text();
  const perma_el = cheerio.load(perma_body);
  const date = perma_el('span.comment-body-date > a').text();

  i++;
  console.log({i, username, avatar_url, comment_content, permalink, date});
})
