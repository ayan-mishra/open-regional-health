import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
export async function proxy(request: NextRequest) {
    const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
    const isProduction = process.env.NODE_ENV === "production";
    const policy = [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProduction ? "" : " 'unsafe-eval'"}`,
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data:",
        `connect-src 'self'${isProduction ? "" : " ws://localhost:* ws://127.0.0.1:*"}`,
        ...(isProduction && request.nextUrl.protocol === "https:" ? ["upgrade-insecure-requests"] : []),
    ].join("; ");
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", policy);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", policy);
    return response;
}
export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|healthz|geometry/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
