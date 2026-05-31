import Link from "next/link";

export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 640 }}>
      <h1>superlog-sample</h1>
      <p>Trigger API routes to generate telemetry.</p>
      <ul>
        <li>
          <Link href="/api/healthy">GET /api/healthy</Link>
        </li>
        <li>
          <Link href="/api/broken">GET /api/broken (throws)</Link>
        </li>
      </ul>
    </main>
  );
}
