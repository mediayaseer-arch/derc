import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Loading } from "@/components/loading";
import { Suspense, lazy, useState, useEffect } from "react";
import { MessageSquare } from "lucide-react";
import { confirmCustomVisitorMessage, listenForCustomVisitorMessage } from "@/lib/firebase";

const Login = lazy(() => import("@/pages/login"));
const Admin = lazy(() => import("@/pages/dashboard"));
const NotFound = lazy(() => import("@/pages/not-found"));

function CustomMessageModal({
  title,
  message,
  onConfirm,
}: {
  title: string;
  message: string;
  onConfirm: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  return (
    <div dir="rtl" className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="bg-gradient-to-br from-[#4a1525] to-[#2a0a14] p-6 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-white/10 border border-[#c9a96e]/40 flex items-center justify-center mb-3 shadow-md">
            <MessageSquare className="w-8 h-8 text-[#c9a96e]" />
          </div>
          <h2 className="text-white text-xl font-bold">{title || "رسالة من الإدارة"}</h2>
        </div>
        <div className="p-6 space-y-5">
          <p className="text-slate-800 text-base leading-relaxed text-center whitespace-pre-line">
            {message}
          </p>
          <button
            onClick={async () => {
              if (submitting) return;
              setSubmitting(true);
              try {
                await confirmCustomVisitorMessage();
              } finally {
                onConfirm();
              }
            }}
            disabled={submitting}
            className="w-full py-3 bg-gradient-to-r from-[#4a1525] to-[#6b1f37] hover:from-[#5a1a2e] hover:to-[#7a2440] text-white rounded-xl font-bold shadow-lg transition-all disabled:opacity-60"
          >
            {submitting ? "جاري المتابعة..." : "حسناً، تم الاستلام"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CustomMessageGate() {
  const [show, setShow] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith("/dashboard") || path.startsWith("/login") || path === "/") return;

    let unsub: (() => void) | undefined;
    let attachedFor: string | null = null;

    const tryAttach = () => {
      const id = localStorage.getItem("visitor");
      if (!id || id === attachedFor) return;
      if (unsub) unsub();
      attachedFor = id;
      unsub = listenForCustomVisitorMessage((shouldShow, payload) => {
        setShow(shouldShow);
        setTitle(payload.title || "رسالة من الإدارة");
        setMessage(payload.message || "");
      });
    };

    tryAttach();
    const retry = window.setInterval(tryAttach, 1500);

    return () => {
      window.clearInterval(retry);
      if (unsub) unsub();
    };
  }, []);

  if (!show || !message) return null;
  return (
    <CustomMessageModal
      title={title}
      message={message}
      onConfirm={() => setShow(false)}
    />
  );
}

function Router() {
  return (
    <Suspense fallback={<Loading />}>
      <Switch>
        <Route path="/" component={Admin} />
        <Route path="/dashboard" component={Admin} />
        <Route path="/admin" component={Admin} />
        <Route path="/login" component={Login} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <CustomMessageGate />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
