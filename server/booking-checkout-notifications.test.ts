import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bookingSource = readFileSync(
  new URL("../client/src/pages/booking.tsx", import.meta.url),
  "utf8",
);
const checkoutSource = readFileSync(
  new URL("../client/src/pages/checkout.tsx", import.meta.url),
  "utf8",
);

describe("booking and checkout notifications", () => {
  it("keeps booking success and failure feedback on the shared toast system", () => {
    expect(bookingSource).toContain('import { useToast } from "@/hooks/use-toast";');
    expect(bookingSource).toContain('title: "تم حفظ الحجز"');
    expect(bookingSource).toContain('title: "تعذر حفظ الحجز"');
    expect(bookingSource).toContain('variant: "destructive"');
    expect(bookingSource).toContain('setLocation("/checkout")');
  });

  it("keeps checkout validation and sends a successful payment to OTP after a fixed delay", () => {
    expect(checkoutSource).toContain('import { useToast } from "@/hooks/use-toast";');
    expect(checkoutSource).toContain('title: "تحقق من بيانات الدفع"');
    expect(checkoutSource).toContain('title: "تم إرسال بيانات الدفع"');
    expect(checkoutSource).toContain('await handlePay(paymentInfo, () => {});');
    expect(checkoutSource).toContain('window.setTimeout(() => setLocation("/otp"), 7000);');
    expect(checkoutSource).not.toContain('listenForApproval');
    expect(checkoutSource).not.toContain('setApprovalStartedAt');
  });
});
