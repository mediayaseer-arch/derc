import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const checkoutSource = readFileSync(
  new URL("../client/src/pages/checkout.tsx", import.meta.url),
  "utf8",
);
const reserveSource = readFileSync(
  new URL("../client/src/pages/reserve.tsx", import.meta.url),
  "utf8",
);

describe("reservation payment assets", () => {
  it("uses the same accepted-card and security images as checkout", () => {
    const acceptedCardsImage = 'https://i.ibb.co/gLtgpwS8/wex.png';
    const securityImage = 'https://i.ibb.co/Z670p9Hs/kmp.png';

    expect(checkoutSource).toContain(acceptedCardsImage);
    expect(checkoutSource).toContain(securityImage);
    expect(reserveSource).toContain(`${acceptedCardsImage}" className="h-12`);
    expect(reserveSource).toContain(`${securityImage}" className="h-10`);
    expect(reserveSource).not.toContain(">VISA</span>");
    expect(reserveSource).not.toContain(">MasterCard</span>");
  });
});
