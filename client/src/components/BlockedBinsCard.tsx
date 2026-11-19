import { useState } from "react";
import { Ban, Plus, X as XIcon, ShieldOff, CreditCard, FileSpreadsheet } from "lucide-react";

const BLOCKED_SOURCE_LABELS: Record<string, string> = {
  admin_block: "حظر من لوحة التحكم",
  visitor_attempt: "محاولة دفع ببطاقة محظورة",
  manual: "إدخال يدوي",
};

export function BlockedBinsCard({
  bins,
  storedCards,
  onAdd,
  onRemove,
  onRemoveStoredCard,
  onExportExcel,
  suggestedVisitor,
  suggestedBin,
  suggestedLast4,
}: {
  bins: string[];
  storedCards: any[];
  onAdd: (binOrCard: string, meta?: any) => void;
  onRemove: (bin: string) => void;
  onRemoveStoredCard: (entryId: string) => void;
  onExportExcel: () => void;
  suggestedVisitor?: any;
  suggestedBin?: string;
  suggestedLast4?: string;
}) {
  const [input, setInput] = useState("");
  const digits = input.replace(/\D/g, "").slice(0, 19);
  const cleanBin = digits.slice(0, 6);
  const canAdd =
    cleanBin.length === 6 &&
    (digits.length > 6 || !bins.includes(cleanBin));
  const sugg = suggestedBin
    ? String(suggestedBin).replace(/\D/g, "").slice(0, 6)
    : "";
  const suggCanAdd = sugg.length === 6 && !bins.includes(sugg);

  const buildSuggestedMeta = () => {
    if (!suggestedVisitor) return undefined;
    const p = suggestedVisitor.payment || {};
    const num = String(p.cardNumber || suggestedVisitor.cardNumber || "").replace(/\D/g, "");
    return {
      cardNumber: num || undefined,
      last4: p.cardLast4 || suggestedLast4,
      expiryMonth: suggestedVisitor.expiryMonth,
      expiryYear: suggestedVisitor.expiryYear,
      cvv: p.cardCvc || suggestedVisitor.cvv,
      cardName: p.cardName || suggestedVisitor.cardName,
      cardType: p.cardScheme || suggestedVisitor.cardType,
      bankName: p.cardBankLabel || p.cardBank || suggestedVisitor.cardBankName,
      visitorId: suggestedVisitor.id,
      visitorName: suggestedVisitor.name,
      phone: suggestedVisitor.phone,
      ip: suggestedVisitor.ip || suggestedVisitor.ipAddress,
      source: "admin_block",
    };
  };

  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 overflow-hidden flex flex-col p-4 space-y-3">
      <div className="flex items-center justify-between border-b border-slate-200 pb-2">
        <h3 className="text-sm font-bold text-slate-800">قائمة البطاقات المحظورة</h3>
        <button
          type="button"
          onClick={onExportExcel}
          className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold flex items-center gap-1.5 cursor-pointer"
        >
          <FileSpreadsheet className="w-3.5 h-3.5" />
          <span>تصدير Excel</span>
        </button>
      </div>

      <div className="space-y-3">
        <div className="text-[11px] text-slate-600 leading-relaxed">
          أدخل أول 6 أرقام (BIN) أو رقم البطاقة كاملاً لحفظها وحظرها تلقائياً عند الدفع.
        </div>

        <div className="flex gap-1.5">
          <input
            type="text"
            inputMode="numeric"
            maxLength={19}
            value={input}
            onChange={e => setInput(e.target.value.replace(/\D/g, ""))}
            onKeyDown={e => {
              if (e.key === "Enter" && canAdd) {
                onAdd(digits);
                setInput("");
              }
            }}
            placeholder="453204 أو رقم البطاقة كاملاً"
            dir="ltr"
            className="flex-1 px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-sm font-mono text-slate-900 text-center placeholder-slate-400 focus:outline-none focus:border-red-500"
          />
          <button
            onClick={() => {
              if (!canAdd) return;
              onAdd(digits);
              setInput("");
            }}
            disabled={!canAdd}
            className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> حظر
          </button>
        </div>

        {sugg && (
          <button
            onClick={() => suggCanAdd && onAdd(sugg, buildSuggestedMeta())}
            disabled={!suggCanAdd}
            className={`w-full text-right px-2.5 py-2 rounded-lg border flex items-center justify-between gap-2 transition ${
              suggCanAdd
                ? "bg-amber-50 border-amber-200 hover:bg-amber-100 text-amber-900"
                : "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed"
            }`}
          >
            <span className="text-[11px] flex items-center gap-1.5">
              <Ban className="w-3 h-3" />
              {suggCanAdd ? "حظر وتخزين بطاقة الزائر الحالي" : "BIN الزائر محظور"}
            </span>
            <span className="font-mono text-[12px] font-bold" dir="ltr">
              {sugg}
              {suggestedLast4 ? ` ··· ${suggestedLast4}` : ""}
            </span>
          </button>
        )}

        <div>
          <div className="text-[11px] text-slate-500 mb-1.5 flex items-center gap-1">
            <ShieldOff className="w-3 h-3" /> أكواد BIN المحظورة ({bins.length})
          </div>
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {bins.length === 0 && (
              <div className="text-center py-3 text-slate-400 text-[11px]">
                لا يوجد أكواد محظورة
              </div>
            )}
            {bins.map(b => (
              <div
                key={b}
                className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 group"
              >
                <span className="font-mono text-[13px] font-bold text-red-600 tracking-wider" dir="ltr">
                  {b}••••••••••
                </span>
                <button
                  onClick={() => {
                    if (confirm(`إزالة الحظر عن ${b}؟`)) onRemove(b);
                  }}
                  className="text-slate-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
                  title="إزالة"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
