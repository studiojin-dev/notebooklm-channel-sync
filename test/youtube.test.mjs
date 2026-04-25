import test from "node:test";
import assert from "node:assert/strict";
import {
  parseYouTubeFeed,
  extractChannelIdFromHtml,
  fetchChannelFeed,
} from "../src/youtube.mjs";

test("parseYouTubeFeed extracts entries from Atom feed", () => {
  const xml = `
    <feed>
      <title>Example Channel</title>
      <entry>
        <yt:videoId>video-1</yt:videoId>
        <title>First Video</title>
        <published>2026-04-12T12:00:00+00:00</published>
        <link rel="alternate" href="https://www.youtube.com/watch?v=video-1"/>
      </entry>
      <entry>
        <yt:videoId>video-2</yt:videoId>
        <title>Second &amp; Video</title>
        <published>2026-04-10T12:00:00+00:00</published>
        <link rel="alternate" href="https://www.youtube.com/watch?v=video-2"/>
      </entry>
    </feed>
  `;

  const parsed = parseYouTubeFeed(xml);
  assert.equal(parsed.channelTitle, "Example Channel");
  assert.equal(parsed.videos.length, 2);
  assert.deepEqual(parsed.videos[1], {
    videoId: "video-2",
    title: "Second & Video",
    publishedAt: "2026-04-10T12:00:00+00:00",
    videoUrl: "https://www.youtube.com/watch?v=video-2",
  });
});

test("extractChannelIdFromHtml prefers rss feed channel id", () => {
  const html = `
    <html>
      <head>
        <link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890abcdef"/>
      </head>
    </html>
  `;

  assert.equal(
    extractChannelIdFromHtml(html),
    "UC1234567890abcdef",
  );
});

test("fetchChannelFeed falls back to channel videos page when rss feed is unavailable", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, headers: init.headers });

    if (url === "https://www.youtube.com/feeds/videos.xml?channel_id=UC123") {
      return new Response("missing", {
        status: 404,
        statusText: "Not Found",
      });
    }

    if (
      url ===
      "https://www.youtube.com/channel/UC123/videos?view=0&sort=dd&flow=grid&hl=en"
    ) {
      const initialData = {
        contents: [
          {
            richItemRenderer: {
              content: {
                videoRenderer: {
                  videoId: "video-1",
                  title: { runs: [{ text: "First Video" }] },
                },
              },
            },
          },
          {
            richItemRenderer: {
              content: {
                videoRenderer: {
                  videoId: "video-1",
                  title: { runs: [{ text: "First Video" }] },
                },
              },
            },
          },
          {
            richItemRenderer: {
              content: {
                videoRenderer: {
                  videoId: "video-2",
                  title: { runs: [{ text: "Second Video" }] },
                },
              },
            },
          },
        ],
      };

      return new Response(
        `<!doctype html><html><head><title>Example Channel - YouTube</title></head><body><script>var ytInitialData = ${JSON.stringify(initialData)};</script></body></html>`,
        {
          status: 200,
          statusText: "OK",
          headers: {
            "content-type": "text/html",
          },
        },
      );
    }

    if (url === "https://www.youtube.com/watch?v=video-1&hl=en") {
      return new Response(
        '<meta itemprop="datePublished" content="2026-04-12T10:00:00-07:00">',
        { status: 200, statusText: "OK" },
      );
    }

    if (url === "https://www.youtube.com/watch?v=video-2&hl=en") {
      return new Response(
        '<meta itemprop="datePublished" content="2026-04-10T09:00:00-07:00">',
        { status: 200, statusText: "OK" },
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const parsed = await fetchChannelFeed("UC123");

  assert.equal(parsed.channelTitle, "Example Channel");
  assert.deepEqual(parsed.videos, [
    {
      videoId: "video-1",
      title: "First Video",
      videoUrl: "https://www.youtube.com/watch?v=video-1",
      publishedAt: "2026-04-12T10:00:00-07:00",
    },
    {
      videoId: "video-2",
      title: "Second Video",
      videoUrl: "https://www.youtube.com/watch?v=video-2",
      publishedAt: "2026-04-10T09:00:00-07:00",
    },
  ]);
  assert.equal(parsed.source, "channel-videos-fallback");
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://www.youtube.com/feeds/videos.xml?channel_id=UC123",
      "https://www.youtube.com/channel/UC123/videos?view=0&sort=dd&flow=grid&hl=en",
      "https://www.youtube.com/watch?v=video-1&hl=en",
      "https://www.youtube.com/watch?v=video-2&hl=en",
    ],
  );
  assert.equal(calls[0].headers["accept-language"], "en-US,en;q=0.9");
});
