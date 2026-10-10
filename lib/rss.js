const { safeFetch } = require('./safeFetch');

// Reads RSS 2.0, RSS 1.0 (RDF) and Atom feeds. No XML dependency: feeds are
// regular enough to read with a few patterns, the same way lib/youtube.js
// reads YouTube's feed (CodeStandards.md § 1). This is a reader for what
// /rss posts, not a validator — anything it can't make sense of is skipped.

const MAX_ID_LENGTH = 500;

const NAMED_ENTITIES = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
	hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(text) {
	return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code) => {
		if (code[0] === '#') {
			const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : match;
		}
		return NAMED_ENTITIES[code.toLowerCase()] ?? match;
	});
}

// The raw inside of the first <tag>…</tag> (or null), with CDATA unwrapped
// and entities decoded once. For HTML fields, that once gives the HTML back.
function tagContent(block, tag) {
	const name = tag.replace(':', '\\:');
	const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
	if (!match) return null;
	const cdata = match[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
	return cdata ? cdata[1] : decodeEntities(match[1]);
}

// An attribute from the first matching tag, e.g. <media:thumbnail url="…">.
function tagAttribute(block, tag, attribute, where = () => true) {
	const name = tag.replace(':', '\\:');
	for (const [element] of block.matchAll(new RegExp(`<${name}\\s[^>]*>`, 'gi'))) {
		const attributes = Object.fromEntries([...element.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)]
			.map(([, key, , double, single]) => [key.toLowerCase(), decodeEntities(double ?? single ?? '')]));
		if (attributes[attribute] && where(attributes)) return attributes[attribute];
	}
	return null;
}

// HTML (or plain text) to one tidy line of plain text.
function toPlainText(html) {
	if (!html) return '';
	return decodeEntities(html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\s*\/?>|<\/p>/gi, ' ')
		.replace(/<[^>]+>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}

function isWebUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch {
		return false;
	}
}

// Relative links are resolved against the feed's own address.
function absoluteUrl(value, base) {
	if (!value) return null;
	try {
		const url = new URL(value.trim(), base);
		return isWebUrl(url.href) ? url.href : null;
	} catch {
		return null;
	}
}

function parseDate(value) {
	const time = value ? Date.parse(value.trim()) : NaN;
	return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function itemImage(block, summaryHtml, base) {
	const isImage = (attributes) => !attributes.type || attributes.type.startsWith('image/') || attributes.medium === 'image';
	const candidate = tagAttribute(block, 'media:thumbnail', 'url')
		?? tagAttribute(block, 'media:content', 'url', isImage)
		?? tagAttribute(block, 'enclosure', 'url', (attributes) => attributes.type?.startsWith('image/'))
		?? tagAttribute(block, 'itunes:image', 'href')
		?? summaryHtml?.match(/<img\s[^>]*src\s*=\s*["']([^"']+)["']/i)?.[1];
	return absoluteUrl(candidate ? decodeEntities(candidate) : null, base);
}

// Atom links are attributes; prefer rel="alternate" (or no rel at all).
function atomLink(block) {
	return tagAttribute(block, 'link', 'href', (attributes) => !attributes.rel || attributes.rel === 'alternate')
		?? tagAttribute(block, 'link', 'href');
}

function parseItem(block, isAtom, base) {
	const title = toPlainText(tagContent(block, 'title'));
	const link = absoluteUrl(isAtom ? atomLink(block) : (tagContent(block, 'link') ?? atomLink(block)), base);
	const summaryHtml = tagContent(block, 'description') ?? tagContent(block, 'summary')
		?? tagContent(block, 'content:encoded') ?? tagContent(block, 'content') ?? tagContent(block, 'media:description');
	const rawId = tagContent(block, 'guid') ?? tagContent(block, 'id') ?? link ?? title;

	return {
		id: rawId ? rawId.trim().slice(0, MAX_ID_LENGTH) : null,
		title,
		link,
		summary: toPlainText(summaryHtml),
		imageUrl: itemImage(block, summaryHtml, base),
		publishedAt: parseDate(tagContent(block, 'pubDate') ?? tagContent(block, 'dc:date') ?? tagContent(block, 'published') ?? tagContent(block, 'updated')),
	};
}

// Returns { title, link, items } with items oldest first, or throws when the
// text isn't a feed at all.
function parseFeed(xml, feedUrl) {
	const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
	const isRss = /<rss[\s>]/i.test(xml) || /<rdf:RDF[\s>]/i.test(xml);
	if (!isAtom && !isRss) {
		throw new Error("that address isn't an RSS or Atom feed. Look for an \"RSS\" or \"Feed\" link on the site, or try adding /feed or /rss to its address.");
	}

	const itemPattern = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
	const blocks = [...xml.matchAll(itemPattern)].map(([block]) => block);

	// The feed's own title and link sit before its first item.
	const head = blocks.length ? xml.slice(0, xml.indexOf(blocks[0])) : xml;
	const title = toPlainText(tagContent(head, 'title')) || new URL(feedUrl).hostname;
	const link = absoluteUrl(isAtom ? atomLink(head) : (tagContent(head, 'link') ?? atomLink(head)), feedUrl) ?? feedUrl;

	const items = blocks.map((block) => parseItem(block, isAtom, feedUrl)).filter((item) => item.id);

	// Feeds list newest first by convention, but not always. Sort by date when
	// every item has one; otherwise trust the feed's order, reversed.
	if (items.every((item) => item.publishedAt)) {
		items.sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
	} else {
		items.reverse();
	}

	return { title, link, items };
}

// The XML declaration names the encoding for the odd feed that isn't UTF-8.
function decodeBody(buffer) {
	const declared = buffer.toString('latin1', 0, 200).match(/encoding\s*=\s*["']([\w-]+)["']/i)?.[1];
	try {
		return new TextDecoder(declared ?? 'utf-8').decode(buffer);
	} catch {
		return buffer.toString('utf8');
	}
}

async function fetchFeed(url) {
	return parseFeed(decodeBody(await safeFetch(url)), url);
}

module.exports = { fetchFeed, parseFeed, toPlainText, isWebUrl };
