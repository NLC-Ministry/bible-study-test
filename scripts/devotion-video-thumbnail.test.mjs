import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const plan = readFileSync("js/modules/plan.js", "utf8");
const css = readFileSync("index.css", "utf8");
const iconManifest = JSON.parse(readFileSync("js/design/icon-manifest.json", "utf8"));

// 靈修影片：使用者明確要求「只做預覽」——縮圖用 YouTube 自家公開的縮圖 CDN
// 現拼現算（img.youtube.com/vi/<id>/...），不呼叫任何 API、不用金鑰。點下去
// 完全是一般外部連結行為（開瀏覽器或喚起 YouTube App 播放），絕對不能內嵌
// iframe/播放器。
describe("devotion video: thumbnail preview only, playback stays external", () => {
  it("extractYoutubeVideoId parses watch/shorts/embed/youtu.be URLs without any network call", () => {
    const idx = plan.indexOf("function extractYoutubeVideoId(url)");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, idx + 700);
    expect(body).toContain('host === "youtu.be"');
    expect(body).toContain('u.pathname === "/watch"');
    expect(body).toContain("u.searchParams.get(\"v\")");
    expect(body).toContain("shorts|embed|live");
    expect(body).not.toContain("fetch(");
  });

  it("builds the thumbnail URL from YouTube's public thumbnail CDN, with no id meaning no thumbnail", () => {
    const idx = plan.indexOf("const devotionVideoId =");
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, idx + 300);
    expect(body).toContain("extractYoutubeVideoId(cur.videoUrl)");
    expect(body).toContain("https://img.youtube.com/vi/${devotionVideoId}/hqdefault.jpg");
  });

  it("the video link is still a plain external <a target=_blank> — no iframe, no embedded player", () => {
    const idx = plan.indexOf('<a class="devotion-video-link"');
    expect(idx).toBeGreaterThan(-1);
    const body = plan.slice(idx, idx + 800);
    expect(body).toContain('target="_blank"');
    expect(body).toContain('rel="noopener noreferrer"');
    expect(body).toContain("href=\"${escapeHTML(cur.videoUrl)}\"");
    expect(body).toContain("devotion-video-link__thumb-wrap");
    expect(body).toContain('data-icon="circlePlay"');
    expect(body).not.toContain("<iframe");
  });

  it("declares the circlePlay icon and styles the thumbnail/play overlay without an inline video player", () => {
    expect(iconManifest.circlePlay).toBe("CirclePlay");
    expect(css).toContain(".devotion-video-link__thumb-wrap");
    expect(css).toContain(".devotion-video-link__play");
    expect(css).not.toContain("devotion-video-link iframe");
  });
});
