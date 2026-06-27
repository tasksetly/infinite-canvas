/**
 * 提示词库全量同步脚本
 * 从 GitHub 仓库抓取提示词数据和图片，图片上传到 Cloudflare R2
 *
 * 使用方法：
 * 1. 在 .env 文件中配置 R2 相关环境变量
 * 2. 运行: node scripts/sync-prompts.mjs
 *
 * 特性：
 * - 增量同步：已上传的图片会跳过
 * - 多线程上传：并发上传图片，速度更快
 * - 保存提示词数据到 data/prompts.json
 */

import { config } from "dotenv";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载 .env
config({ path: join(__dirname, "..", ".env") });

// 配置
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");
const IMAGE_PREFIX = "images/prompts";
const CONCURRENCY = 5; // 并发上传数
const DELAY_MS = 50; // 每批之间的延迟

// GitHub 数据源（与 route.ts 保持一致）
const GITHUB_SOURCES = [
    {
        category: "gpt-image-2-prompts",
        githubUrl: "https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts",
        baseUrl: "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts/main",
        files: ["data/ingested_tweets.json", "README.md", "cases/ad-creative.md", "cases/character.md", "cases/comparison.md", "cases/ecommerce.md", "cases/portrait.md", "cases/poster.md", "cases/ui.md"],
        build: buildGptImage2Prompts,
    },
    {
        category: "awesome-gpt-image",
        githubUrl: "https://github.com/ZeroLu/awesome-gpt-image",
        baseUrl: "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main",
        files: ["README.zh-CN.md"],
        build: buildAwesomeGptImagePrompts,
    },
    {
        category: "awesome-gpt4o-image-prompts",
        githubUrl: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts",
        baseUrl: "https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main",
        files: ["README.zh-CN.md"],
        build: buildAwesomeGpt4oImagePrompts,
    },
    {
        category: "youmind-gpt-image-2",
        githubUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
        baseUrl: "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main",
        files: ["README_zh.md"],
        build: () => buildYouMindPrompts("https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main", "youmind-gpt-image-2", "gpt-image-2"),
    },
    {
        category: "youmind-nano-banana-pro",
        githubUrl: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts",
        baseUrl: "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main",
        files: ["README_zh.md"],
        build: () => buildYouMindPrompts("https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main", "youmind-nano-banana-pro", "nano-banana-pro"),
    },
    {
        category: "davidwu-gpt-image2-prompts",
        githubUrl: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts",
        baseUrl: "https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main",
        files: ["prompts.json"],
        build: buildDavidWuGptImage2Prompts,
    },
];

// R2 客户端
const r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// 路径
const dataDir = join(__dirname, "..", "data");
const imageMapPath = join(dataDir, "prompt-images-map.json");
const promptsJsonPath = join(dataDir, "prompts.json");

let imageMap = {};

// ========== 网络请求 ==========

