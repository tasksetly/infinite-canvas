/**
 * 提示词库图片同步脚本
 * 从 GitHub 仓库抓取图片并上传到 Cloudflare R2
 *
 * 使用方法：
 * 1. 在 .env 文件中配置 R2 相关环境变量
 * 2. 运行: node scripts/sync-prompts-images.mjs
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 配置
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");
const IMAGE_PREFIX = "images/prompts";

// GitHub 数据源（与 route.ts 保持一致）
const GITHUB_SOURCES = [
    {
        name: "gpt-image-2-prompts",
        baseUrl: "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts/main",
        files: ["data/ingested_tweets.json"],
        parseImages: (data) => {
            const records = data?.records || [];
            return records
                .filter((r) => r.image_dir)
                .map((r) => ({ url: `${r.image_dir}/output.jpg`, key: r.tweet_url }));
        },
    },
    {
        name: "awesome-gpt-image",
        baseUrl: "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main",
        files: ["README.zh-CN.md"],
        parseImages: (markdown) => {
            return [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
                .map((m) => m[1])
                .filter((url) => !url.startsWith("http"))
                .map((url) => ({ url, key: url }));
        },
    },
    {
        name: "awesome-gpt4o-image-prompts",
        baseUrl: "https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main",
        files: ["README.zh-CN.md"],
        parseImages: (markdown) => {
            return [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
                .map((m) => m[1])
                .filter((url) => !url.startsWith("http"))
                .map((url) => ({ url, key: url }));
        },
    },
    {
        name: "youmind-gpt-image-2",
        baseUrl: "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main",
        files: ["README_zh.md"],
        parseImages: (markdown) => {
            return [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
                .map((m) => m[1])
                .filter((url) => !url.startsWith("http"))
                .map((url) => ({ url, key: url }));
        },
    },
    {
        name: "youmind-nano-banana-pro",
        baseUrl: "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main",
        files: ["README_zh.md"],
        parseImages: (markdown) => {
            return [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
                .map((m) => m[1])
                .filter((url) => !url.startsWith("http"))
                .map((url) => ({ url, key: url }));
        },
    },
    {
        name: "davidwu-gpt-image2-prompts",
        baseUrl: "https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main",
        files: ["prompts.json"],
        parseImages: (data) => {
            return data
                .filter((item) => item.image)
                .map((item) => ({ url: item.image, key: item.image }));
        },
    },
];

// 初始化 R2 客户端
const r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// 图片映射缓存
const imageMapPath = join(__dirname, "..", "data", "prompt-images-map.json");
let imageMap = {};

async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${url}`);
    return response.text();
}

async function fetchJson(url) {
    const text = await fetchText(url);
    return JSON.parse(text);
}

async function downloadImage(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${url}`);
    return Buffer.from(await response.arrayBuffer());
}

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

async function getImageExtension(url) {
    const match = url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i);
    return match ? match[1].toLowerCase() : "jpg";
}

async function syncSource(source) {
    console.log(`\n📦 Processing: ${source.name}`);
    let allImages = [];

    for (const file of source.files) {
        try {
            const url = `${source.baseUrl}/${file}`;
            console.log(`  📄 Fetching: ${file}`);

            let content;
            if (file.endsWith(".json")) {
                const data = await fetchJson(url);
                const images = source.parseImages(data);
                allImages.push(...images);
            } else {
                const markdown = await fetchText(url);
                const images = source.parseImages(markdown);
                allImages.push(...images);
            }
        } catch (error) {
            console.error(`  ❌ Error processing ${file}:`, error.message);
        }
    }

    // 去重
    const uniqueImages = [...new Map(allImages.map((img) => [img.key, img])).values()];
    console.log(`  📸 Found ${uniqueImages.length} images`);

    let uploaded = 0;
    let skipped = 0;

    for (const image of uniqueImages) {
        try {
            const fullUrl = image.url.startsWith("http")
                ? image.url
                : `${source.baseUrl}/${image.url.replace(/^\.\//, "")}`;

            // 检查是否已上传
            const ext = await getImageExtension(fullUrl);
            const r2Key = `${source.name}/${image.key.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_")}.${ext}`;

            if (imageMap[fullUrl]) {
                skipped++;
                continue;
            }

            console.log(`  ⬆️  Uploading: ${r2Key}`);
            const buffer = await downloadImage(fullUrl);
            await uploadToR2(r2Key, buffer, `image/${ext === "jpg" ? "jpeg" : ext}`);

            imageMap[fullUrl] = `${R2_PUBLIC_URL}/${IMAGE_PREFIX}/${r2Key}`;
            uploaded++;

            // 避免请求过快
            await new Promise((r) => setTimeout(r, 100));
        } catch (error) {
            console.error(`  ❌ Error uploading ${image.key}:`, error.message);
        }
    }

    console.log(`  ✅ Uploaded: ${uploaded}, Skipped: ${skipped}`);
}

async function main() {
    if (!R2_BUCKET || !R2_PUBLIC_URL || !process.env.R2_ACCOUNT_ID) {
        console.error("❌ 请先配置 .env 文件中的 R2 相关环境变量");
        process.exit(1);
    }

    console.log("🚀 开始同步提示词库图片到 R2\n");
    console.log(`📁 Bucket: ${R2_BUCKET}`);
    console.log(`🌐 Public URL: ${R2_PUBLIC_URL}`);

    // 加载已有的映射
    if (existsSync(imageMapPath)) {
        imageMap = JSON.parse(readFileSync(imageMapPath, "utf-8"));
        console.log(`📋 Loaded ${Object.keys(imageMap).length} existing mappings`);
    }

    // 确保 data 目录存在
    const dataDir = join(__dirname, "..", "data");
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    // 同步每个数据源
    for (const source of GITHUB_SOURCES) {
        await syncSource(source);
    }

    // 保存映射
    writeFileSync(imageMapPath, JSON.stringify(imageMap, null, 2));
    console.log(`\n✅ 同步完成！共 ${Object.keys(imageMap).length} 张图片`);
    console.log(`📋 映射文件已保存到: ${imageMapPath}`);
}

main().catch(console.error);
