
import fs from "node:fs";
import { TikTok } from "tca-js";

async function main() {
    const config = JSON.parse(
        fs.readFileSync("./config.json", "utf8")
    );

    const tiktok = new TikTok();

    const api = await tiktok.login({
        cookies: config.TIKTOK_COOKIES
    });

    if (!api?.listener) {
        throw new Error("Không tìm thấy TikTok listener.");
    }

    console.log("Đã kết nối. Hãy nhờ người khác gửi:");
    console.log("1. Một nhãn dán TikTok.");
    console.log("2. Một video TikTok qua tin nhắn.");

    api.listener.on("message", (message) => {
        console.log("\n========== TIN NHẮN MỚI ==========");

        console.dir(message, {
            depth: 8,
            colors: false,
            maxArrayLength: 30
        });

        console.log("========== KẾT THÚC ==========\n");
    });

    await api.listener.start();
}

main().catch(error => {
    console.error("[ERROR]", error.message);
});