async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${url} (${response.status})`);
    return response.text();
}

async function fetchJson(url) {
    return JSON.parse(await fetchText(url));
}

async function downloadImage(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
        return Buffer.from(await response.arrayBuffer());
    } finally {
        clearTimeout(timeout);
    }
}

// ========== R2 上传 ==========

async function uploadToR2(key, buffer, contentType) {
    await r2Client.send(
        new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: `${IMAGE_PREFIX}/${key}`,
            Body: buffer,
            ContentType: contentType || "image/jpeg",
            CacheControl: "public, max-age=31536000",
        })
    );
}

function getImageExt(url) {
    const match = url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i);
    return match ? match[1].toLowerCase() : "jpg";
}

function r2KeyFromUrl(sourceName, imageUrl) {
    const ext = getImageExt(imageUrl);
    const sanitized = imageUrl.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
    return `${sourceName}/${sanitized}.${ext}`;
}

function r2PublicUrl(r2Key) {
    return `${R2_PUBLIC_URL}/${IMAGE_PREFIX}/${r2Key}`;
}

// ========== 并发上传 ==========

async function uploadBatch(images) {
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    // 分批处理
    for (let i = 0; i < images.length; i += CONCURRENCY) {
        const batch = images.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
            batch.map(async (img) => {
                if (imageMap[img.originalUrl]) {
                    return "skip";
                }
                const key = r2KeyFromUrl(img.sourceName, img.originalUrl);
                const buffer = await downloadImage(img.fullUrl);
                const ext = getImageExt(img.fullUrl);
                await uploadToR2(key, buffer, `image/${ext === "jpg" ? "jpeg" : ext}`);
                imageMap[img.originalUrl] = r2PublicUrl(key);
                return "upload";
            })
        );

        for (const r of results) {
            if (r.status === "fulfilled") {
                if (r.value === "upload") uploaded++;
                else skipped++;
            } else {
                failed++;
                console.error(`    ❌ ${r.reason?.message || r.reason}`);
            }
        }

        // 进度
        const done = Math.min(i + CONCURRENCY, images.length);
        process.stdout.write(`\r  📸 进度: ${done}/${images.length} (上传: ${uploaded}, 跳过: ${skipped}, 失败: ${failed})`);

        if (i + CONCURRENCY < images.length) {
            await sleep(DELAY_MS);
        }
    }
    console.log(); // 换行
    return { uploaded, skipped, failed };
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ========== Markdown 解析工具 ==========

function splitBeforeHeading(markdown, prefix) {
    const blocks = [];
    let current = [];
    for (const line of markdown.split("\n")) {
        if (line.startsWith(prefix) && current.length) {
            blocks.push(current.join("\n"));
            current = [];
        }
        current.push(line);
    }
    blocks.push(current.join("\n"));
    return blocks;
}

function firstMatch(value, pattern) {
    return pattern.exec(value)?.[1] || "";
}

function absoluteImage(baseUrl, image) {
    if (!image) return "";
    if (/^https?:\/\//i.test(image)) return image;
    return `${baseUrl}/${image.replace(/^\.?\//, "")}`;
}

function extractMarkdownImages(baseUrl, markdown) {
    return Array.from(markdown.matchAll(/!\[[^\]]*]\(([^)]+)\)/g), (match) => absoluteImage(baseUrl, match[1])).filter(Boolean);
}

