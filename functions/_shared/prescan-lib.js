// Shared helpers for the Arli Audits pre-scan Pages Functions.
// Files/folders prefixed with "_" are excluded from Cloudflare Pages Functions routing,
// so this file is safe to import from functions/api/*.js without becoming its own route.

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Pulls a 10-character Amazon ASIN out of a raw ASIN or a full listing URL.
export function extractAsin(input) {
  if (!input) return null;
  const cleaned = String(input).trim();

  if (/^[A-Z0-9]{10}$/i.test(cleaned)) {
    return cleaned.toUpperCase();
  }

  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/product\/([A-Z0-9]{10})/i,
    /[?&]asin=([A-Z0-9]{10})/i,
    /\/([A-Z0-9]{10})(?:[/?]|$)/i,
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

export function marketplaceToDomain(marketplace) {
  const map = {
    'amazon.com': 'amazon.com',
    'amazon.co.uk': 'amazon.co.uk',
    'amazon.ca': 'amazon.ca',
    'amazon.de': 'amazon.de',
    'amazon.com.au': 'amazon.com.au',
  };
  return map[marketplace] || 'amazon.com';
}

// Fully automated, rules-based structural pre-scan of a public Amazon listing page.
// No LLM call — this needs to return in a few seconds and cost nothing per request.
// Never fabricates a finding: if the fetch fails or looks blocked, it says so honestly
// instead of inventing numbers.
export async function runPrescan(asin, marketplace) {
  const domain = marketplaceToDomain(marketplace);
  const url = `https://www.${domain}/dp/${asin}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let resp;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });
  } catch (e) {
    clearTimeout(timeout);
    return { status: 'unavailable', reason: 'fetch_failed' };
  }
  clearTimeout(timeout);

  if (!resp.ok) {
    return { status: 'unavailable', http_status: resp.status };
  }

  let titleText = '';
  let ratingAttr = '';
  let reviewText = '';
  let bulletCount = 0;
  let imageCount = 0;
  let aplus = false;
  let addToCart = false;
  let outOfStock = false;

  const rewriter = new HTMLRewriter()
    .on('span#productTitle', { text(t) { titleText += t.text; } })
    .on('#feature-bullets li', { element() { bulletCount++; } })
    .on('#altImages li.imageThumbnail', { element() { imageCount++; } })
    .on('#acrPopover', {
      element(el) {
        const t = el.getAttribute('title');
        if (t) ratingAttr = t;
      },
    })
    .on('#acrCustomerReviewText', { text(t) { reviewText += t.text; } })
    .on('#aplus', { element() { aplus = true; } })
    .on('#aplus3p_feature_div', { element() { aplus = true; } })
    .on('#add-to-cart-button', { element() { addToCart = true; } })
    .on('#outOfStock', { element() { outOfStock = true; } });

  const transformed = rewriter.transform(resp);
  const html = await transformed.text();

  const lower = html.toLowerCase();
  if (
    lower.includes('enter the characters you see') ||
    lower.includes('robot check') ||
    lower.includes('automated access to amazon data')
  ) {
    return { status: 'blocked' };
  }

  if (!titleText.trim()) {
    return { status: 'unavailable', reason: 'could_not_read_listing' };
  }

  const titleLen = titleText.trim().length;
  const reviewMatch = reviewText.match(/[\d,]+/);
  const reviewCount = reviewMatch ? parseInt(reviewMatch[0].replace(/,/g, ''), 10) : null;
  const ratingMatch = ratingAttr.match(/([\d.]+)\s+out of/i);
  const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

  let score = 100;
  const findings = [];

  if (titleLen < 80) {
    score -= 15;
    findings.push(`Title is short (${titleLen} characters) — there's likely unused keyword room.`);
  } else if (titleLen > 200) {
    score -= 5;
    findings.push(`Title runs long (${titleLen} characters) — worth checking it isn't getting cut off on mobile.`);
  } else {
    findings.push(`Title length (${titleLen} characters) is in a reasonable range.`);
  }

  if (bulletCount < 5) {
    score -= 15;
    findings.push(`Only ${bulletCount} of 5 bullet points are in use — unused space that could be selling.`);
  } else {
    findings.push(`All 5 bullet points are in use.`);
  }

  if (imageCount > 0 && imageCount < 5) {
    score -= 10;
    findings.push(`${imageCount} images detected — most well-optimized listings use 6-9.`);
  } else if (imageCount >= 5) {
    findings.push(`${imageCount} images detected — solid image count.`);
  }

  if (!aplus) {
    score -= 15;
    findings.push(`No A+ Content detected — this is usually one of the highest-leverage gaps to fix.`);
  } else {
    findings.push(`A+ Content is present.`);
  }

  if (rating !== null) {
    if (rating < 4.0) {
      score -= 10;
      findings.push(`Star rating is ${rating} — below the 4.0+ range shoppers tend to trust.`);
    } else {
      findings.push(`Star rating is ${rating} — healthy.`);
    }
  }

  if (reviewCount !== null && reviewCount < 20) {
    score -= 5;
    findings.push(`Only ${reviewCount} reviews — a low review count can suppress conversion.`);
  }

  if (outOfStock || !addToCart) {
    score -= 10;
    findings.push(`Buy Box / Add to Cart didn't appear active on this fetch — worth double-checking availability.`);
  }

  score = Math.max(5, Math.min(100, score));

  return {
    status: 'ok',
    score,
    findings: findings.slice(0, 6),
    signals: { titleLen, bulletCount, imageCount, aplus, rating, reviewCount },
  };
}
