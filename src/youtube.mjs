function decodeXmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const YOUTUBE_BASE_URL = "https://www.youtube.com";
const YOUTUBE_HEADERS = {
  "accept-language": "en-US,en;q=0.9",
  "user-agent": "notebooklm-channel-sync/0.1",
};
const CHANNEL_VIDEOS_FALLBACK_LIMIT = 15;

function stripCdata(value) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function extractTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  if (!match) return null;
  return decodeXmlEntities(stripCdata(match[1].trim()));
}

function extractLinkHref(block) {
  const match = block.match(/<link[^>]+href="([^"]+)"[^>]*\/?>/i);
  return match ? decodeXmlEntities(match[1]) : null;
}

export function parseYouTubeFeed(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const block = match[1];
    const videoId = extractTag(block, "yt:videoId");
    const title = extractTag(block, "title");
    const publishedAt = extractTag(block, "published");
    const videoUrl = extractLinkHref(block);

    if (!videoId || !title || !publishedAt || !videoUrl) {
      return null;
    }

    return {
      videoId,
      title,
      publishedAt,
      videoUrl,
    };
  });

  const channelTitle =
    extractTag(xml, "title") ||
    extractTag(xml, "author") ||
    "";

  return {
    channelTitle,
    videos: entries.filter(Boolean),
  };
}

export function extractChannelIdFromHtml(html) {
  const rssMatch = html.match(
    /https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[\w-]+)/i,
  );
  if (rssMatch) return rssMatch[1];

  const canonicalMatch = html.match(
    /https:\/\/www\.youtube\.com\/channel\/(UC[\w-]+)/i,
  );
  if (canonicalMatch) return canonicalMatch[1];

  const jsonMatch = html.match(/"channelId":"(UC[\w-]+)"/i);
  if (jsonMatch) return jsonMatch[1];

  return null;
}

function extractDocumentTitle(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeXmlEntities(match[1].trim()).replace(/\s*-\s*YouTube\s*$/i, "");
}

function extractYtInitialData(html) {
  const markers = [
    "var ytInitialData = ",
    "window[\"ytInitialData\"] = ",
    "ytInitialData = ",
  ];

  for (const marker of markers) {
    const start = html.indexOf(marker);
    if (start === -1) continue;

    const scriptEnd = html.indexOf("</script>", start);
    if (scriptEnd === -1) continue;

    const jsonText = html
      .slice(start + marker.length, scriptEnd)
      .trim()
      .replace(/;$/, "");

    try {
      return JSON.parse(jsonText);
    } catch {
      continue;
    }
  }

  throw new Error("채널 videos HTML에서 ytInitialData 를 찾지 못했습니다.");
}

function collectVideoRenderers(node, accumulator = []) {
  if (!node || typeof node !== "object") {
    return accumulator;
  }

  if (node.richItemRenderer?.content?.videoRenderer) {
    accumulator.push(node.richItemRenderer.content.videoRenderer);
  }
  if (node.videoRenderer) {
    accumulator.push(node.videoRenderer);
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach((item) => collectVideoRenderers(item, accumulator));
    } else if (value && typeof value === "object") {
      collectVideoRenderers(value, accumulator);
    }
  }

  return accumulator;
}

function parseChannelVideosHtml(html, channelId) {
  const initialData = extractYtInitialData(html);
  const videos = [];
  const seenVideoIds = new Set();

  for (const renderer of collectVideoRenderers(initialData)) {
    const videoId = renderer.videoId;
    const title =
      renderer.title?.runs?.map((part) => part.text).join("") ||
      renderer.title?.simpleText ||
      null;

    if (!videoId || !title || seenVideoIds.has(videoId)) {
      continue;
    }

    seenVideoIds.add(videoId);
    videos.push({
      videoId,
      title: decodeXmlEntities(title),
      videoUrl: `${YOUTUBE_BASE_URL}/watch?v=${videoId}`,
    });

    if (videos.length >= CHANNEL_VIDEOS_FALLBACK_LIMIT) {
      break;
    }
  }

  return {
    channelId,
    channelTitle: extractDocumentTitle(html),
    videos,
  };
}

