
import fs from "node:fs";
import { TikTok } from "tca-js";

async function main() {
    let api;

    try {
        // 1. Đọc cấu hình
        console.log("Đang đọc config.json...");

        if (!fs.existsSync("./config.json")) {
            throw new Error("Không tìm thấy file config.json");
        }

        const config = JSON.parse(
            fs.readFileSync("./config.json", "utf8")
        );

        if (
            !config.TIKTOK_COOKIES ||
            config.TIKTOK_COOKIES === "COOKIE_CUA_BAN"
        ) {
            throw new Error("Chưa cấu hình TIKTOK_COOKIES");
        }

        // 2. Đăng nhập TikTok
        console.log("Đang đăng nhập TikTok...");

        const tiktok = new TikTok();

        api = await tiktok.login({
            cookies: config.TIKTOK_COOKIES
        });

        if (!api) {
            throw new Error("Đăng nhập không trả về API.");
        }

        console.log("Đăng nhập thành công!");

        // 3. Liệt kê API methods
        console.log("\n=== TIKTOK API METHODS ===");

        const methods = new Set();
        let obj = api;

        while (obj && obj !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(obj)) {
                if (name !== "constructor") {
                    methods.add(name);
                }
            }

            obj = Object.getPrototypeOf(obj);
        }

        console.log([...methods].sort().join("\n"));

        // 4. Lấy ID tài khoản
        console.log("\n=== TIKTOK ACCOUNT ID ===");

        if (typeof api.getOwnId === "function") {
            try {
                const ownId = await api.getOwnId();
                console.log("Own ID:", ownId);
            } catch (error) {
                console.log("Không lấy được ID:", error.message);
            }
        } else {
            console.log("API không có getOwnId().");
        }

        // 5. Liệt kê Listener methods
        console.log("\n=== LISTENER METHODS ===");

        const listener = api.listener;

        if (listener) {
            const listenerMethods = new Set();
            let current = listener;

            while (
                current &&
                current !== Object.prototype
            ) {
                for (
                    const name of Object.getOwnPropertyNames(current)
                ) {
                    if (name !== "constructor") {
                        listenerMethods.add(name);
                    }
                }

                current = Object.getPrototypeOf(current);
            }

            console.log(
                [...listenerMethods].sort().join("\n")
            );
        } else {
            console.log("Không tìm thấy listener.");
        }

        console.log("\n=== KIỂM TRA HOÀN TẤT ===");

    } catch (error) {
        console.error("\n[ERROR]", error.message);
    }
}

main();
