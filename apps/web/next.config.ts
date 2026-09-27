import type { NextConfig } from "next";
const isProduction = process.env.NODE_ENV === "production";
const securityHeaders = [
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    ...(isProduction ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
];
const nextConfig: NextConfig = {
    output: "standalone",
    poweredByHeader: false,
    reactStrictMode: true,
    experimental: { useTypeScriptCli: false },
    async headers() {
        return [
            { source: "/(.*)", headers: securityHeaders },
            { source: "/geometry/counties/:path*.json", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
        ];
    },
};
export default nextConfig;
