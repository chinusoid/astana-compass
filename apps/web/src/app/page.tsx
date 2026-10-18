import CompassApp from "@/components/compass-app";
import { astanaInputDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export default function Home() {
  return (
    <CompassApp
      initialStart={astanaInputDate(new Date())}
      allowFixtures={process.env.ASTANA_ALLOW_FIXTURES === "true"}
      mapProvider={process.env.ASTANA_MAP_PROVIDER === "none" ? "none" : "osm"}
    />
  );
}
