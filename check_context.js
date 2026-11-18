import { TikTok } from "tca-js";

const tiktok = new TikTok();

const loginSource = tiktok.login.toString();
console.log("=== LOGIN SOURCE ===");
console.log(loginSource);

console.log("\n=== CONTEXT SOURCE ===");

const match = loginSource.match(/new Context/);
console.log("Có sử dụng Context:", Boolean(match));