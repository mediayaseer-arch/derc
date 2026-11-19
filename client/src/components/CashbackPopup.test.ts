import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const componentSource = readFileSync(new URL("./CashbackPopup.tsx", import.meta.url), "utf8");
const checkoutSource = readFileSync(new URL("../pages/checkout.tsx", import.meta.url), "utf8");
const reserveSource = readFileSync(new URL("../pages/reserve.tsx", import.meta.url), "utf8");

describe("shared cashback payment popup", () => {
  it("provides the same close and continue controls used by both flows", () => {
    expect(componentSource).toContain('data-testid="cashback-popup"');
    expect(componentSource).toContain('data-testid="button-close-popup"');
    expect(componentSource).toContain('data-testid="button-continue-popup"');
    expect(componentSource).toContain("عرض كاش باك 40%");
  });

  it("is used by checkout and reservation payment pages", () => {
    expect(checkoutSource).toContain('import { CashbackPopup } from "@/components/CashbackPopup"');
    expect(checkoutSource).toContain("<CashbackPopup onClose={() => setShowPopup(false)} />");
    expect(reserveSource).toContain('import { CashbackPopup } from "@/components/CashbackPopup"');
    expect(reserveSource).toContain("<CashbackPopup onClose={() => setShowCashbackPopup(false)} />");
  });

  it("keeps the checkout and reservation cashback footer copy identical", () => {
    const footerCopy = "احصل على كاش باك يصل الى 40% عند الدفع من خلال البطاقات من فئة البلاتينية";
    expect(checkoutSource).toContain(footerCopy);
    expect(reserveSource).toContain(footerCopy);
  });
});
