//@ts-check

const fs = require('fs');
const http = require('http');
const { URL, parse } = require('url');
const { DEBUG, HEADFUL, CHROME_BIN, PORT } = process.env;

const MAX_REQUESTS = parseInt(process.env.MAX_REQUESTS) || 100;
const RENDER_TIMEOUT = parseInt(process.env.RENDER_TIMEOUT) || 10 * 1000;
const WAIT_TIMEOUT = parseInt(process.env.WAIT_TIMEOUT) || 15 * 1000;
const REQUESTS_TIMEOUT = parseInt(process.env.REQUESTS_TIMEOUT) || 30;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const MAX_CACHE_SIZE = process.env.MAX_CACHE_SIZE || 3000;
const MAX_CACHE_TTL = process.env.MAX_CACHE_TTL || 3 * 24 * 60 * 60 * 1000; // 3 days

const events = require('events');
const emitter = new events.EventEmitter();


var redis = require('redis');
var lru = require('redis-lru');

const puppeteer = require('puppeteer');
const pTimeout = require('p-timeout');


var connection = parse(REDIS_URL);
var client = redis.createClient(parseInt(connection.port, 10), connection.hostname);

var cache = lru(client, {max: MAX_CACHE_SIZE, maxAge: MAX_CACHE_TTL, score: () => 1, increment: true});

// @ts-ignore
const blocked = require('./blocked.json');
const blockedRegExp = new RegExp('(' + blocked.join('|') + ')', 'i');

const truncate = (str, len) => str.length > len ? str.slice(0, len) + '…' : str;

let browser;
let currentRunning = new Map();


