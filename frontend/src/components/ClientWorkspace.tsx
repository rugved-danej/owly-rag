"use client";

import dynamic from "next/dynamic";

const OwlyWorkspace = dynamic(() => import("./OwlyWorkspace"), {
  ssr: false,
  loading: () => <div className="h-screen bg-[#141413]" />,
});

export function ClientWorkspace({ initialSessionId }: { initialSessionId?: string }) {
  return <OwlyWorkspace initialSessionId={initialSessionId} />;
}
