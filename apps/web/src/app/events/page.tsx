import EventsPanel from "@/components/events-panel";
import { astanaInputDate } from "@/lib/format";

export const metadata = { title: "События — Astana Compass" };
export default function EventsPage() {
  const start = new Date();
  return (
    <EventsPanel
      initialStart={astanaInputDate(start)}
      initialEnd={astanaInputDate(new Date(start.getTime() + 3600000))}
    />
  );
}
