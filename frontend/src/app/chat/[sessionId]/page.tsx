import { ClientWorkspace } from "@/components/ClientWorkspace";

export default async function ChatSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <ClientWorkspace initialSessionId={decodeURIComponent(sessionId)} />;
}