function extractPublishedAtFromWatchHtml(html) {
  const patterns = [
    /itemprop="datePublished" content="([^"]+)"/i,
    /"publishDate":"([^"]+)"/i,
    /"uploadDate":"([^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function channelIdFromUrl(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const channelIndex = segments.indexOf("channel");
  if (channelIndex !== -1 && segments[channelIndex + 1]) {
    return segments[channelIndex + 1];
  }
  return null;
}

export async function resolveChannelId(config) {
  if (config.youtubeChannelId) {
    return {
      channelId: config.youtubeChannelId,
      resolvedFrom: "env",
    };
  }

  if (!config.youtubeChannelUrl) {
    throw new Error("YOUTUBE_CHANNEL_URL 이 비어 있습니다.");
  }

  const directId = channelIdFromUrl(config.youtubeChannelUrl);
  if (directId) {
    return {
      channelId: directId,
      resolvedFrom: "url",
    };
  }

  const response = await fetch(config.youtubeChannelUrl, {
    redirect: "follow",
    headers: {
      "user-agent": "notebooklm-channel-sync/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(
      `채널 페이지를 불러오지 못했습니다: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  const extracted = extractChannelIdFromHtml(html);
  if (!extracted) {
    throw new Error("채널 HTML에서 channel ID 를 찾지 못했습니다.");
  }

  return {
    channelId: extracted,
    resolvedFrom: "html",
  };
}

async function fetchVideoPublishedAt(videoId) {
  const response = await fetch(`${YOUTUBE_BASE_URL}/watch?v=${videoId}&hl=en`, {
    headers: YOUTUBE_HEADERS,
  });

  if (!response.ok) {
    throw new Error(
      `비디오 ${videoId} 페이지를 불러오지 못했습니다: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  const publishedAt = extractPublishedAtFromWatchHtml(html);
  if (!publishedAt) {
    throw new Error(`비디오 ${videoId} 페이지에서 publish date 를 찾지 못했습니다.`);
  }

  return publishedAt;
}

async function fetchChannelVideosFallback(channelId) {
  const videosUrl = `${YOUTUBE_BASE_URL}/channel/${channelId}/videos?view=0&sort=dd&flow=grid&hl=en`;
  const response = await fetch(videosUrl, {
    headers: YOUTUBE_HEADERS,
  });

  if (!response.ok) {
    throw new Error(
      `채널 videos 페이지를 불러오지 못했습니다: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  const parsed = parseChannelVideosHtml(html, channelId);
  if (parsed.videos.length === 0) {
    throw new Error("채널 videos 페이지에서 비디오를 찾지 못했습니다.");
  }

  const settled = await Promise.allSettled(
    parsed.videos.map(async (video) => ({
      ...video,
      publishedAt: await fetchVideoPublishedAt(video.videoId),
    })),
  );

  const videos = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  if (videos.length === 0) {
    const reasons = settled
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || String(result.reason));
    throw new Error(reasons.join("; "));
  }

  return {
    feedUrl: `${YOUTUBE_BASE_URL}/feeds/videos.xml?channel_id=${channelId}`,
    channelTitle: parsed.channelTitle,
    videos,
    source: "channel-videos-fallback",
  };
}

export async function fetchChannelFeed(channelId) {
  const feedUrl = `${YOUTUBE_BASE_URL}/feeds/videos.xml?channel_id=${channelId}`;
  const response = await fetch(feedUrl, {
    headers: YOUTUBE_HEADERS,
  });

  if (response.ok) {
    const xml = await response.text();
    const parsed = parseYouTubeFeed(xml);
    return {
      feedUrl,
      ...parsed,
    };
  }

  try {
    return await fetchChannelVideosFallback(channelId);
  } catch (fallbackError) {
    throw new Error(
      `YouTube feed 를 불러오지 못했습니다: ${response.status} ${response.statusText}; fallback 실패: ${fallbackError.message}`,
    );
  }
}