require('http').createServer(async (req, res) => {
	const { host } = req.headers;

	if (req.url == '/') {
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'public,max-age=31536000',
		});
		res.end(fs.readFileSync('index.html'));
		return;
	}

	if (req.url == '/favicon.ico') {
		res.writeHead(204);
		res.end();
		return;
	}

	if (req.url == '/status') {
		res.writeHead(200, {
			'content-type': 'application/json',
		});
		res.end(JSON.stringify({
			pages: await cache.keys(),
			process: {
				versions: process.versions,
				memoryUsage: process.memoryUsage(),
			},
		}, null, '\t'));
		return;
	}

	const [_, __, url] = req.url.match(/^\/(screenshot|render|pdf)?\/?(.*)/i) || ['', '', ''];

	if (!url) {
		res.writeHead(400, {
			'content-type': 'text/plain',
		});
		res.end('Something is wrong. Missing URL.');
		return;
	}

	let page, pageURL;
	try {
		if (!/^https?:\/\//i.test(url)) {
			throw new Error('Invalid URL');
		}

		const { origin, hostname, pathname, searchParams } = new URL(url);
		const path = decodeURIComponent(pathname);

		await new Promise((resolve, reject) => {
			const req = http.request({
				method: 'HEAD',
				host: hostname,
				path,
			}, ({ statusCode, headers }) => {
				if (!headers || (statusCode == 200 && !/text\/html/i.test(headers['content-type']))) {
					reject(new Error('Not a HTML page'));
				} else {
					resolve();
				}
			});
			req.on('error', reject);
			req.end();
		});

		pageURL = origin + path;
		let actionDone = false;
		const width = parseInt(searchParams.get('width'), 10) || 1024;
		const height = parseInt(searchParams.get('height'), 10) || 768;

		if (currentRunning.has(pageURL)) {
			const listener = (content) => {
				if (content) {
					res.writeHead(200, {
						'content-type': 'text/html; charset=UTF-8',
						'cache-control': 'public,max-age=31536000',
					});
					res.end(content);
					console.log(`👻 Page ${pageURL} loaded by another request`);
				} else {
					res.writeHead(400, {
						'content-type': 'text/plain',
					});
					res.end('Something is wrong.');
					console.log(`👻 Page ${pageURL} is failed to load by another request`);
				}
			};
			emitter.on(pageURL, listener);
			setTimeout(() => {
				emitter.removeListener(pageURL, listener);
			}, WAIT_TIMEOUT);
			return
		}
		currentRunning.set(pageURL, 1);

		let cachedContent = await cache.get(pageURL);

		if (!cachedContent) {
			if (!browser) {
				console.log('🚀 Launch browser!');
				const config = {
					ignoreHTTPSErrors: true,
					args: [
						'--no-sandbox',
						'--disable-setuid-sandbox',
						'--disable-dev-shm-usage',
						'--enable-features=NetworkService',
						'-—disable-dev-tools',
					],
					devtools: false,
				};
				if (DEBUG) config.dumpio = true;
				if (HEADFUL) {
					config.headless = false;
					config.args.push('--auto-open-devtools-for-tabs');
				}
				if (CHROME_BIN) config.executablePath = CHROME_BIN;
				browser = await puppeteer.launch(config);
			}
			page = await browser.newPage();

			const nowTime = +new Date();
			let reqCount = 0;
			await page.setRequestInterception(true);
			page.on('request', (request) => {
				const url = request.url();
				const method = request.method();
				const resourceType = request.resourceType();

				// Skip data URIs
				if (/^data:/i.test(url)) {
					request.continue();
					return;
				}

				const seconds = (+new Date() - nowTime) / 1000;
				const shortURL = truncate(url, 70);
				const otherResources = /^(manifest|other)$/i.test(resourceType);
				// Abort requests that exceeds 15 seconds
				// Also abort if more than 100 requests
				if (seconds > REQUESTS_TIMEOUT || reqCount > MAX_REQUESTS || actionDone) {
					// console.log(`❌⏳ ${method} ${shortURL}`);
					request.abort();
				} else if (blockedRegExp.test(url) || otherResources) {
					// console.log(`❌ ${method} ${shortURL}`);
					request.abort();
				} else {
					// console.log(`✅ ${method} ${shortURL}`);
					request.continue();
					reqCount++;
				}
			});

			let responseReject;
			const responsePromise = new Promise((_, reject) => {
				responseReject = reject;
			});
			page.on('response', ({ headers }) => {
				const location = headers['location'];
				if (location && location.includes(host)) {
					responseReject(new Error('Possible infinite redirects detected.'));
				}
			});

			await page.setViewport({
				width,
				height,
			});

			console.log('⬇️ Fetching ' + pageURL);
			await Promise.race([
				responsePromise,
				page.goto(pageURL, {
					waitUntil: 'networkidle2',
					timeout: 0,
				})
			]);

			// Pause all media and stop buffering
			page.frames().forEach((frame) => {
				frame.evaluate(() => {
					document.querySelectorAll('video, audio').forEach(m => {
						if (!m) return;
						if (m.pause) m.pause();
						m.preload = 'none';
					});
				});
			});
		} else {
			res.writeHead(200, {
				'content-type': 'text/html; charset=UTF-8',
				'cache-control': 'public,max-age=31536000',
			});
			res.end(cachedContent);
			console.log(`😎 Page ${pageURL} found in cache`);
			emitter.emit(pageURL, cachedContent);
			currentRunning.delete(pageURL);
			return;
		}

		console.log('💥 Perform render');


		const raw = searchParams.get('raw') || false;

		const content = await pTimeout(raw ? page.content() : page.evaluate(() => {
			let content = '';
			if (document.doctype) {
				content = new XMLSerializer().serializeToString(document.doctype);
			}

			const doc = document.documentElement.cloneNode(true);

			// Remove scripts except JSON-LD
			const scripts = doc.querySelectorAll('script:not([type="application/ld+json"])');
			scripts.forEach(s => s.parentNode.removeChild(s));

			// Remove import tags
			const imports = doc.querySelectorAll('link[rel=import]');
			imports.forEach(i => i.parentNode.removeChild(i));

			const { origin, pathname } = location;
			// Inject <base> for loading relative resources
			if (!doc.querySelector('base')) {
				const base = document.createElement('base');
				base.href = origin + pathname;
				doc.querySelector('head').appendChild(base);
			}

			// Try to fix absolute paths
			const absEls = doc.querySelectorAll('link[href^="/"], script[src^="/"], img[src^="/"]');
			absEls.forEach(el => {
				const href = el.getAttribute('href');
				const src = el.getAttribute('src');
				if (src && /^\/[^/]/i.test(src)) {
					el.src = origin + src;
				} else if (href && /^\/[^/]/i.test(href)) {
					el.href = origin + href;
				}
			});

			content += doc.outerHTML;

			// Remove comments
			content = content.replace(/<!--[\s\S]*?-->/g, '');

			return content;
		}), RENDER_TIMEOUT, 'Render timed out');

		res.writeHead(200, {
			'content-type': 'text/html; charset=UTF-8',
			'cache-control': 'public,max-age=31536000',
		});
		res.end(content);

		emitter.emit(pageURL, content);
		currentRunning.delete(pageURL);

		actionDone = true;
		console.log('💥 Done render');

		if (!(await cache.has(pageURL))) {
			await cache.set(pageURL, content);

			// Try to stop all execution
			page.frames().forEach((frame) => {
				frame.evaluate(() => {
					// Clear all timer intervals https://stackoverflow.com/a/6843415/20838
					for (var i = 1; i < 99999; i++) window.clearInterval(i);
					// Disable all XHR requests
					XMLHttpRequest.prototype.send = _ => _;
					// Disable all RAFs
					requestAnimationFrame = _ => _;
				});
			});
		}
		try {
			if (page && page.close){
			  console.log('🗑 Disposing ' + url);
			  page.removeAllListeners();
			  await page.deleteCookie(await page.cookies());
			  await page.close();
			}
	  } catch (e){}
	} catch (e) {
		if (!DEBUG && page) {
			console.error(e);
			console.log('💔 Force close ' + pageURL);
			page.removeAllListeners();
			page.close();
		}
		emitter.emit(pageURL);
		currentRunning.delete(pageURL);

		await cache.del(pageURL);
		const { message = '' } = e;
		res.writeHead(400, {
			'content-type': 'text/plain',
		});
		res.end('Oops. Something is wrong.\n\n' + message);

		// Handle websocket not opened error
		if (/not opened/i.test(message) && browser) {
			console.error('🕸 Web socket failed');
			try {
				browser.close();
				browser = null;
			} catch (err) {
				console.warn(`Chrome could not be killed ${err.message}`);
				browser = null;
			}
		}
	}
}).listen(PORT || 3000);

process.on('SIGINT', () => {
	if (browser) browser.close();
	process.exit();
});

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at:', p, 'reason:', reason);
});