function tagsFromCategory(category) {
    return category
        .replace(/\s+Cases$/i, "")
        .split(/\s*(?:&|and)\s*/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
}

function tagsFromHeading(heading) {
    return heading
        .replace(/[^\p{L}\p{N}/&、与 ]/gu, "")
        .split(/\s*(?:\/|&|、|与)\s*/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
}

function youMindTags(title, modelTag) {
    const [, prefix] = title.match(/^(.+?) - /) || [];
    return [modelTag, ...tagsFromHeading(prefix || "")];
}

function davidWuTags(item) {
    const tags = [item.category_cn, item.category, item.author, item.source]
        .filter(Boolean)
        .join("/")
        .split("/")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    if (item.needs_ref) tags.push("需要参考图");
    return tags;
}

function markdownPreview(images) {
    return images.filter(Boolean).map((image) => `![](${image})`).join("\n\n");
}

function leftPad(value) {
    return String(value).padStart(4, "0");
}

function defaultPrompt(id, title, prompt, coverUrl, tags, preview) {
    return { id, title, coverUrl, prompt, tags, preview, createdAt: "", updatedAt: "" };
}

// ========== 各数据源构建函数 ==========

async function buildGptImage2Prompts(source) {
    const data = (await fetchJson(`${source.baseUrl}/data/ingested_tweets.json`)).records || [];
    const cases = new Map();
    const caseFiles = ["README.md", "cases/ad-creative.md", "cases/character.md", "cases/comparison.md", "cases/ecommerce.md", "cases/portrait.md", "cases/poster.md", "cases/ui.md"];
    const markdowns = await Promise.all(caseFiles.map((f) => fetchText(`${source.baseUrl}/${f}`)));
    for (const md of markdowns) {
        for (const m of md.matchAll(/### Case \d+: \[[^\]]+]\(([^)]+)\).*?\*\*Prompt:\*\*\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/gs)) {
            cases.set(m[1], m[2].trim());
        }
    }

    const items = [];
    for (const item of data) {
        const prompt = cases.get(item.tweet_url || "");
        if (!item.title || !prompt || !item.image_dir) continue;
        const image = `${source.baseUrl}/${item.image_dir}/output.jpg`;
        items.push({
            id: `gpt-image-2-prompts-${leftPad(items.length + 1)}`,
            title: item.title,
            coverUrl: image,
            prompt,
            tags: tagsFromCategory(item.category || ""),
            preview: markdownPreview([image]),
            createdAt: item.added_at || "",
            updatedAt: item.added_at || "",
        });
    }
    return items;
}

async function buildAwesomeGptImagePrompts(source) {
    const markdown = await fetchText(`${source.baseUrl}/README.zh-CN.md`);
    const items = [];
    for (const section of splitBeforeHeading(markdown, "## ")) {
        const tags = tagsFromHeading(firstMatch(section, /^##\s+(.+)$/m));
        for (const block of splitBeforeHeading(section, "### ")) {
            const title = firstMatch(block, /^###\s+(.+)$/m).replace(/\[([^\]]+)]\([^)]+\)/g, "$1").trim();
            const prompt = firstMatch(block, /\*\*提示词:\*\*\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/s).trim();
            if (!title || !prompt) continue;
            const images = extractMarkdownImages(source.baseUrl, block);
            items.push(defaultPrompt(`awesome-gpt-image-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", tags, markdownPreview(images)));
        }
    }
    return items;
}

async function buildAwesomeGpt4oImagePrompts(source) {
    const markdown = await fetchText(`${source.baseUrl}/README.zh-CN.md`);
    const items = [];
    for (const block of splitBeforeHeading(markdown, "### ")) {
        const title = firstMatch(block, /^###\s+(.+)$/m).trim();
        const prompt = firstMatch(block, /- \*\*提示词文本：\*\*\s*`(.*?)`/s).trim();
        if (!title || !prompt) continue;
        const images = extractMarkdownImages(source.baseUrl, block);
        items.push(defaultPrompt(`awesome-gpt4o-image-prompts-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", ["gpt4o"], markdownPreview(images)));
    }
    return items;
}

async function buildYouMindPrompts(baseUrl, idPrefix, modelTag) {
    const markdown = await fetchText(`${baseUrl}/README_zh.md`);
    const items = [];
    for (const block of splitBeforeHeading(markdown, "### ")) {
        const title = firstMatch(block, /^###\s+No\.\s*\d+:\s*(.+)$/m).trim();
        const prompt = firstMatch(block, /#### .*?提示词\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/s).trim();
        if (!title || !prompt) continue;
        const images = extractMarkdownImages(baseUrl, block);
        items.push(defaultPrompt(`${idPrefix}-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", youMindTags(title, modelTag), markdownPreview(images)));
    }
    return items;
}

async function buildDavidWuGptImage2Prompts(source) {
    const data = await fetchJson(`${source.baseUrl}/prompts.json`);
    return data
        .map((item, index) => {
            const title = (item.title_cn || item.title_en || "").trim();
            const prompt = (item.prompt || "").trim();
            if (!title || !prompt) return null;
            const image = absoluteImage(source.baseUrl, item.image || "");
            const preview = [item.title_en, item.note, image ? `![](${image})` : ""].filter(Boolean).join("\n\n");
            return defaultPrompt(`davidwu-gpt-image2-prompts-${leftPad(item.id || index + 1)}`, title, prompt, image, davidWuTags(item), preview);
        })
        .filter(Boolean);
}

// ========== 主流程 ==========

async function syncSource(source) {
    console.log(`\n📦 ${source.category}`);
    console.log(`  🔗 ${source.githubUrl}`);

    // 1. 构建提示词数据
    let items;
    try {
        items = await source.build(source);
        console.log(`  📝 提取到 ${items.length} 条提示词`);
    } catch (err) {
        console.error(`  ❌ 提取失败: ${err.message}`);
        return [];
    }

    // 2. 收集需要上传的图片
    const allImages = new Map();
    for (const item of items) {
        // coverUrl
        if (item.coverUrl && !item.coverUrl.startsWith("http")) {
            item.coverUrl = `${source.baseUrl}/${item.coverUrl.replace(/^\.?\//, "")}`;
        }
        if (item.coverUrl) {
            allImages.set(item.coverUrl, item.coverUrl);
        }
        // preview 中的图片
        const previewImages = (item.preview || "").matchAll(/!\[[^\]]*\]\(([^)]+)\)/g);
        for (const m of previewImages) {
            let url = m[1];
            if (!url.startsWith("http")) {
                url = `${source.baseUrl}/${url.replace(/^\.?\//, "")}`;
            }
            allImages.set(url, url);
        }
    }

    const uniqueImages = [...allImages.values()];
    console.log(`  🖼️  需要处理 ${uniqueImages.length} 张图片`);

    // 3. 过滤已上传的
    const toUpload = uniqueImages.filter((url) => !imageMap[url]);
    console.log(`  ⬆️  待上传 ${toUpload.length} 张 (已缓存 ${uniqueImages.length - toUpload.length} 张)`);

    // 4. 多线程上传
    if (toUpload.length > 0) {
        const images = toUpload.map((url) => ({
            originalUrl: url,
            fullUrl: url,
            sourceName: source.category,
        }));
        const result = await uploadBatch(images);
        console.log(`  ✅ 上传完成: 新增 ${result.uploaded}, 跳过 ${result.skipped}, 失败 ${result.failed}`);
    }

    // 5. 替换图片 URL 为 R2 地址
    for (const item of items) {
        if (item.coverUrl && imageMap[item.coverUrl]) {
            item.coverUrl = imageMap[item.coverUrl];
        }
        // 替换 preview 中的图片
        if (item.preview) {
            item.preview = item.preview.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (match, url) => {
                return imageMap[url] ? match.replace(url, imageMap[url]) : match;
            });
        }
    }

    return items.map((item) => ({ ...item, category: source.category, githubUrl: source.githubUrl }));
}

async function main() {
    if (!R2_BUCKET || !R2_PUBLIC_URL || !process.env.R2_ACCOUNT_ID) {
        console.error("❌ 请先配置 .env 文件中的 R2 相关环境变量");
        console.error("   需要: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL");
        process.exit(1);
    }

    console.log("🚀 提示词库全量同步");
    console.log(`📁 Bucket: ${R2_BUCKET}`);
    console.log(`🌐 Public URL: ${R2_PUBLIC_URL}`);
    console.log(`⚡ 并发数: ${CONCURRENCY}`);

    // 确保 data 目录存在
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    // 加载已有的映射
    if (existsSync(imageMapPath)) {
        imageMap = JSON.parse(readFileSync(imageMapPath, "utf-8"));
        console.log(`\n📋 已有 ${Object.keys(imageMap).length} 条图片映射`);
    }

    // 同步每个数据源
    const allPrompts = [];
    for (const source of GITHUB_SOURCES) {
        try {
            const items = await syncSource(source);
            allPrompts.push(...items);
            // 每个源完成后增量保存
            writeFileSync(imageMapPath, JSON.stringify(imageMap, null, 2));
            writeFileSync(promptsJsonPath, JSON.stringify(allPrompts, null, 2));
        } catch (err) {
            console.error(`\n❌ ${source.category} 同步失败: ${err.message}`);
        }
    }

    console.log(`\n📝 提示词数据已保存: ${promptsJsonPath} (${allPrompts.length} 条)`);
    console.log(`📋 图片映射已保存: ${imageMapPath} (${Object.keys(imageMap).length} 条)`);

    // 统计
    const categories = {};
    for (const p of allPrompts) {
        categories[p.category] = (categories[p.category] || 0) + 1;
    }
    console.log("\n📊 分类统计:");
    for (const [cat, count] of Object.entries(categories)) {
        console.log(`  ${cat}: ${count}`);
    }

    console.log("\n✅ 同步完成！");
}

main().catch((err) => {
    console.error("❌ 同步失败:", err);
    process.exit(1);
});
