import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => mocks);
import Home from "@/app/page";
describe("home route", () => {
    it("redirects directly to the dashboard", () => {
        Home();
        expect(mocks.redirect).toHaveBeenCalledWith("/dashboard");
    });
});
