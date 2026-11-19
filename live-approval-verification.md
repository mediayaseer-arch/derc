# Live Approval and Page-Control Verification

Source: authenticated preview at https://3000-inev3fg29m9i9s85s0wfb-ae476915.sg1.manus.computer/dashboard

On 2026-08-20, the selected restaurant visitor initially displayed `reserve_date · الموعد` at `1/6`. Clicking the dashboard card-level `دفع إلى OTP` control after the flow-aware payload fix changed the dashboard to `reserve_otp · رمز التحقق` at `5/6`. The dashboard showed the OTP control section and the selected visitor record reflected the updated step. This confirms the card-level Push to OTP action now persists the restaurant-specific `currentPage`, `step`, and `directedStep` together.

The earlier live click before the fix incorrectly produced `reserve_checkout · الدفع` at `4/6`, which identified the missing shared page-control payload mapping.

## Card Accept Verification

After the authenticated dashboard Accept action was clicked on the selected restaurant visitor, the dashboard showed `status=approved` but the visitor remained at `reserve_date · الموعد` (`1/6`) and the approval area displayed `بانتظار التأكيد` (waiting for confirmation). This indicates the live approval write itself is reaching the record, but the card approval path still does not advance this restaurant visitor to the expected OTP destination. The Push to OTP path is separately verified to reach `reserve_otp · رمز التحقق` (`5/6`).
