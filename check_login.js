
import { TikTok } from "tca-js";

const tiktok = new TikTok();

console.log("=== LOGIN FUNCTION ===");
console.log(tiktok.login.toString());

console.log("\n=== COOKIE METHODS ===");
console.log(
    Object.getOwnPropertyNames(Object.getPrototypeOf(tiktok))
);
